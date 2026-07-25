import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import type * as NodeFs from 'node:fs';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  parseBoundedPackageJsonSource,
  readBoundedPackageJsonFile,
  scanPackageSourceRoot,
} from '../../src/shared/package-metadata.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

describe('scanPackageSourceRoot', () => {
  it('returns only sorted directory and symbolic-link candidates', () => {
    const root = createTestTempRoot('project02-package-source-');
    const target = createTestTempRoot('project02-package-target-');

    mkdirSync(join(root, 'zeta'));
    mkdirSync(join(root, 'alpha'));
    writeFileSync(join(root, 'notes.txt'), 'not a package\n', 'utf8');
    symlinkSync(target, join(root, 'linked'), 'dir');

    expect(scanPackageSourceRoot(root)).toEqual({
      status: 'scanned',
      candidates: [{name: 'alpha'}, {name: 'linked'}, {name: 'zeta'}],
    });
  });

  it('returns the original source-read error', () => {
    const root = join(
      createTestTempRoot('project02-package-source-'),
      'missing',
    );
    const result = scanPackageSourceRoot(root);

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.error).toMatchObject({code: 'ENOENT'});
    }
  });
});

describe('readBoundedPackageJsonFile', () => {
  it('returns an immutable safe JSON snapshot', () => {
    const root = createTestTempRoot('project02-package-json-');
    const path = join(root, 'metadata.json');

    writeFileSync(path, '{"nested":{"enabled":true}}\n', 'utf8');

    const result = readBoundedPackageJsonFile({
      path,
      maxBytes: 1_024,
      boundaryField: 'Test package metadata',
    });

    expect(result).toEqual({
      status: 'accepted',
      value: {nested: {enabled: true}},
    });
    if (result.status === 'accepted') {
      expect(Object.isFrozen(result.value)).toBe(true);
      if (typeof result.value === 'object' && result.value !== null) {
        expect(Object.isFrozen(Reflect.get(result.value, 'nested'))).toBe(true);
      }
    }
  });

  it.each([
    ['a read failure after stat', 'unreadable'],
    ['content that grows after stat', 'too_large'],
  ] as const)('rejects %s', async (scenario, reason) => {
    const root = createTestTempRoot('project02-package-json-race-');
    const path = join(root, 'metadata.json');

    writeFileSync(path, '{}\n', 'utf8');
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        readFileSync(
          candidate: NodeFs.PathOrFileDescriptor,
          ...args: unknown[]
        ) {
          if (candidate === path) {
            if (scenario === 'a read failure after stat') {
              throw new Error('read denied');
            }

            return JSON.stringify({padding: 'x'.repeat(128)});
          }

          return Reflect.apply(actual.readFileSync, actual, [
            candidate,
            ...args,
          ]) as unknown;
        },
      };
    });
    const {readBoundedPackageJsonFile: readAfterStat} =
      await import('../../src/shared/package-metadata.ts');

    expect(
      readAfterStat({
        path,
        maxBytes: 32,
        boundaryField: 'Test package metadata',
      }),
    ).toEqual({status: 'rejected', reason});
  });

  it.each([
    ['unreadable', 'unreadable'],
    ['symbolic link', 'symbolic_link'],
    ['non-file', 'not_file'],
    ['oversized input', 'too_large'],
    ['invalid JSON', 'invalid_json'],
    ['unsafe JSON', 'unsafe_json'],
  ] as const)('rejects %s with a neutral reason', (_case, expectedReason) => {
    const root = createTestTempRoot('project02-package-json-');
    const path = join(root, 'metadata.json');
    const target = join(root, 'target.json');

    switch (expectedReason) {
      case 'unreadable':
        break;
      case 'symbolic_link':
        writeFileSync(target, '{}\n', 'utf8');
        symlinkSync(target, path);
        break;
      case 'not_file':
        mkdirSync(path);
        break;
      case 'too_large':
        writeFileSync(path, JSON.stringify({padding: 'x'.repeat(128)}), 'utf8');
        break;
      case 'invalid_json':
        writeFileSync(path, '{not json', 'utf8');
        break;
      case 'unsafe_json':
        writeFileSync(
          path,
          JSON.stringify({
            value: Object.fromEntries(
              Array.from({length: 257}, (_, index) => [
                `field-${String(index)}`,
                index,
              ]),
            ),
          }),
          'utf8',
        );
        break;
    }

    const result = readBoundedPackageJsonFile({
      path,
      maxBytes: expectedReason === 'too_large' ? 32 : 64 * 1_024,
      boundaryField: 'Test package metadata',
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: expectedReason,
    });
  });
});

describe('parseBoundedPackageJsonSource', () => {
  it('parses an immutable safe JSON snapshot from captured bytes', () => {
    const result = parseBoundedPackageJsonSource({
      source: Buffer.from('{"nested":{"enabled":true}}\n', 'utf8'),
      maxBytes: 1_024,
      boundaryField: 'Test package metadata',
    });

    expect(result).toEqual({
      status: 'accepted',
      value: {nested: {enabled: true}},
    });
    if (result.status === 'accepted') {
      expect(Object.isFrozen(result.value)).toBe(true);
      if (typeof result.value === 'object' && result.value !== null) {
        expect(Object.isFrozen(Reflect.get(result.value, 'nested'))).toBe(true);
      }
    }
  });
});
