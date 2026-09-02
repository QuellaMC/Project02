import {describe, expect, it} from 'vitest';

import {createConfirmationPrompts} from '../../src/cli/chat/prompts.ts';
import type {PendingConfirmation} from '../../src/gateway/index.ts';
import {collect} from '../support/streams.ts';

function pending(id: string, characterId = 'mira'): PendingConfirmation {
  return {
    characterId,
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
    characterId: 'mira',
    lines: {
      promptLine: signal =>
        new Promise(resolve => {
          reads.push({resolve});
          signal?.addEventListener('abort', () => {
            resolve(undefined);
          });
        }),
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
    shown: () => (stdout.match(/\[y\/N\]/gu) ?? []).length,
  };
}

describe('chat confirmation prompts', () => {
  it('asks once per request, for this character only, and answers from the line it reads', async () => {
    const harness = createHarness();

    harness.prompts.ask(pending('one'));
    harness.prompts.ask(pending('one'));
    harness.prompts.ask(pending('other', 'zeta'));
    await new Promise(resolve => setImmediate(resolve));

    expect(harness.shown()).toBe(1);
    harness.reads[0]?.resolve('y');
    await harness.prompts.idle();
    expect(harness.answers).toEqual(['one:approved']);
  });

  it('says so when the daemon did not take the answer', async () => {
    const harness = createHarness('expired');

    harness.prompts.ask(pending('late'));
    await new Promise(resolve => setImmediate(resolve));
    harness.reads[0]?.resolve('y');
    await harness.prompts.idle();

    expect(harness.answers).toEqual(['late:approved']);
    expect(harness.stdout()).toContain(
      'demo_tool was not approved: the confirmation had expired.',
    );
  });

  it('asks again on the next handshake when the daemon never heard the answer', async () => {
    const harness = createHarness('unreachable');

    harness.prompts.ask(pending('lost'));
    await new Promise(resolve => setImmediate(resolve));
    harness.reads[0]?.resolve('y');
    await harness.prompts.idle();

    expect(harness.stderr()).toContain('could not be reached');

    // The pending list still holds it: it is asked once more.
    harness.prompts.reconcile([pending('lost')]);
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.shown()).toBe(2);
  });

  it('retires what the pending list no longer holds, showing or queued', async () => {
    const harness = createHarness();

    harness.prompts.ask(pending('showing'));
    harness.prompts.ask(pending('queued'));
    harness.prompts.ask(pending('kept'));
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.shown()).toBe(1);

    harness.prompts.reconcile([pending('kept')]);
    await new Promise(resolve => setImmediate(resolve));

    // "showing" was withdrawn, "queued" never showed, "kept" is up now.
    expect(harness.stdout()).toContain('demo_tool was settled elsewhere.');
    expect(harness.shown()).toBe(2);
    harness.reads[1]?.resolve('n');
    await harness.prompts.idle();
    expect(harness.answers).toEqual(['kept:denied']);
  });

  it('withdraws a showing prompt settled elsewhere and never shows a queued one', async () => {
    const harness = createHarness();

    harness.prompts.ask(pending('showing'));
    harness.prompts.ask(pending('queued'));
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.shown()).toBe(1);

    harness.prompts.settle('queued', 'denied');
    harness.prompts.settle('showing', 'approved');
    await harness.prompts.idle();

    expect(harness.shown()).toBe(1);
    expect(harness.stdout()).toContain('demo_tool was approved elsewhere.');
    expect(harness.answers).toEqual([]);
    expect(harness.stderr()).toBe('');
  });
});
