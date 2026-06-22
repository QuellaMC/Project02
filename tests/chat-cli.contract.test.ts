import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createConversationSession
} from '../src/core/conversation.ts';
import {
  createRuntimePluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginContext
} from '../src/plugins/types.ts';
import {
  createRuntimeLogStore
} from '../src/runtime/log.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import {
  createFileRuntimeLogStore
} from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeStorageLayout
} from '../src/runtime/storage/layout.ts';
import {
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';
import {
  nvidiaApiKeyEnvName
} from '../src/role-model/providers/nvidia.ts';
import { runChatCli, runChatCliFromArgs } from '../src/cli/chat.ts';
import { runInspectCliFromArgs } from '../src/cli/inspect.ts';

const roleModelProviderEnvName = 'PROJECT02_ROLE_MODEL_PROVIDER';

describe('chat CLI folded top-level model text', () => {
  it('hides top-level model text by default', async () => {
    let stdout = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['hello\n/exit\n']),
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect(() => {}),
      roleModelAdapter: createTextOnlyAdapter()
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('folded model note');
  });
});

describe('chat CLI provider selection', () => {
  it('lets the selected store env override the cwd dotenv defaults', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-chat-cwd-env-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-store-env-'));
    const previousCwd = process.cwd();
    const previousProvider = process.env[roleModelProviderEnvName];
    const previousApiKey = process.env[nvidiaApiKeyEnvName];
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stderr = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${roleModelProviderEnvName}=local\n${nvidiaApiKeyEnvName}=cwd-secret\n`,
      'utf8'
    );
    writeRuntimeEnv(
      storeRoot,
      `${roleModelProviderEnvName}=nvidia\n${nvidiaApiKeyEnvName}=\n`
    );

    try {
      Reflect.deleteProperty(process.env, roleModelProviderEnvName);
      Reflect.deleteProperty(process.env, nvidiaApiKeyEnvName);
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      const exitCode = await runChatCliFromArgs(
        ['--store', storeRoot, '--new-session', 'selected-store-env'],
        {
          stdin: Readable.from(['hello\n']),
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`NVIDIA provider requires ${nvidiaApiKeyEnvName}.`);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(roleModelProviderEnvName, previousProvider);
      restoreProcessEnvValue(nvidiaApiKeyEnvName, previousApiKey);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('ignores process and cwd dotenv runtime config selectors when --store is explicit', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-chat-cwd-config-'));
    const defaultStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-default-config-store-')
    );
    const selectedStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-selected-config-store-')
    );
    const sessionId = 'selected-store-config';
    const previousCwd = process.cwd();
    const previousProvider = process.env[roleModelProviderEnvName];
    const previousApiKey = process.env[nvidiaApiKeyEnvName];
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const defaultConfigPath = writeRuntimeConfig(
      join(defaultStoreRoot, 'config.json'),
      {
        storeRoot: defaultStoreRoot
      }
    );
    let stderr = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${defaultConfigPath}\n${roleModelProviderEnvName}=local\n`,
      'utf8'
    );

    try {
      Reflect.deleteProperty(process.env, roleModelProviderEnvName);
      Reflect.deleteProperty(process.env, nvidiaApiKeyEnvName);
      process.env[runtimeConfigEnvVarName] = defaultConfigPath;
      process.chdir(cwdRoot);

      const exitCode = await runChatCliFromArgs(
        ['--store', selectedStoreRoot, '--new-session', sessionId],
        {
          stdin: Readable.from(['/exit\n']),
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      await expect(
        createLocalRuntimeSessionStore({
          storeRoot: selectedStoreRoot
        }).readSession(sessionId)
      ).resolves.toMatchObject({
        sessionId
      });
      expect(
        existsSync(
          createLocalRuntimeStorageLayout({ storeRoot: defaultStoreRoot })
            .sessionCatalogPath
        )
      ).toBe(false);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(roleModelProviderEnvName, previousProvider);
      restoreProcessEnvValue(nvidiaApiKeyEnvName, previousApiKey);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('loads the runtime store env before selecting the default chat provider', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-provider-env-'));
    const sessionId = 'runtime-env-provider';
    let stderr = '';

    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=nvidia\n`);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {
          [nvidiaApiKeyEnvName]: ''
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`NVIDIA provider requires ${nvidiaApiKeyEnvName}.`);
  });

  it('keeps injected env values ahead of the runtime store env', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-injected-env-'));
    let stderr = '';

    writeRuntimeEnv(
      storeRoot,
      `${roleModelProviderEnvName}=nvidia\n${nvidiaApiKeyEnvName}=\n`
    );

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'injected-env-provider'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {
          [roleModelProviderEnvName]: 'local'
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('lets --provider take precedence over the runtime store env', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-provider-cli-'));
    let stderr = '';

    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=not-a-provider\n`);

    const exitCode = await runChatCliFromArgs(
      ['--provider', 'local', '--store', storeRoot, '--new-session', 'cli-provider'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {}
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('reports config load errors before runtime env file errors', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-load-error-before-env-')
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42
    });
    mkdirSync(join(storeRoot, '.env'));

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'load-error-before-env'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config is invalid');
    expect(stderr).toContain('runtime_config_string_invalid');
    expect(stderr).toContain('storeRoot');
    expect(stderr).toContain('Runtime config field must be a non-empty string.');
    expect(stderr).not.toContain('Could not load runtime config env file');
  });
});

describe('chat CLI plugin lifecycle', () => {
  it('runs session-end hooks when /exit closes the chat', async () => {
    const sessionEndContexts: RuntimePluginContext[] = [];
    const logStore = createRuntimeLogStore();
    const pluginHost = createRuntimePluginHost({
      plugins: [
        createSessionEndPlugin((context) => {
          sessionEndContexts.push(context);
        })
      ]
    });

    const exitCode = await runChatCli({
      stdin: Readable.from(['/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(() => {}),
      logStore,
      pluginHost
    });

    expect(exitCode).toBe(0);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: 'local-session',
      currentUserMessage: '/exit',
      character: {
        id: 'mira',
        displayName: 'Mira'
      }
    });
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.fixture',
          evidenceKind: 'session_end',
          status: 'accepted',
          summary: 'Session end observed.'
        }
      ],
      runtimePluginTurnEvidence: {
        evidence: [
          {
            pluginId: 'chat.session-end.fixture',
            evidenceKind: 'session_end',
            status: 'accepted',
            summary: 'Session end observed.'
          }
        ]
      }
    });
  });

  it('preserves an injected plugin host when configured plugin activation would fail', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-injected-host-'));
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'character-state': {
          config: {
            typoo: true
          }
        }
      }
    });
    const sessionId = 'injected-host-session';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const pluginHost = createRuntimePluginHost({
      plugins: [
        createSessionEndPlugin((context) => {
          sessionEndContexts.push(context);
        })
      ]
    });
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--config', configPath, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        pluginHost
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(sessionEndContexts).toHaveLength(1);

    const storedRawEvents = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    }).rawEvents();

    expect(storedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.fixture',
          evidenceKind: 'session_end',
          status: 'accepted',
          summary: 'Session end observed.'
        }
      ]
    });
  });

  it('constructs configured manifest-backed plugins once during chat startup', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-configured-host-'));
    const sessionId = 'configured-host-session';
    const configuredPlugin = createSessionEndPlugin(() => {});
    const sessionEndContexts: RuntimePluginContext[] = [];
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;

              return createSessionEndPlugin((context) => {
                sessionEndContexts.push(context);
              });
            }
          }
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(1);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: '/exit'
    });
  });

  it('closes configured plugins when a fatal chat turn exits before /exit', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-fatal-cleanup-'));
    const sessionId = 'fatal-cleanup-session';
    const configuredPlugin = createSessionEndPlugin(() => {}, {
      pluginId: 'chat.session-end.fatal-cleanup.fixture',
      requiredForTurn: true,
      beforeRoleModelCall() {
        throw new Error('configured before-role-model hook failed');
      }
    });
    const sessionEndContexts: RuntimePluginContext[] = [];
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const exitCode = await runChatCliFromArgs(
      ['--provider', 'local', '--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              return createSessionEndPlugin(
                (context) => {
                  sessionEndContexts.push(context);
                },
                {
                  pluginId: configuredPlugin.manifest.id,
                  requiredForTurn: true,
                  beforeRoleModelCall() {
                    throw new Error('configured before-role-model hook failed');
                  }
                }
              );
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('configured before-role-model hook failed');
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId
    });
    expect(sessionEndContexts[0]?.currentUserMessage).not.toBe('/exit');

    const storedRawEvents = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    }).rawEvents();

    expect(
      storedRawEvents.some((event) => event.payloadSummary?.rawInput === '/exit')
    ).toBe(false);
  });

  it('closes configured pre-session plugins read-only when later session creation fails', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-cleanup-'));
    const sessionId = 'pre-session-cleanup';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const configuredPlugin = createSessionEndPlugin(
      (context) => {
        sessionEndContexts.push(context);

        if (context.fileStore === undefined) {
          throw new Error('Expected startup cleanup context to include fileStore.');
        }

        try {
          context.fileStore.writeJsonAtomic('cleanup.json', {
            value: 'should-not-write'
          });
          cleanupWriteBlocked.push(false);
        } catch {
          cleanupWriteBlocked.push(true);
        }
      },
      {
        sideEffectLevel: 'local_memory_write',
        requestedApis: ['file_store']
      }
    );
    let factoryCalls = 0;
    let stdout = '';
    let stderr = '';

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-22T00:00:00.000Z'
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;

              return configuredPlugin;
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      `Local runtime session "${sessionId}" already exists.`
    );
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId
    });
    expect(sessionEndContexts[0]?.currentUserMessage).toContain(
      'chat startup failed'
    );
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(
      createRuntimePluginFileStore({
        storeRoot,
        sessionId,
        pluginId: configuredPlugin.manifest.id
      }).readJson('cleanup.json')
    ).toBeUndefined();
  });

  it('preserves formatted startup storage errors when cleanup file-store setup fails', async () => {
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-invalid-store-cleanup-')
    );
    const invalidStoreRoot = join(configRoot, 'store-root-file');
    const sessionId = 'invalid-store-cleanup';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const configuredPlugin = createSessionEndPlugin(
      (context) => {
        sessionEndContexts.push(context);
      },
      {
        sideEffectLevel: 'local_memory_write',
        requestedApis: ['file_store']
      }
    );
    let stdout = '';
    let stderr = '';

    writeFileSync(invalidStoreRoot, 'not a runtime store directory\n', 'utf8');
    const configPath = writeRuntimeConfig(join(configRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', invalidStoreRoot, '--config', configPath, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              return configuredPlugin;
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('Error: Local runtime store could not be read.\n');
    expect(sessionEndContexts).toHaveLength(0);
  });

  it('aborts manifest-backed factory construction failures before creating a durable session', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-factory-failure-'));
    const sessionId = 'manifest-factory-failure';
    const layout = createLocalRuntimeStorageLayout({ storeRoot });
    const configuredPlugin = createSessionEndPlugin(() => {});
    let factoryCalls = 0;
    let cleanupCalls = 0;
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;
              createSessionEndPlugin(() => {
                cleanupCalls += 1;
              });
              throw new Error('manifest-backed factory failed during construction');
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(cleanupCalls).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'Configured plugin construction failed before creating a durable session.'
    );
    expect(existsSync(layout.schemaPath)).toBe(false);
    expect(existsSync(layout.sessionCatalogPath)).toBe(false);
    expect(existsSync(layout.sessionsRoot)).toBe(false);
  });

  it('aborts config-enabled legacy function factories before creating a durable session', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-legacy-preflight-'));
    const sessionId = 'legacy-unchecked-session';
    const layout = createLocalRuntimeStorageLayout({ storeRoot });
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'legacy.required': {
          enabled: true
        }
      }
    });
    let factoryCalls = 0;
    let stdout = '';
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--config', configPath, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          'legacy.required': () => {
            factoryCalls += 1;
            throw new Error('legacy factory must not be constructed during preflight');
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_legacy_factory_unchecked');
    expect(stderr).toContain('plugins.legacy.required.enabled');
    expect(existsSync(layout.schemaPath)).toBe(false);
    expect(existsSync(layout.sessionCatalogPath)).toBe(false);
    expect(existsSync(layout.sessionsRoot)).toBe(false);
  });

  it('skips unselected legacy function factories during chat startup', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-legacy-unreferenced-')
    );
    const sessionId = 'legacy-unreferenced-session';
    const layout = createLocalRuntimeStorageLayout({ storeRoot });
    let factoryCalls = 0;
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          'legacy.optional': () => {
            factoryCalls += 1;
            throw new Error('unselected legacy plugin must not be constructed');
          }
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Mira is ready.');
    expect(existsSync(layout.sessionCatalogPath)).toBe(true);
  });

  it('aborts startup when configured plugin activation reports errors', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-activation-error-'));
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'character-state': {
          config: {
            typoo: true
          }
        }
      }
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--config', configPath, '--new-session', 'activation-error'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_unknown_plugin_config_field');
    expect(stderr).toContain('plugins.character-state.config.typoo');
    expect(stderr).toContain('Unknown config field "typoo" for plugin "character-state".');
  });

  it('persists session-end hook failures when stdin closes normally', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-session-end-'));
    const sessionId = 'session-end-failure';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-16T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [createFailingSessionEndPlugin()]
    });

    const exitCode = await runChatCli({
      stdin: Readable.from([]),
      stdout: collect(() => {}),
      stderr: collect(() => {}),
      session: createConversationSession({ id: sessionId }),
      logStore,
      pluginHost
    });

    expect(exitCode).toBe(0);

    const storedRawEvents = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    }).rawEvents();

    expect(storedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed_with_failures',
      payloadSummary: {
        rawInput: '/exit',
        normalizedCurrentUserMessage: '/exit'
      },
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.failure.fixture',
          evidenceKind: 'session_end',
          status: 'failed',
          summary: 'Session end fixture failed.'
        }
      ]
    });

    let stdout = '';
    const inspectExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', sessionId],
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
          readonly status: string;
          readonly pluginEvidence: {
            readonly evidence: readonly [
              {
                readonly pluginId: string;
                readonly evidenceKind: string;
                readonly status: string;
                readonly summary: string;
              }
            ];
          };
        }
      ];
    };

    expect(inspectExitCode).toBe(0);
    expect(output.turns[0]).toMatchObject({
      status: 'completed_with_failures',
      pluginEvidence: {
        evidence: [
          {
            pluginId: 'chat.session-end.failure.fixture',
            evidenceKind: 'session_end',
            status: 'failed',
            summary: 'Session end fixture failed.'
          }
        ]
      }
    });
  });
});

function createTextOnlyAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          text: 'folded model note',
          toolCalls: []
        })
      };
    }
  };
}

function createSessionEndPlugin(
  onSessionEnd: (context: RuntimePluginContext) => void,
  options: {
    readonly pluginId?: string;
    readonly beforeRoleModelCall?: NonNullable<
      RuntimePlugin['lifecycleHooks']['beforeRoleModelCall']
    >;
    readonly requiredForTurn?: boolean;
    readonly requestedApis?: RuntimePlugin['manifest']['requestedApis'];
    readonly sideEffectLevel?: RuntimePlugin['manifest']['runtimePolicy']['sideEffectLevel'];
    readonly defaultEnabled?: boolean;
  } = {}
): RuntimePlugin {
  const pluginId = options.pluginId ?? 'chat.session-end.fixture';
  const declaredPlugins: RuntimePlugin['manifest']['declaredPlugins'] =
    options.beforeRoleModelCall === undefined
      ? ['on_session_end']
      : ['before_role_model_call', 'on_session_end'];

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Chat Session End Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for chat session end lifecycle.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test'
      },
      declaredPlugins,
      config: {
        fields: []
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: options.requiredForTurn === true,
        sideEffectLevel: options.sideEffectLevel ?? 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall:
            options.requiredForTurn === true ? 'reject_turn' : 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: options.defaultEnabled ?? true,
        reasons: ['test']
      },
      requestedApis: options.requestedApis ?? []
    },
    providedTools: [],
    lifecycleHooks: {
      ...(options.beforeRoleModelCall === undefined
        ? {}
        : { beforeRoleModelCall: options.beforeRoleModelCall }),
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'session_end',
              status: 'accepted',
              summary: 'Session end observed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createFailingSessionEndPlugin(): RuntimePlugin {
  const pluginId = 'chat.session-end.failure.fixture';

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Chat Session End Failure Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for failed chat session end lifecycle.',
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
        defaultEnabled: true,
        reasons: ['test']
      },
      requestedApis: []
    },
    providedTools: [],
    lifecycleHooks: {
      onSessionEnd(context) {
        return {
          status: 'failed',
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'session_end',
              status: 'failed',
              summary: 'Session end fixture failed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
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

function writeRuntimeEnv(storeRoot: string, content: string): void {
  writeFileSync(
    createLocalRuntimeStorageLayout({ storeRoot }).envPath,
    content,
    'utf8'
  );
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
