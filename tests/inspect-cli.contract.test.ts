import { mkdtempSync } from 'node:fs';
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
          readonly modelRounds: readonly unknown[];
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
    expect(output.turns[0].toolEvents[0].pluginId).toBe('character-state');
    expect(output.turns[0].pluginEvidence.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'character-state',
          evidenceKind: 'after_turn_committed',
          status: 'accepted'
        })
      ])
    );
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
