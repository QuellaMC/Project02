import {describe, expect, it} from 'vitest';

import {
  createLayeredRuntimeConfigFingerprint,
  createRuntimeConfigFingerprint,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
} from '../../src/runtime/config/index.ts';

const globalDocument: Project02RuntimeConfig = {
  version: runtimeConfigVersion,
  project02: {storeRoot: '/home', character: 'mira'},
  plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
};

describe('layered runtime config fingerprint', () => {
  it('never collides with the per-file fingerprint of the same global document', () => {
    expect(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: null,
      }),
    ).not.toBe(createRuntimeConfigFingerprint(globalDocument));
  });

  it('distinguishes an absent overlay from an empty overlay document', () => {
    expect(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: null,
      }),
    ).not.toBe(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: {version: runtimeConfigVersion},
      }),
    );
  });

  it('folds the character id and the overlay content', () => {
    const base = createLayeredRuntimeConfigFingerprint({
      globalConfig: globalDocument,
      characterId: 'mira',
      overlayConfig: null,
    });

    expect(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: globalDocument,
        characterId: 'nova',
        overlayConfig: null,
      }),
    ).not.toBe(base);
    expect(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: {
          version: runtimeConfigVersion,
          plugins: {'demo-config': {config: {tone: 'velvet'}}},
        },
      }),
    ).not.toBe(base);
  });

  it('redacts secret refs instead of hashing raw env material', () => {
    const withSecret: Project02RuntimeConfig = {
      version: runtimeConfigVersion,
      plugins: {
        memory: {config: {apiKey: {$env: 'PROJECT02_TEST_KEY'}}},
      },
    };

    expect(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: withSecret,
      }),
    ).toMatch(/^sha256:/u);
  });
});
