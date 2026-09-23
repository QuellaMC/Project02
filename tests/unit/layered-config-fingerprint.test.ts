import {describe, expect, it} from 'vitest';

import {
  createLayeredRuntimeConfigFingerprint,
  createRuntimeConfigFingerprint,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {requiredSecretPlugin} from '../support/runtime-config-activation-fixtures.ts';

const globalDocument: Project02RuntimeConfig = {
  version: runtimeConfigVersion,
  project02: {character: 'mira'},
  plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
};

describe('layered runtime config fingerprint', () => {
  it('hashes the presence of a plaintext secret, never its value', () => {
    const manifest = requiredSecretPlugin('demo-config').manifest;
    const withSecret = (apiKey: string): Project02RuntimeConfig => ({
      version: runtimeConfigVersion,
      plugins: {'demo-config': {config: {apiKey, tone: 'warm'}}},
    });

    // The model reads this fingerprint back from runtime.plugin.config;
    // hashing the value would let a weak passphrase be guessed offline
    // against an otherwise known document.
    expect(
      createRuntimeConfigFingerprint(withSecret('hunter2'), [manifest]),
    ).toBe(
      createRuntimeConfigFingerprint(withSecret('other-value'), [manifest]),
    );

    // Setting or clearing the secret still changes the fingerprint, and a
    // non-secret field's value still counts.
    expect(
      createRuntimeConfigFingerprint(withSecret('hunter2'), [manifest]),
    ).not.toBe(
      createRuntimeConfigFingerprint(
        {
          version: runtimeConfigVersion,
          plugins: {'demo-config': {config: {tone: 'warm'}}},
        },
        [manifest],
      ),
    );
    expect(
      createRuntimeConfigFingerprint(withSecret('hunter2'), [manifest]),
    ).not.toBe(createRuntimeConfigFingerprint(withSecret('hunter2'), []));

    // A malformed value at a secret field -- which an inactive plugin's
    // config never had validated -- is still a value, so only its
    // presence is hashed.
    const malformed = (token: string): Project02RuntimeConfig => ({
      version: runtimeConfigVersion,
      plugins: {'demo-config': {config: {apiKey: {token}, tone: 'warm'}}},
    });

    expect(
      createRuntimeConfigFingerprint(malformed('weak-passcode'), [manifest]),
    ).toBe(createRuntimeConfigFingerprint(malformed('other'), [manifest]));
  });

  it('never collides with the per-file fingerprint of the same global document', () => {
    expect(
      createLayeredRuntimeConfigFingerprint({
        pluginManifests: [],
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: null,
      }),
    ).not.toBe(createRuntimeConfigFingerprint(globalDocument, []));
  });

  it('distinguishes an absent overlay from an empty overlay document', () => {
    expect(
      createLayeredRuntimeConfigFingerprint({
        pluginManifests: [],
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: null,
      }),
    ).not.toBe(
      createLayeredRuntimeConfigFingerprint({
        pluginManifests: [],
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: {version: runtimeConfigVersion},
      }),
    );
  });

  it('folds the character id and the overlay content', () => {
    const base = createLayeredRuntimeConfigFingerprint({
      pluginManifests: [],
      globalConfig: globalDocument,
      characterId: 'mira',
      overlayConfig: null,
    });

    expect(
      createLayeredRuntimeConfigFingerprint({
        pluginManifests: [],
        globalConfig: globalDocument,
        characterId: 'nova',
        overlayConfig: null,
      }),
    ).not.toBe(base);
    expect(
      createLayeredRuntimeConfigFingerprint({
        pluginManifests: [],
        globalConfig: globalDocument,
        characterId: 'mira',
        overlayConfig: {
          version: runtimeConfigVersion,
          plugins: {'demo-config': {config: {tone: 'velvet'}}},
        },
      }),
    ).not.toBe(base);
  });
});
