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
import { runtimeConfigVersion } from '../src/runtime/config/index.ts';

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

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: runtimeConfigVersion,
          storeRoot,
          plugins: {
            'unknown-plugin': {
              enabled: true
            },
            'character-state': {
              enabled: false
            }
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );
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

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
