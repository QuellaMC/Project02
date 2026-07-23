import {characterDataDirPath} from '../../src/runtime/storage/layout-contract.ts';
import {ensureCharacterDataStamp} from '../../src/runtime/storage/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';

import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import {
  defaultRoleModelProviderCapabilities,
  type RoleModelAdapter,
} from '../../src/role-model/index.ts';
import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {
  applyScopedRuntimeConfigControlOperation,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginAccessMap,
  type RuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import {
  firstPartyModelToolsPluginId,
  runtimePluginId,
} from '../../src/plugins/api/contract.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';

describe('inspect CLI plugin evidence', () => {
  it('shows model rounds and per-tool plugin events', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-');
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-inspect',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId: 'session-inspect',
    });
    const session = createConversationSession({
      id: 'session-inspect',
      character: testCharacterProfile,
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        createRuntimeEventIdentity({
          eventId: 'evt_inspect',
          traceId: 'trace_inspect',
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      ),
      session,
      logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: characterDataDirPath(storeRoot, 'mira'),
        sessionId: 'session-inspect',
        sessionIdentity: session,
      }),
      roleModelAdapter: createPatchThenReplyAdapter(),
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', 'session-inspect'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const output = JSON.parse(stdout) as {
      readonly evidenceScopes: {
        readonly runtimeConfig: string;
        readonly activation: string;
        readonly storedSessionEvidence: string;
        readonly derivedTraceEvidence: string;
      };
      readonly counts: {
        readonly traceEntries: number;
        readonly derivedTraceEntries: number;
      };
      readonly turns: readonly [
        {
          readonly derivedSteps: readonly unknown[];
          readonly modelRounds: readonly {
            readonly rawEventKind: string;
            readonly roleModelEvidence: {
              readonly output?: {
                readonly rawOutputText: string;
                readonly providerExchange?: {
                  readonly renderedMessages: readonly unknown[];
                  readonly renderedTools: readonly unknown[];
                  readonly requestBody: unknown;
                  readonly nativeToolResultMessages: readonly unknown[];
                };
              };
              readonly input?: {
                readonly pluginContextItems: readonly {
                  readonly pluginId: string;
                  readonly text: string;
                }[];
              };
            };
          }[];
          readonly toolEvents: readonly [{readonly pluginId: string}];
          readonly pluginEvidence: {
            readonly evidence: readonly {
              readonly pluginId: string;
              readonly evidenceKind: string;
              readonly status: string;
            }[];
          };
        },
      ];
    };

    expect(exitCode).toBe(0);
    expect(output.evidenceScopes).toEqual({
      runtimeConfig: 'current_at_inspection',
      activation: 'current_at_inspection',
      storedSessionEvidence: 'stored_history',
      derivedTraceEvidence: 'derived_not_persisted',
    });
    expect(output.counts.derivedTraceEntries).toBe(0);
    expect(output.turns[0].derivedSteps).toEqual([]);
    expect(output.turns[0].modelRounds).toHaveLength(2);
    expect(
      output.turns[0].modelRounds.map(round => round.rawEventKind),
    ).toEqual(['tool_call_started', 'visible_reply_committed']);
    expect(
      output.turns[0].modelRounds[0]?.roleModelEvidence.output?.rawOutputText,
    ).toContain('character_state.patch');
    expect(
      output.turns[0].modelRounds[0]?.roleModelEvidence.input
        ?.pluginContextItems[0]?.text,
    ).toContain("Mira's internal Character State");
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.renderedMessages.length,
    ).toBeGreaterThan(0);
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.renderedTools.length,
    ).toBeGreaterThan(0);
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.requestBody,
    ).toMatchObject({
      provider: 'local-fixture',
    });
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.nativeToolResultMessages.length,
    ).toBeGreaterThan(0);
    expect(output.turns[0].toolEvents[0].pluginId).toBe('character-state');
    expect(output.turns[0].pluginEvidence.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'character-state',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          summary: 'Applied 1 Character State changes.',
        }),
      ]),
    );
  });

  it('shows runtime config source and configured plugin activation', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-config-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      storeRoot,
      plugins: {
        'unknown-plugin': {
          enabled: true,
        },
        'character-state': {
          enabled: false,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-config',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--config', configPath, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const output = JSON.parse(stdout) as {
      readonly runtimeConfig: {
        readonly source: string;
        readonly path: string;
        readonly project02: {readonly storeRoot: string};
      };
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly requestedAccess: RuntimePluginAccessMap;
        readonly grantedAccess: RuntimePluginAccessMap;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(output.runtimeConfig).toMatchObject({
      source: 'path',
      path: configPath,
      project02: {storeRoot},
    });
    expect(output.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: runtimePluginId,
          enabled: true,
          requestedAccess: {model_input: 'write'},
          grantedAccess: {model_input: 'write'},
        }),
        expect.objectContaining({
          pluginId: firstPartyModelToolsPluginId,
          enabled: true,
        }),
        expect.objectContaining({
          pluginId: 'character-state',
          enabled: false,
        }),
      ]),
    );
    expect(stdout).toContain('"activationDiagnostics"');
    expect(stdout).toContain('"runtime_config_unknown_plugin"');
    expect(stdout).toContain('"disabled_by_config"');
  });

  it('uses cwd dotenv runtime config selectors for unflagged inspect', async () => {
    const cwdRoot = createTestTempRoot('project02-inspect-cwd-env-');
    const storeRoot = createTestTempRoot('project02-inspect-cwd-store-');
    const configPath = writeRuntimeConfig(join(cwdRoot, 'config.json'), {
      storeRoot,
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-cwd-config',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      const exitCode = await runInspectCliFromArgs(['--sessions'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      });
      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly source: string;
          readonly path: string;
          readonly project02: {readonly storeRoot: string};
        };
        readonly sessions: readonly {readonly sessionId: string}[];
      };

      expect(exitCode).toBe(0);
      expect(output.runtimeConfig).toMatchObject({
        source: 'env',
        path: configPath,
        project02: {storeRoot},
      });
      expect(output.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-cwd-config',
        }),
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('ignores process and cwd dotenv runtime config selectors when --store is explicit', async () => {
    const cwdRoot = createTestTempRoot('project02-inspect-cwd-store-');
    const defaultStoreRoot = createTestTempRoot(
      'project02-inspect-default-store-',
    );
    const selectedStoreRoot = createTestTempRoot(
      'project02-inspect-selected-store-',
    );
    const defaultConfigPath = writeRuntimeConfig(join(cwdRoot, 'config.json'), {
      storeRoot: defaultStoreRoot,
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${defaultConfigPath}\n`,
      'utf8',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
    }).createSession({
      sessionId: 'session-selected-store',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    try {
      process.env[runtimeConfigEnvVarName] = defaultConfigPath;
      process.chdir(cwdRoot);

      const exitCode = await runInspectCliFromArgs(
        ['--store', selectedStoreRoot, '--sessions'],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
        },
      );
      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly source: string;
          readonly project02: {readonly storeRoot: string};
        };
        readonly sessions: readonly {readonly sessionId: string}[];
      };

      expect(exitCode).toBe(0);
      expect(output.runtimeConfig).toMatchObject({
        source: 'none',
        project02: {storeRoot: selectedStoreRoot},
      });
      expect(output.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-selected-store',
        }),
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses an explicit store before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-inspect-cwd-dotenv-error-');
    const selectedStoreRoot = createTestTempRoot(
      'project02-inspect-selected-dotenv-error-',
    );
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
    }).createSession({
      sessionId: 'session-selected-before-cwd-dotenv',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      const exitCode = await runInspectCliFromArgs(
        ['--store', selectedStoreRoot, '--sessions'],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        },
      );
      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly source: string;
          readonly project02: {readonly storeRoot: string};
        };
        readonly sessions: readonly {readonly sessionId: string}[];
      };

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(output.runtimeConfig).toMatchObject({
        source: 'none',
        project02: {storeRoot: selectedStoreRoot},
      });
      expect(output.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-selected-before-cwd-dotenv',
        }),
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses a process-env selected runtime config before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot(
      'project02-inspect-env-cwd-dotenv-error-',
    );
    const selectedStoreRoot = createTestTempRoot(
      'project02-inspect-env-selected-store-',
    );
    const configRoot = createTestTempRoot(
      'project02-inspect-env-selected-config-',
    );
    const configPath = writeRuntimeConfig(
      join(configRoot, 'runtime-config.json'),
      {
        storeRoot: selectedStoreRoot,
      },
    );
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
    }).createSession({
      sessionId: 'session-env-selected-before-cwd-dotenv',
      createdAt: '2026-06-22T00:00:00.000Z',
    });

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      const exitCode = await runInspectCliFromArgs(['--sessions'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      });
      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly source: string;
          readonly path: string;
          readonly project02: {readonly storeRoot: string};
        };
        readonly sessions: readonly {readonly sessionId: string}[];
      };

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(output.runtimeConfig).toMatchObject({
        source: 'env',
        path: configPath,
        project02: {storeRoot: selectedStoreRoot},
      });
      expect(output.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-env-selected-before-cwd-dotenv',
        }),
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses declared plugin manifests for inspect without constructing plugins', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-factory-');
    const plugin = createInspectFixturePlugin();
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-custom-factory',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;

              return plugin;
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {readonly code: string}[];
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly activationStatus: string;
        readonly activationReasons: readonly string[];
      }[];
    };

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_unknown_plugin',
    );
    const inspectedPlugin = output.plugins.find(
      item => item.pluginId === plugin.manifest.id,
    );

    expect(inspectedPlugin).toMatchObject({
      pluginId: plugin.manifest.id,
      enabled: true,
      activationStatus: 'active',
    });
    expect(inspectedPlugin?.activationReasons).toEqual(
      expect.arrayContaining(['test_inspect_fixture', 'enabled_by_config']),
    );
  });

  it('reports a corrupt character store instead of an empty session list', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-corrupt-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A data directory that exists but lost its schema marker while
    // sessions/ still holds content: corruption or foreign data, never
    // an "empty" view.
    mkdirSync(join(dataRoot, 'sessions', 'lost-session'), {recursive: true});
    writeFileSync(
      join(dataRoot, 'sessions', 'lost-session', 'raw-events.jsonl'),
      '',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Error:');
  });

  it('reports a foreign home instead of an empty session list', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-home-');
    let stderr = '';

    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('lists no sessions while a sibling marker replacement is live', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-live-temp-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    // A concurrent first initializer between temp-write and rename:
    // the live replacement must not fail the control-only view.
    writeFileSync(
      join(
        dataRoot,
        `.schema.json.${String(process.pid)}.0f0e0d0c-0b0a-4908-8706-050403020100.tmp`,
      ),
      '',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
  });

  it('reports a foreign entry in the data directory instead of an empty session list', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-entry-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A marker-less data directory holding anything outside the
    // control allowlist is foreign or corrupt, never an empty view.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Error:');
  });

  it('rejects a session list when the session catalog is a symlink', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-catalog-link-');
    const outside = createTestTempRoot('project02-inspect-catalog-target-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'character-binding.json'),
      `${JSON.stringify({
        format: 'project02.character-binding.v1',
        characterId: 'mira',
        boundAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );
    writeFileSync(join(outside, 'external-catalog.jsonl'), '');
    symlinkSync(
      join(outside, 'external-catalog.jsonl'),
      join(dataRoot, 'sessions.jsonl'),
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('rejects a session list when the binding stamp names another character', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-list-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'character-binding.json'),
      `${JSON.stringify({
        format: 'project02.character-binding.v1',
        characterId: 'nova',
        boundAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('holds history for character "nova"');
  });

  it('rejects a session read when the binding stamp names another character', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-stamp-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A copied data directory: mira's path carries nova's stamp. The
    // binding must hold at inspection even when the selected session
    // carries no character evidence at all.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'character-binding.json'),
      `${JSON.stringify({
        format: 'project02.character-binding.v1',
        characterId: 'nova',
        boundAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', 'any-session'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('holds history for character "nova"');
  });

  it('composes the owning home when --config aliases an absent overlay', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-alias-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {userDisplayName: 'Home Name'},
    });
    await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    // The overlay path is the selection, but no overlay exists: the
    // global layer must come from the owning home instead of failing
    // on the missing file.
    const exitCode = await runInspectCliFromArgs(
      [
        '--store',
        storeRoot,
        '--character',
        'mira',
        '--config',
        join(dataRoot, 'config.json'),
        '--sessions',
      ],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
  });

  it('lists no sessions for a data directory holding only control state', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-control-only-');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A config-only workflow leaves a binding stamp, an overlay, and
    // locks — but no session artifacts. That is an empty view, not a
    // corrupt store.
    await ensureCharacterDataStamp({
      storageOptions: {storeRoot: characterDataDirPath(storeRoot, 'mira')},
      characterId: 'mira',
    });
    applyScopedRuntimeConfigControlOperation({
      storeRoot,
      env: {},
      scope: 'character',
      characterId: 'mira',
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'Config Only',
      },
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      sessions: [],
      characterBinding: {status: 'bound'},
    });
  });

  it('reports config load errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-inspect-load-error-before-env-',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42,
    });
    mkdirSync(join(storeRoot, '.env'));

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'Runtime config field must be a non-empty string.',
    );
    expect(stderr).not.toContain('Could not load runtime config env file');
  });

  it('reports env-independent activation errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-inspect-activation-before-env-',
    );
    const plugin = createInspectRequiredConfigFixturePlugin(
      'inspect.required-config',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-activation-before-env',
      createdAt: '2026-06-21T00:00:00.000Z',
    });
    mkdirSync(join(storeRoot, '.env'));

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error('inspect should not construct invalid plugins');
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`,
        }),
      ]),
    );
    expect(stdout).not.toContain('Could not load runtime config env file');
  });

  it('loads runtime env before reporting mixed inspect activation diagnostics', async () => {
    const storeRoot = createTestTempRoot(
      'project02-inspect-mixed-activation-env-',
    );
    const plugin = createInspectRequiredSecretAndConfigFixturePlugin(
      'inspect.mixed-config',
    );
    const envVar = 'PROJECT02_INSPECT_MIXED_SECRET_3452532128';
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-mixed-activation-env',
      createdAt: '2026-06-21T00:00:00.000Z',
    });
    writeFileSync(
      join(storeRoot, '.env'),
      `${envVar}=inspect-secret\n`,
      'utf8',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error('inspect should not construct invalid plugins');
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`,
        }),
      ]),
    );
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_required_secret_missing',
    );
    expect(stdout).not.toContain(`plugins.${plugin.manifest.id}.config.apiKey`);
  });

  it('does not invoke plugin lifecycle hooks while listing sessions', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-close-');
    const sessionEndContexts: RuntimePluginContext[] = [];
    const plugin = createInspectSessionEndFixturePlugin(context => {
      sessionEndContexts.push(context);
    });
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-close',
      createdAt: '2026-06-22T00:00:00.000Z',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              return plugin;
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly requestedAccess: RuntimePluginAccessMap;
        readonly grantedAccess: RuntimePluginAccessMap;
        readonly activationStatus: string;
      }[];
      readonly sessions: readonly {readonly sessionId: string}[];
    };

    expect(exitCode).toBe(0);
    expect(output.sessions).toContainEqual(
      expect.objectContaining({sessionId: 'session-close'}),
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        requestedAccess: {turn_context: 'read'},
        grantedAccess: {turn_context: 'read'},
        activationStatus: 'active',
      }),
    );
    expect(sessionEndContexts).toHaveLength(0);
  });

  it('does not invoke plugin lifecycle hooks when a session read fails', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-close-failure-');
    const missingSessionId = 'missing-session';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const plugin = createInspectSessionEndFixturePlugin(context => {
      sessionEndContexts.push(context);
    });
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'existing-session',
      createdAt: '2026-06-22T00:00:00.000Z',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', missingSessionId],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              return plugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(`Local runtime session "${missingSessionId}"`);
    expect(sessionEndContexts).toHaveLength(0);
  });

  it('preserves formatted store read errors without constructing plugins', async () => {
    const root = createTestTempRoot('project02-inspect-invalid-store-');
    const storeRoot = join(root, 'store-root-file');
    const configPath = join(root, 'config.json');
    const plugin = createInspectFixturePlugin('inspect.invalid-store.fixture');
    let stdout = '';
    let stderr = '';

    writeFileSync(storeRoot, 'not a directory\n', 'utf8');
    writeRuntimeConfig(configPath, {
      storeRoot,
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runInspectCliFromArgs(
      ['--config', configPath, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              return plugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('Error: Local runtime store could not be read.\n');
  });

  it('loads the runtime env file for inspect without mutating process env', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-env-');
    const configPath = join(storeRoot, 'config.json');
    const envVar = 'PROJECT02_INSPECT_ENV_FILE_SECRET_3448711012';
    const previousEnvValue = process.env[envVar];

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: runtimeConfigVersion,
          project02: {
            storeRoot,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(storeRoot, '.env'),
      `${envVar}=inspect-secret\n`,
      'utf8',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    }).createSession({
      sessionId: 'session-env',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    try {
      Reflect.deleteProperty(process.env, envVar);

      const exitCode = await runInspectCliFromArgs(
        ['--config', configPath, '--sessions'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
        },
      );

      expect(exitCode).toBe(0);
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      if (previousEnvValue === undefined) {
        Reflect.deleteProperty(process.env, envVar);
      } else {
        process.env[envVar] = previousEnvValue;
      }
    }
  });
});

function createPatchThenReplyAdapter(): RoleModelAdapter {
  let calls = 0;

  return {
    invoke(_inputEnvelope, invocation) {
      calls += 1;

      if (calls === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious',
                },
              },
            ],
          }),
          nativeAssistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_character_state_patch',
                type: 'function',
                function: {
                  name: 'character_state.patch',
                  arguments: '{"mood":"curious"}',
                },
              },
            ],
          },
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'done',
              },
            },
          ],
        }),
        providerExchange: {
          provider: {
            name: 'local',
            model: 'inspect-fixture',
          },
          capabilities: defaultRoleModelProviderCapabilities,
          reasoning: {
            mode: 'none',
            params: {},
          },
          renderedMessages: invocation.turnContext.messages,
          renderedTools: invocation.turnContext.tools,
          toolNameMappings: [],
          requestBody: {
            provider: 'local-fixture',
          },
          nativeToolResultMessages: invocation.turnContext.messages.filter(
            message => message.role === 'tool',
          ),
        },
      };
    },
  };
}

