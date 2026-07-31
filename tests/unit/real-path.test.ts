import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  canonicalPath,
  describeRealEntry,
  describeRealEntryAsync,
  firstUnacceptableComponent,
  pathComponentChain,
  pathIsAtOrBelow,
  PathResolutionError,
  relativePathIfContained,
  resolveContainedPath,
} from '../../src/shared/real-path.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('describeRealEntry', () => {
  it('reports a regular file, a directory, and a link as themselves', () => {
    const root = createTestTempRoot('project02-real-path-');

    mkdirSync(join(root, 'directory'));
    writeFileSync(join(root, 'file.txt'), 'contents\n', 'utf8');
    symlinkSync(join(root, 'file.txt'), join(root, 'link'));

    expect(describeRealEntry(join(root, 'file.txt')).kind).toBe('file');
    expect(describeRealEntry(join(root, 'directory')).kind).toBe('directory');
    expect(describeRealEntry(join(root, 'link')).kind).toBe('link');
  });

  it('reports a dangling link as a link, not as absent', () => {
    const root = createTestTempRoot('project02-real-path-');

    symlinkSync(join(root, 'missing'), join(root, 'dangling'));

    expect(describeRealEntry(join(root, 'dangling')).kind).toBe('link');
  });

  it('reports a missing path as absent, keeping the error', () => {
    const root = createTestTempRoot('project02-real-path-');
    const entry = describeRealEntry(join(root, 'missing'));

    expect(entry.kind).toBe('absent');
    // Callers that rethrow rather than re-stat need the original error, so a
    // "not there yet" reaches their own callers by code, not by message.
    expect(entry).toMatchObject({error: {code: 'ENOENT'}});
  });

  it('reports a path under a file parent as unreadable, not absent', () => {
    const root = createTestTempRoot('project02-real-path-');

    writeFileSync(join(root, 'file.txt'), 'contents\n', 'utf8');

    // Callers classify ENOTDIR differently: one creates the parent, another
    // refuses the layout. The seam hands the error back instead of deciding.
    const entry = describeRealEntry(join(root, 'file.txt', 'child'));

    expect(entry.kind).toBe('unreadable');
    expect(entry).toMatchObject({error: {code: 'ENOTDIR'}});
  });

  it('classifies the same way whether asked synchronously or not', async () => {
    const root = createTestTempRoot('project02-real-path-');

    writeFileSync(join(root, 'file.txt'), 'contents\n', 'utf8');
    symlinkSync(join(root, 'file.txt'), join(root, 'link'));

    for (const name of ['file.txt', 'link', 'missing', '']) {
      const path = join(root, name);

      expect((await describeRealEntryAsync(path)).kind).toBe(
        describeRealEntry(path).kind,
      );
    }
  });

  it('reports inode identity without rounding', () => {
    const root = createTestTempRoot('project02-real-path-');

    writeFileSync(join(root, 'file.txt'), 'contents\n', 'utf8');
    const entry = describeRealEntry(join(root, 'file.txt'));

    expect(entry.kind).toBe('file');
    expect(entry.kind === 'file' ? typeof entry.stats.ino : undefined).toBe(
      'bigint',
    );
  });
});

describe('canonicalPath', () => {
  it('resolves a path through the links in its ancestry', () => {
    const root = createTestTempRoot('project02-real-path-');

    mkdirSync(join(root, 'real', 'nested'), {recursive: true});
    symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');

    expect(canonicalPath(join(root, 'linked', 'nested'))).toBe(
      join(root, 'real', 'nested'),
    );
  });

  it('canonicalizes a path that does not exist yet', () => {
    const root = createTestTempRoot('project02-real-path-');

    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');

    // The tail is missing, but the ancestry that does exist still resolves:
    // this is the shape every "the runtime will create it" caller needs.
    expect(canonicalPath(join(root, 'linked', 'not', 'yet'))).toBe(
      join(root, 'real', 'not', 'yet'),
    );
  });

  it('names a dangling link itself unless asked to follow it', () => {
    const root = createTestTempRoot('project02-real-path-');

    symlinkSync(join(root, 'target'), join(root, 'dangling'));

    expect(canonicalPath(join(root, 'dangling'))).toBe(join(root, 'dangling'));
    expect(
      canonicalPath(join(root, 'dangling'), {followDanglingLinks: true}),
    ).toBe(join(root, 'target'));
  });

  it('refuses a symlink cycle when following dangling links', () => {
    const root = createTestTempRoot('project02-real-path-');

    symlinkSync(join(root, 'second'), join(root, 'first'));
    symlinkSync(join(root, 'first'), join(root, 'second'));

    expect(() =>
      canonicalPath(join(root, 'first'), {followDanglingLinks: true}),
    ).toThrow(PathResolutionError);
  });
});

