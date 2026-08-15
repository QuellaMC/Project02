import {describe, expect, it} from 'vitest';

import {
  capSummaryText,
  maxFallbackSummaryChars,
  mechanicalSummary,
  selectSessionContinuation,
  serializeTurnsForSummarizer,
} from '../../src/runtime/turn/compaction-policy.ts';
import {maxContextSummaryChars} from '../../src/runtime/evidence/records.ts';
import type {ConversationTurn} from '../../src/role-model/index.ts';

function turn(
  index: number,
  text = `question ${String(index)}`,
): ConversationTurn {
  return {
    eventId: `evt_${String(index)}`,
    traceId: `trace_${String(index)}`,
    createdAt: `2026-06-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    userMessage: {
      id: `s:message-${String(index * 2 - 1)}`,
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text,
    },
    toolRounds: [],
    finalReplies: [
      {
        id: `s:message-${String(index * 2)}`,
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: `answer ${String(index)}`,
      },
    ],
  };
}

describe('session continuation policy', () => {
  it('continues only once the history window would drop a turn, carrying the newest', () => {
    const turns = [turn(1), turn(2), turn(3), turn(4)];

    expect(
      selectSessionContinuation(turns, {contextWindowTokens: 32768}),
    ).toBeUndefined();

    // ~21 estimated tokens per turn: a 100-token window replays two turns
    // and would drop the older two; a quarter of it carries exactly one.
    const selection = selectSessionContinuation(turns, {
      contextWindowTokens: 100,
    });

    expect(selection?.summarized.map(item => item.eventId)).toEqual([
      'evt_1',
      'evt_2',
      'evt_3',
    ]);
    expect(selection?.carried.map(item => item.eventId)).toEqual(['evt_4']);
  });

  it('serialises turns for the summariser with speakers, days, tools, and shortened lines', () => {
    const withTool: ConversationTurn = {
      ...turn(2),
      toolRounds: [
        {
          round: 1,
          interimReplies: [],
          toolCalls: [
            {
              toolCallId: 'call-1',
              pluginId: 'session-history',
              toolName: 'sessions.search',
              input: {query: 'hike'},
              result: {status: 'rejected', reason: 'busy', message: 'later'},
            },
          ],
        },
      ],
    };
    const text = serializeTurnsForSummarizer({
      turns: [turn(1, 'x'.repeat(2_000)), withTool],
      previousSummary: 'We had talked about tea.',
      userDisplayName: 'Mike',
      contextWindowTokens: 32768,
    });

    expect(
      text.startsWith('<existing_summary>\nWe had talked about tea.\n'),
    ).toBe(true);
    expect(text).toContain('[2026-06-11]\nMike: ');
    expect(text).toContain('chars omitted');
    expect(text).toContain('[tool call sessions.search] {"query":"hike"}');
    expect(text).toContain('[tool result sessions.search] rejected: later');
    expect(text).toContain('Mira: answer 2');
    expect(text.endsWith('</conversation>')).toBe(true);
    // A tiny window drops the oldest lines and says so.
    expect(
      serializeTurnsForSummarizer({
        turns: [turn(1), turn(2), turn(3)],
        contextWindowTokens: 40,
      }),
    ).toContain('earlier lines omitted');
  });

  it('caps model summaries at a sentence boundary and treats blank output as none', () => {
    expect(capSummaryText('   ')).toBeUndefined();
    expect(capSummaryText(' Short. ')).toBe('Short.');
    const long = `${'A sentence here. '.repeat(400)}tail`;
    const capped = capSummaryText(long) ?? '';

    expect(capped.length).toBeLessThanOrEqual(maxContextSummaryChars);
    expect(capped.endsWith('.')).toBe(true);
  });

  it('writes a mechanical summary that keeps a prior summary within the cap', () => {
    const summary = mechanicalSummary({
      summarized: [turn(1), turn(2), turn(3)],
      previousSummary: 'p'.repeat(maxContextSummaryChars),
      userDisplayName: 'Mike',
    });

    expect(summary.length).toBeLessThanOrEqual(maxContextSummaryChars);
    expect(summary).toContain(
      'Earlier conversation (3 turns, 2026-06-11 to 2026-06-13)',
    );
    expect(summary).toContain(
      'Most recent things Mike said there: “question 1” · “question 2” · “question 3”.',
    );
    expect(summary.split('\n\n')[1]?.length).toBeLessThanOrEqual(
      maxFallbackSummaryChars,
    );
  });
});
