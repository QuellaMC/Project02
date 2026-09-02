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

function createHarness() {
  let stdout = '';
  let stderr = '';
  const answers: string[] = [];
  const reads: {resolve(line: string | undefined): void}[] = [];
  const prompts = createConfirmationPrompts({
    client: {
      answerConfirmation(id, decision) {
        answers.push(`${id}:${decision}`);

        return Promise.resolve({status: 'answered' as const});
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