describe('relativePathIfContained', () => {
  it('reports containment with a "/"-separated path', () => {
    expect(relativePathIfContained('/a/b', '/a/b/c/d')).toBe('c/d');
    expect(relativePathIfContained('/a/b', '/a/b')).toBe('');
  });

  it('reports a path outside the root as uncontained', () => {
    expect(relativePathIfContained('/a/b', '/a/c')).toBeUndefined();
    expect(relativePathIfContained('/a/b', '/a')).toBeUndefined();
    // A sibling whose name merely starts with the root's is not inside it.
    expect(relativePathIfContained('/a/b', '/a/bc')).toBeUndefined();
  });

  it('answers pathIsAtOrBelow for the root itself and below', () => {
    expect(pathIsAtOrBelow('/a/b', '/a/b')).toBe(true);
    expect(pathIsAtOrBelow('/a/b/c', '/a/b')).toBe(true);
    expect(pathIsAtOrBelow('/a', '/a/b')).toBe(false);
  });
});

describe('resolveContainedPath', () => {
  it('accepts a link that stays inside the root', () => {
    const root = createTestTempRoot('project02-real-path-');

    writeFileSync(join(root, 'file.txt'), 'contents\n', 'utf8');
    symlinkSync(join(root, 'file.txt'), join(root, 'link'));

    expect(resolveContainedPath({root, path: join(root, 'link')})).toEqual({
      status: 'contained',
      canonicalPath: join(root, 'file.txt'),
      relativePath: 'file.txt',
    });
  });

  it('reports a link that leaves the root as escaping', () => {
    const root = createTestTempRoot('project02-real-path-');
    const outside = createTestTempRoot('project02-real-path-outside-');

    writeFileSync(join(outside, 'file.txt'), 'contents\n', 'utf8');
    symlinkSync(join(outside, 'file.txt'), join(root, 'link'));

    expect(resolveContainedPath({root, path: join(root, 'link')})).toEqual({
      status: 'escapes',
      canonicalPath: join(outside, 'file.txt'),
    });
  });

  it('reports a cyclic link as unresolvable', () => {
    const root = createTestTempRoot('project02-real-path-');

    symlinkSync(join(root, 'second'), join(root, 'first'));
    symlinkSync(join(root, 'first'), join(root, 'second'));

    expect(
      resolveContainedPath({
        root,
        path: join(root, 'first'),
        followDanglingLinks: true,
      }),
    ).toEqual({status: 'unresolvable'});
  });
});

describe('pathComponentChain', () => {
  it('lists every path from the root down, root first when asked', () => {
    expect(
      pathComponentChain({root: '/a', path: '/a/b/c', includeRoot: true}),
    ).toEqual(['/a', '/a/b', '/a/b/c']);
    expect(
      pathComponentChain({root: '/a', path: '/a/b/c', includeRoot: false}),
    ).toEqual(['/a/b', '/a/b/c']);
  });

  it('reports a path outside the root as having no chain', () => {
    expect(
      pathComponentChain({root: '/a', path: '/b', includeRoot: true}),
    ).toBeUndefined();
  });
});

describe('firstUnacceptableComponent', () => {
  it('accepts a chain of real directories', () => {
    const root = createTestTempRoot('project02-real-path-');

    mkdirSync(join(root, 'a', 'b'), {recursive: true});

    expect(
      firstUnacceptableComponent({
        root,
        path: join(root, 'a', 'b'),
        accept: ['directory'],
      }),
    ).toBeUndefined();
  });

  it('reports the first component that is a link', () => {
    const root = createTestTempRoot('project02-real-path-');

    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');

    expect(
      firstUnacceptableComponent({
        root,
        path: join(root, 'linked', 'deeper'),
        accept: ['directory'],
      }),
    ).toEqual({path: join(root, 'linked'), kind: 'link'});
  });

  it('reports the first component of an unaccepted kind', () => {
    const root = createTestTempRoot('project02-real-path-');

    writeFileSync(join(root, 'a'), 'contents\n', 'utf8');

    expect(
      firstUnacceptableComponent({
        root,
        path: join(root, 'a', 'b'),
        accept: ['directory'],
      }),
    ).toEqual({path: join(root, 'a'), kind: 'file'});
  });

  it('stops below an accepted file, which nothing can exist under', () => {
    const root = createTestTempRoot('project02-real-path-');

    writeFileSync(join(root, 'a'), 'contents\n', 'utf8');

    expect(
      firstUnacceptableComponent({
        root,
        path: join(root, 'a', 'b'),
        accept: ['directory', 'file'],
      }),
    ).toBeUndefined();
  });

  it('stops at the first component that does not exist', () => {
    const root = createTestTempRoot('project02-real-path-');

    // What is not there cannot redirect a write, and whatever creates it owns
    // the path from that point down.
    expect(
      firstUnacceptableComponent({
        root,
        path: join(root, 'missing', 'deeper'),
        accept: ['directory'],
      }),
    ).toBeUndefined();
  });

  it('reports a path outside the root as having nothing to check', () => {
    const root = createTestTempRoot('project02-real-path-');
    const outside = createTestTempRoot('project02-real-path-outside-');

    expect(
      firstUnacceptableComponent({
        root,
        path: outside,
        accept: ['directory'],
      }),
    ).toBeUndefined();
  });
});
