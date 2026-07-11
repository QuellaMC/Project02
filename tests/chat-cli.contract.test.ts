import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createConversationSession
} from '../src/core/conversation.ts';
import {
  createRuntimePluginHost,
  runtimePluginDiscoveryPluginId
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
  createRuntimeLogStore,
  type RuntimeLogStore
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

describe('chat CLI trace summary', () => {
  it('keeps provider and terminal tool evidence when terminal persistence fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createTerminalRawEventAppendFailingLogStore(),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'hello from a failed terminal commit'
                  }
                }
              ]
            }),
            providerMetadata: {
              provider: 'nvidia',
              model: 'trace-fixture',
              request: {
                messageCount: 3,
                stream: false
              },
              response: {
                status: 200
              }
            }
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      provider: {
        name: 'nvidia',
        model: 'trace-fixture',
        responseStatus: 200
      },
      requestedToolCalls: ['visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply']
    });
  });

  it('does not classify an interrupted executable round as terminal', async () => {
    let adapterRound = 0;
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter: {
        invoke() {
          adapterRound += 1;

          if (adapterRound > 1) {
            throw new Error('provider failed before terminal output');
          }

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            }),
            providerMetadata: {
              provider: 'nvidia',
              model: 'trace-fixture',
              request: {
                messageCount: 3,
                stream: false
              },
              response: {
                status: 200
              }
            }
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      provider: {
        name: 'nvidia',
        model: 'trace-fixture',
        responseStatus: 200
      },
      requestedToolCalls: ['plugin.list'],
      executedToolCalls: ['plugin.list'],
      terminalToolCalls: []
    });
  });

  it('recovers requested calls from interim evidence when tool-start tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('tool_call_started'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'Checking the plugin inventory.'
                  }
                },
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            })
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['visible_reply', 'plugin.list'],
      executedToolCalls: [],
      terminalToolCalls: []
    });
  });

  it('keeps tool-only requested evidence when tool-start tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('tool_call_started'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            })
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['plugin.list'],
      executedToolCalls: [],
      terminalToolCalls: []
    });
  });

  it('keeps host-executed evidence when tool-finish tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('tool_call_finished'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            })
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['plugin.list'],
      executedToolCalls: ['plugin.list'],
      terminalToolCalls: []
    });
  });

  it('keeps interim requested evidence when interim tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore(
        'interim_visible_reply_emitted'
      ),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'Checking the plugin inventory.'
                  }
                },
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            })
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['visible_reply', 'plugin.list'],
      executedToolCalls: [],
      terminalToolCalls: []
    });
  });

  it('keeps final terminal evidence and a readable conversation when commit tracing fails', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-visible-trace-failure-')
    );
    const sessionId = 'visible-trace-failure';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-10T00:00:00.000Z'
    });
    const backingLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    let stderr = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      session: createConversationSession({ id: sessionId }),
      logStore: createToolTraceFailingLogStore(
        'visible_reply_committed',
        backingLogStore
      ),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'Final reply before trace failure.'
                  }
                }
              ]
            })
          };
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply']
    });

    const reopenedLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });

    expect(
      reopenedLogStore.conversationMessages().map((message) => message.text)
    ).toEqual(['hello', 'Final reply before trace failure.']);
    expect(reopenedLogStore.rawEvents().map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'visible_reply_committed',
        'runtime_turn_rejected'
      ])
    );
  });

  it('distinguishes requested, executed, and terminal tool calls for the whole turn', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        return {
          rawOutputText: JSON.stringify(
            adapterRound === 1
              ? {
                  toolCalls: [
                    {
                      name: 'plugin.list',
                      input: {}
                    },
                    {
                      name: 'visible_reply',
                      input: {
                        text: 'Checking the plugin inventory.'
                      }
                    },
                    {
                      name: 'character_state.patch',
                      input: {
                        mood: 'curious'
                      }
                    }
                  ]
                }
              : {
                  toolCalls: [
                    {
                      name: 'visible_reply',
                      input: {
                        text: 'The plugin inventory is available.'
                      }
                    }
                  ]
                }
          )
        };
      }
    };

    const exitCode = await runChatCli({
      stdin: Readable.from(['check plugins\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'completed',
      requestedToolCalls: [
        'plugin.list',
        'visible_reply',
        'character_state.patch',
        'visible_reply'
      ],
      executedToolCalls: ['plugin.list', 'character_state.patch'],
      terminalToolCalls: ['visible_reply']
    });
    expect(JSON.parse(stderr.trim())).not.toHaveProperty('toolCalls');
  });

  it('rejects undeclared calls before any routing attempt', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'memory.unknown',
                input: {
                  query: 'Mira'
                }
              }
            ]
          })
        };
      }
    };

    const exitCode = await runChatCli({
      stdin: Readable.from(['try an unavailable tool\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter
    });

    expect(exitCode).toBe(1);
    expect(adapterRound).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['memory.unknown'],
      executedToolCalls: [],
      terminalToolCalls: []
    });
  });

  it('does not count native argument validation failures as executed calls', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        if (adapterRound === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            }),
            nativeAssistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_invalid_plugin_list_args',
                  type: 'function',
                  function: {
                    name: 'plugin.list',
                    arguments: '{"score":1e999}'
                  }
                }
              ]
            },
            nativeToolCallArgumentErrors: [
              {
                executableIndex: 0,
                toolName: 'plugin.list',
                reason: 'invalid_native_tool_arguments',
                message:
                  'plugin.list arguments must contain finite JSON values.'
              }
            ]
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'The invalid arguments were rejected.'
                }
              }
            ]
          })
        };
      }
    };

    const exitCode = await runChatCli({
      stdin: Readable.from(['try invalid plugin arguments\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      requestedToolCalls: ['plugin.list', 'visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply']
    });
  });

  it('counts a host-dispatched rejection as an executed tool call', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              adapterRound === 1
                ? {
                    name: 'character_state.patch',
                    input: {
                      activity: 'reflecting'
                    }
                  }
                : {
                    name: 'visible_reply',
                    input: {
                      text: 'The invalid state patch was rejected.'
                    }
                  }
            ]
          })
        };
      }
    };

    const exitCode = await runChatCli({
      stdin: Readable.from(['try an invalid state patch\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      requestedToolCalls: ['character_state.patch', 'visible_reply'],
      executedToolCalls: ['character_state.patch'],
      terminalToolCalls: ['visible_reply']
    });
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

  it('uses an explicit store before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-chat-cwd-dotenv-error-'));
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-selected-dotenv-error-')
    );
    const sessionId = 'selected-store-before-cwd-dotenv';
    const previousCwd = process.cwd();
    const previousProvider = process.env[roleModelProviderEnvName];
    const previousApiKey = process.env[nvidiaApiKeyEnvName];
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      Reflect.deleteProperty(process.env, roleModelProviderEnvName);
      Reflect.deleteProperty(process.env, nvidiaApiKeyEnvName);
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      const exitCode = await runChatCliFromArgs(
        ['--store', storeRoot, '--new-session', sessionId],
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

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Mira is ready.');
      expect(stderr).toBe('');
      await expect(
        createLocalRuntimeSessionStore({ storeRoot }).readSession(sessionId)
      ).resolves.toMatchObject({
        sessionId
      });
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(roleModelProviderEnvName, previousProvider);
      restoreProcessEnvValue(nvidiaApiKeyEnvName, previousApiKey);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses a process-env selected runtime config before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-env-cwd-dotenv-error-')
    );
    const selectedStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-env-selected-store-')
    );
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-env-selected-config-')
    );
    const configPath = writeRuntimeConfig(
      join(configRoot, 'runtime-config.json'),
      {
        storeRoot: selectedStoreRoot
      }
    );
    const sessionId = 'env-selected-store-before-cwd-dotenv';
    const previousCwd = process.cwd();
    const previousProvider = process.env[roleModelProviderEnvName];
    const previousApiKey = process.env[nvidiaApiKeyEnvName];
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      Reflect.deleteProperty(process.env, roleModelProviderEnvName);
      Reflect.deleteProperty(process.env, nvidiaApiKeyEnvName);
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      const exitCode = await runChatCliFromArgs(
        ['--new-session', sessionId],
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

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Mira is ready.');
      expect(stderr).toBe('');
      await expect(
        createLocalRuntimeSessionStore({
          storeRoot: selectedStoreRoot
        }).readSession(sessionId)
      ).resolves.toMatchObject({
        sessionId
      });
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

  it('reports activation config errors before runtime env file errors', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-activation-before-env-')
    );
    const plugin = createRequiredConfigPlugin('chat.required-config');
    const layout = createLocalRuntimeStorageLayout({ storeRoot });
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });
    mkdirSync(layout.envPath);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'activation-before-env'],
      {
        stdin: Readable.from(['/exit\n']),
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
              throw new Error('chat startup should not construct invalid plugins');
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_required_value_missing');
    expect(stderr).toContain(`plugins.${plugin.manifest.id}.config.endpoint`);
    expect(stderr).not.toContain('Could not load runtime config env file');
    expect(existsSync(layout.sessionCatalogPath)).toBe(false);
    expect(existsSync(layout.sessionsRoot)).toBe(false);
  });

  it('loads runtime env before reporting mixed activation diagnostics', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-chat-mixed-activation-env-')
    );
    const plugin = createRequiredSecretAndConfigPlugin('chat.mixed-config');
    const layout = createLocalRuntimeStorageLayout({ storeRoot });
    const envVar = 'PROJECT02_CHAT_MIXED_SECRET_3452532128';
    let stdout = '';
    let stderr = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(layout.envPath, `${envVar}=chat-secret\n`, 'utf8');

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'mixed-activation-env'],
      {
        stdin: Readable.from(['/exit\n']),
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
              factoryCalls += 1;

              return plugin;
            }
          }
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_required_value_missing');
    expect(stderr).toContain(`plugins.${plugin.manifest.id}.config.endpoint`);
    expect(stderr).not.toContain('runtime_config_required_secret_missing');
    expect(stderr).not.toContain(`plugins.${plugin.manifest.id}.config.apiKey`);
  });
});

