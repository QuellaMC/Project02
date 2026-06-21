import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createConversationSession
} from '../src/core/conversation.ts';
import {
  createFileRuntimeLogStore
} from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import {
  createUserMessageRuntimeEvent,
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  runLocalUserMessageEvent
} from '../src/runtime/local.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';
import { runInspectCliFromArgs } from '../src/cli/inspect.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginContext
} from '../src/plugins/types.ts';

describe('inspect CLI plugin evidence', () => {
  it('shows model rounds and per-tool plugin events', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-'));
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-inspect',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-inspect'
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        createRuntimeEventIdentity({
          eventId: 'evt_inspect',
          traceId: 'trace_inspect',
          createdAt: '2026-06-15T00:00:00.000Z'
        })
      ),
      session: createConversationSession({ id: 'session-inspect' }),
      logStore,
      roleModelAdapter: createPatchThenReplyAdapter()
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', 'session-inspect'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      }
    );
    const output = JSON.parse(stdout) as {
      readonly turns: readonly [
        {
          readonly modelRounds: readonly {
            readonly rawEventKind: string;
            readonly roleModelEvidence: {
              readonly output?: {
                readonly rawOutputText: string;
              };
            };
          }[];
          readonly toolEvents: readonly [{ readonly pluginId: string }];
          readonly pluginEvidence: {
            readonly evidence: readonly {
              readonly pluginId: string;
              readonly evidenceKind: string;
              readonly status: string;
            }[];
          };
        }
      ];
    };

    expect(exitCode).toBe(0);
    expect(output.turns[0].modelRounds).toHaveLength(2);
    expect(output.turns[0].modelRounds.map((round) => round.rawEventKind)).toEqual([
      'tool_call_started',
      'visible_reply_committed'
    ]);
    expect(
      output.turns[0].modelRounds[0]?.roleModelEvidence.output?.rawOutputText
    ).toContain('character_state.patch');
    expect(output.turns[0].toolEvents[0].pluginId).toBe('character-state');
    expect(output.turns[0].pluginEvidence.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'character-state',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          summary: 'Applied 1 Character State changes.'
        })
      ])
    );
  });

  it('shows runtime config source and configured plugin activation', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-config-'));
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      storeRoot,
      plugins: {
        'unknown-plugin': {
          enabled: true
        },
        'character-state': {
          enabled: false
        }
      }
    });
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-config',
      createdAt: '2026-06-21T00:00:00.000Z'
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--config', configPath, '--sessions'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      }
    );
    const output: unknown = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(output).toMatchObject({
      runtimeConfig: {
        source: 'path',
        path: configPath,
        storeRoot
      },
      plugins: [
        expect.objectContaining({
          pluginId: 'character-state',
          enabled: false
        })
      ]
    });
    expect(stdout).toContain('"activationDiagnostics"');
    expect(stdout).toContain('"runtime_config_unknown_plugin"');
    expect(stdout).toContain('"disabled_by_config"');
  });

  it('uses cwd dotenv runtime config selectors for unflagged inspect', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-cwd-env-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-cwd-store-'));
    const configPath = writeRuntimeConfig(join(cwdRoot, 'config.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8'
    );
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-cwd-config',
      createdAt: '2026-06-21T00:00:00.000Z'
    });

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      const exitCode = await runInspectCliFromArgs(['--sessions'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      });
      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly source: string;
          readonly path: string;
          readonly storeRoot: string;
        };
        readonly sessions: readonly { readonly sessionId: string }[];
      };

      expect(exitCode).toBe(0);
      expect(output.runtimeConfig).toMatchObject({
        source: 'env',
        path: configPath,
        storeRoot
      });
      expect(output.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-cwd-config'
        })
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('ignores cwd dotenv runtime config selectors when --store is explicit', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-cwd-store-'));
    const defaultStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-inspect-default-store-')
    );
    const selectedStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-inspect-selected-store-')
    );
    const defaultConfigPath = writeRuntimeConfig(join(cwdRoot, 'config.json'), {
      storeRoot: defaultStoreRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${defaultConfigPath}\n`,
      'utf8'
    );
    await createLocalRuntimeSessionStore({ storeRoot: selectedStoreRoot }).createSession({
      sessionId: 'session-selected-store',
      createdAt: '2026-06-21T00:00:00.000Z'
    });

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      const exitCode = await runInspectCliFromArgs(
        ['--store', selectedStoreRoot, '--sessions'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      );
      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly source: string;
          readonly storeRoot: string;
        };
        readonly sessions: readonly { readonly sessionId: string }[];
      };

      expect(exitCode).toBe(0);
      expect(output.runtimeConfig).toMatchObject({
        source: 'none',
        storeRoot: selectedStoreRoot
      });
      expect(output.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-selected-store'
        })
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses custom plugin factories for inspect activation output', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-factory-'));
    const plugin = createInspectFixturePlugin();
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-custom-factory',
      createdAt: '2026-06-21T00:00:00.000Z'
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;

              return plugin;
            }
          }
        }
      }
    );
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly { readonly code: string }[];
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly activationStatus: string;
        readonly activationReasons: readonly string[];
      }[];
    };

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(1);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin'
    );
    const inspectedPlugin = output.plugins.find(
      (item) => item.pluginId === plugin.manifest.id
    );

    expect(inspectedPlugin).toMatchObject({
      pluginId: plugin.manifest.id,
      enabled: true,
      activationStatus: 'active'
    });
    expect(inspectedPlugin?.activationReasons).toEqual(
      expect.arrayContaining(['test_inspect_fixture', 'enabled_by_config'])
    );
  });

  it('closes configured plugins after sessions inspect activation output', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-close-'));
    const sessionEndContexts: RuntimePluginContext[] = [];
    const plugin = createInspectSessionEndFixturePlugin((context) => {
      sessionEndContexts.push(context);
    });
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-close',
      createdAt: '2026-06-22T00:00:00.000Z'
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              return plugin;
            }
          }
        }
      }
    );
    const output = JSON.parse(stdout) as {
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly activationStatus: string;
      }[];
      readonly sessions: readonly { readonly sessionId: string }[];
    };

    expect(exitCode).toBe(0);
    expect(output.sessions).toContainEqual(
      expect.objectContaining({ sessionId: 'session-close' })
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        activationStatus: 'active'
      })
    );
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: 'inspect',
      currentUserMessage: 'inspect plugin activation cleanup'
    });
  });

  it('closes configured plugins after session inspect activation failures', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-close-failure-'));
    const missingSessionId = 'missing-session';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const plugin = createInspectSessionEndFixturePlugin((context) => {
      sessionEndContexts.push(context);
    });
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'existing-session',
      createdAt: '2026-06-22T00:00:00.000Z'
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', missingSessionId],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              return plugin;
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(`Local runtime session "${missingSessionId}"`);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: missingSessionId,
      currentUserMessage: 'inspect plugin activation cleanup'
    });
  });

  it('loads the runtime env file for inspect without mutating process env', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-inspect-env-'));
    const configPath = join(storeRoot, 'config.json');
    const envVar = 'PROJECT02_INSPECT_ENV_FILE_SECRET_3448711012';
    const previousEnvValue = process.env[envVar];

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: runtimeConfigVersion,
          storeRoot
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    writeFileSync(join(storeRoot, '.env'), `${envVar}=inspect-secret\n`, 'utf8');
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-env',
      createdAt: '2026-06-21T00:00:00.000Z'
    });

    try {
      Reflect.deleteProperty(process.env, envVar);

      const exitCode = await runInspectCliFromArgs(
        ['--config', configPath, '--sessions'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
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
    invoke() {
      calls += 1;

      if (calls === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'done'
              }
            }
          ]
        })
      };
    }
  };
}

function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>
): string {
  writeFileSync(
    path,
    `${JSON.stringify({ version: runtimeConfigVersion, ...config }, null, 2)}\n`,
    'utf8'
  );
  return path;
}

function createInspectFixturePlugin(): RuntimePlugin {
  const pluginId = 'inspect.custom';

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
        sourceSystem: 'test'
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: []
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
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test_inspect_fixture']
      },
      requestedApis: []
    }
  });
}

function createInspectSessionEndFixturePlugin(
  onSessionEnd: (context: RuntimePluginContext) => void
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
        sourceSystem: 'test'
      },
      declaredPlugins: ['on_session_end'],
      config: {
        fields: []
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
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test_inspect_cleanup']
      },
      requestedApis: []
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function restoreProcessEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
}

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