function createInspectFixturePlugin(
  pluginId = 'inspect.custom',
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Inspect Custom Factory Fixture',
      version: '1.0.0',
      kind: 'first_party',
      description: 'Test plugin for inspect custom factory activation.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test',
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: [],
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test_inspect_fixture'],
      },
      requestedAccess: {},
    },
  });
}

function createInspectRequiredConfigFixturePlugin(
  pluginId: string,
): RuntimePlugin {
  const plugin = createInspectFixturePlugin(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        fields: [
          {
            name: 'endpoint',
            description: 'Required endpoint.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
          },
        ],
      },
    },
  });
}

function createInspectRequiredSecretAndConfigFixturePlugin(
  pluginId: string,
): RuntimePlugin {
  const plugin = createInspectRequiredConfigFixturePlugin(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'apiKey',
            description: 'API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret'],
          },
        ],
      },
    },
  });
}

function createInspectSessionEndFixturePlugin(
  onSessionEnd: (context: RuntimePluginContext) => void,
): RuntimePlugin {
  const pluginId = 'inspect.session-end.fixture';

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Inspect Session End Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for inspect session end lifecycle cleanup.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test',
      },
      declaredPlugins: ['on_session_end'],
      config: {
        fields: [],
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test_inspect_cleanup'],
      },
      requestedAccess: {turn_context: 'read'},
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

function restoreProcessEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
}