describe('chat CLI plugin lifecycle', () => {
  it('runs session-end hooks when /exit closes the chat', async () => {
    const sessionEndContexts: RuntimePluginContext[] = [];
    const logStore = createRuntimeLogStore();
    const sessionEndPlugin = createSessionEndPlugin((context) => {
      sessionEndContexts.push(context);
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [sessionEndPlugin],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        sessionEndPlugin.manifest.id
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
    const sessionEndPlugin = createSessionEndPlugin((context) => {
      sessionEndContexts.push(context);
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [sessionEndPlugin],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        sessionEndPlugin.manifest.id
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
        requestedAccess: { file_store: 'write', turn_context: 'read' }
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
        requestedAccess: { file_store: 'write', turn_context: 'read' }
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
      plugins: [createFailingSessionEndPlugin()],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        'chat.session-end.failure.fixture'
      ]
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
    readonly requestedAccess?: RuntimePlugin['manifest']['requestedAccess'];
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
      requestedAccess: options.requestedAccess ?? { turn_context: 'read' }
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
      requestedAccess: {}
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

function createRequiredConfigPlugin(pluginId: string): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Required Config Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin with required non-secret config.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test'
      },
      declaredPlugins: ['on_session_end'],
      config: {
        fields: [
          {
            name: 'endpoint',
            description: 'Required endpoint.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: []
          }
        ]
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
        reasons: ['test']
      },
      requestedAccess: {}
    },
    providedTools: [],
    lifecycleHooks: {
      onSessionEnd() {
        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function createRequiredSecretAndConfigPlugin(pluginId: string): RuntimePlugin {
  const plugin = createRequiredConfigPlugin(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'apiKey',
            description: 'Required API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret']
          }
        ]
      }
    },
    providedTools: plugin.providedTools,
    lifecycleHooks: plugin.lifecycleHooks
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

function createTerminalRawEventAppendFailingLogStore(): RuntimeLogStore {
  const logStore = createRuntimeLogStore();

  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'runtime_turn_completed') {
        throw new Error('terminal raw event append failed');
      }

      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createToolTraceFailingLogStore(
  failingStep:
    | 'interim_visible_reply_emitted'
    | 'tool_call_started'
    | 'tool_call_finished'
    | 'visible_reply_committed',
  logStore: RuntimeLogStore = createRuntimeLogStore()
): RuntimeLogStore {
  return Object.freeze({
    ...(logStore.localRuntimeSessionPaths === undefined
      ? {}
      : { localRuntimeSessionPaths: logStore.localRuntimeSessionPaths }),
    appendTrace(entry) {
      if (entry.step === failingStep) {
        throw new Error(`${failingStep} trace append failed`);
      }

      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}
