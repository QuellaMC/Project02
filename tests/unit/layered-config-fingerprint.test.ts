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
      createRuntimeConfigFingerprint(withSecret('hunter2'), {
        plugins: [manifest],
      }),
    ).toBe(
      createRuntimeConfigFingerprint(withSecret('other-value'), {
        plugins: [manifest],
      }),
    );

    // Setting or clearing the secret still changes the fingerprint, and a
    // non-secret field's value still counts.
    expect(
      createRuntimeConfigFingerprint(withSecret('hunter2'), {
        plugins: [manifest],
      }),
    ).not.toBe(
      createRuntimeConfigFingerprint(
        {
          version: runtimeConfigVersion,
          plugins: {'demo-config': {config: {tone: 'warm'}}},
        },
        {plugins: [manifest]},
      ),
    );
    expect(
      createRuntimeConfigFingerprint(withSecret('hunter2'), {
        plugins: [manifest],
      }),
    ).not.toBe(
      createRuntimeConfigFingerprint(withSecret('hunter2'), {plugins: []}),
    );

    // A malformed value at a secret field -- which an inactive plugin's
    // config never had validated -- is still a value, so only its
    // presence is hashed.
    const malformed = (token: string): Project02RuntimeConfig => ({
      version: runtimeConfigVersion,
      plugins: {'demo-config': {config: {apiKey: {token}, tone: 'warm'}}},
    });

    expect(
      createRuntimeConfigFingerprint(malformed('weak-passcode'), {
        plugins: [manifest],
      }),
    ).toBe(
      createRuntimeConfigFingerprint(malformed('other'), {plugins: [manifest]}),
    );
  });

  it('hashes no secret value of an overlay that fails validation', () => {
    const manifest = requiredSecretPlugin('demo-config').manifest;
    const fingerprint = (authored: {
      readonly nvidiaApiKey: string;
      readonly apiKey: string;
      readonly tone: string;
    }) =>
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: [manifest]},
        globalConfig: globalDocument,
        characterId: 'mira',
        // A negative context window fails validation, so the loader keeps
        // only the authored document.
        overlay: {
          source: 'overlay',
          authoredDocument: {
            version: runtimeConfigVersion,
            project02: {
              contextWindowTokens: -1,
              nvidiaApiKey: authored.nvidiaApiKey,
            },
            plugins: {
              'demo-config': {
                config: {apiKey: authored.apiKey, tone: authored.tone},
              },
            },
          },
        },
      });
    const authored = {
      nvidiaApiKey: 'hunter2',
      apiKey: 'swordfish',
      tone: 'warm',
    };

    expect(fingerprint({...authored, nvidiaApiKey: 'other-value'})).toBe(
      fingerprint(authored),
    );
    expect(fingerprint({...authored, apiKey: 'other-value'})).toBe(
      fingerprint(authored),
    );
    expect(fingerprint({...authored, tone: 'velvet'})).not.toBe(
      fingerprint(authored),
    );
  });

  it('never collides with the per-file fingerprint of the same global document', () => {
    expect(
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: []},
        globalConfig: globalDocument,
        characterId: 'mira',
        overlay: {source: 'none'},
      }),
    ).not.toBe(createRuntimeConfigFingerprint(globalDocument, {plugins: []}));
  });

  it('distinguishes an absent overlay from an empty overlay document', () => {
    expect(
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: []},
        globalConfig: globalDocument,
        characterId: 'mira',
        overlay: {source: 'none'},
      }),
    ).not.toBe(
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: []},
        globalConfig: globalDocument,
        characterId: 'mira',
        overlay: {source: 'overlay', config: {version: runtimeConfigVersion}},
      }),
    );
  });

  it('folds the character id and the overlay content', () => {
    const base = createLayeredRuntimeConfigFingerprint({
      sections: {plugins: []},
      globalConfig: globalDocument,
      characterId: 'mira',
      overlay: {source: 'none'},
    });

    expect(
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: []},
        globalConfig: globalDocument,
        characterId: 'nova',
        overlay: {source: 'none'},
      }),
    ).not.toBe(base);
    expect(
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: []},
        globalConfig: globalDocument,
        characterId: 'mira',
        overlay: {
          source: 'overlay',
          config: {
            version: runtimeConfigVersion,
            plugins: {'demo-config': {config: {tone: 'velvet'}}},
          },
        },
      }),
    ).not.toBe(base);
  });
});
