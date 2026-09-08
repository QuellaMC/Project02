import {describe, expect, it, vi} from 'vitest';

import {createConfirmationPrompts} from '../../src/cli/chat/prompts.ts';
import type {PendingConfirmation} from '../../src/gateway/api/index.ts';
import {collect} from '../support/streams.ts';

function pending(id: string): PendingConfirmation {
  return {
    characterId: 'mira',
    id,
    request: {
      pluginId: 'demo.plugin',
      toolName: 'demo_tool',
      summary: 'Do the thing',
      preview: {},
    },
    deadlineAt: Date.now() + 60_000,
  };
}

function createHarness(
  taken: 'answered' | 'expired' | 'unknown' | 'unreachable' = 'answered',
) {
  let stdout = '';
  let stderr = '';
  let closed = false;
  const answers: string[] = [];
  const reads: {resolve(line: string | undefined): void}[] = [];
  const prompts = createConfirmationPrompts({
    client: {
      answerConfirmation(id, decision) {
        answers.push(`${id}:${decision}`);

        return taken === 'unreachable'
          ? Promise.reject(new Error('The daemon could not be reached.'))
          : Promise.resolve({status: taken});
      },
    },
    lines: {
      promptLine: signal =>
        new Promise(resolve => {
          reads.push({resolve});
          signal?.addEventListener('abort', () => {
            resolve(undefined);
          });
        }),
      close() {
        closed = true;
      },
    },
    stdout: collect(chunk => {
      stdout += chunk;
    }),
    stderr: collect(chunk => {
      stderr += chunk;
    }),
  });

  return {
    prompts,
    answers,
    reads,
    stdout: () => stdout,
    stderr: () => stderr,
    closed: () => closed,
    shown: () => (stdout.match(/\[y\/N\]/gu) ?? []).length,
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('chat confirmation prompts', () => {
  it('asks once per request and answers from the line it reads', async () => {
    const harness = createHarness();

    harness.prompts.ask(pending('one'));
    harness.prompts.ask(pending('one'));
    await tick();
    expect(harness.shown()).toBe(1);

    harness.reads[0]?.resolve('y');
    await harness.prompts.idle();
    expect(harness.answers).toEqual(['one:approved']);
  });

  it('says so when the daemon did not take the answer, and lets a lost answer be asked again', async () => {
    const expired = createHarness('expired');

    expired.prompts.ask(pending('late'));
    await tick();
    expired.reads[0]?.resolve('y');
    await expired.prompts.idle();
    expect(expired.stdout()).toContain(
      'demo_tool was not approved: the confirmation had expired.',
    );

    // Unknown to the daemon is settled already — maybe by this terminal's
    // own earlier answer whose reply was lost — never a refusal.
    const unknown = createHarness('unknown');

    unknown.prompts.ask(pending('gone'));
    await tick();
    unknown.reads[0]?.resolve('y');
    await unknown.prompts.idle();
    expect(unknown.stdout()).toContain(
      'demo_tool was settled before this answer.',
    );
    expect(unknown.stdout()).not.toContain('was not approved');

    const lost = createHarness('unreachable');
    let idle = false;

    lost.prompts.ask(pending('lost'));
    void lost.prompts.idle().then(() => {
      idle = true;
    });
    await tick();
    lost.reads[0]?.resolve('y');
    await vi.waitFor(() => {
      expect(lost.stderr()).toContain('could not be reached');
    });
    // Asked again at once; a handshake listing it adds no third prompt,
    // and a REPL waiting for the chain keeps waiting through the retry.
    await tick();
    expect(lost.shown()).toBe(2);
    lost.prompts.reconcile([pending('lost')]);
    await tick();
    expect(lost.shown()).toBe(2);
    expect(idle).toBe(false);

    // Leaving at the prompt: one denial, said once, and the terminal goes,
    // whether or not the daemon heard it.
    lost.reads[1]?.resolve('/exit');
    await lost.prompts.idle();
    expect(lost.answers).toEqual(['lost:approved', 'lost:denied']);
    expect(lost.closed()).toBe(true);
    expect(lost.shown()).toBe(2);
    expect(idle).toBe(true);

    // Once the input ended nobody can answer again: the denial is tried
    // once, and the chain settles instead of asking into the void.
    const ended = createHarness('unreachable');

    ended.prompts.ask(pending('eof'));
    await tick();
    ended.reads[0]?.resolve(undefined);
    await ended.prompts.idle();
    expect(ended.answers).toEqual(['eof:denied']);
    expect(ended.shown()).toBe(1);
  });

  it('withdraws a showing prompt settled meanwhile, and retires what a handshake no longer lists', async () => {
    const harness = createHarness();

    harness.prompts.ask(pending('showing'));
    harness.prompts.ask(pending('queued'));
    await tick();
    expect(harness.shown()).toBe(1);

    // Settled elsewhere while showing, and gone from the daemon's list
    // while queued: the first is withdrawn, the second never shows.
    harness.prompts.settle('showing');
    harness.prompts.reconcile([]);
    await harness.prompts.idle();
    expect(harness.stdout()).toContain('demo_tool was settled meanwhile.');
    expect(harness.shown()).toBe(1);
    expect(harness.answers).toEqual([]);
  });
});
