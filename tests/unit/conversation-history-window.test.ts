import {describe, expect, it} from 'vitest';

import {
  conversationTurnToChatMessages,
  estimateConversationTurnTokens,
  selectConversationHistoryWindow,
  type ConversationTurn,
} from '../../src/role-model/index.ts';

function turn(index: number, replyText: string): ConversationTurn {
  return {
    eventId: `evt_${String(index)}`,
    traceId: `trace_${String(index)}`,
    createdAt: `2026-06-15T00:00:0${String(index)}.000Z`,
    userMessage: {
      id: `s:message-${String(index * 2 - 1)}`,
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: `question ${String(index)}`,
    },
    toolRounds: [],
    finalReplies: [
      {
        id: `s:message-${String(index * 2)}`,
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: replyText,
      },
    ],
  };
}

describe('conversation history window', () => {
  it('keeps the newest whole turns that fit half the context window, oldest first', () => {
    const turns = [turn(1, 'one'), turn(2, 'two'), turn(3, 'three')];
    const perTurn = estimateConversationTurnTokens(
      turns[0] as ConversationTurn,
    );
    // Half the window admits two turns' worth, never a third.
    const contextWindowTokens = perTurn * 2 * 2 + 2;

    const selected = selectConversationHistoryWindow(turns, {
      contextWindowTokens,
    });

    expect(selected.map(item => item.eventId)).toEqual(['evt_2', 'evt_3']);
  });

  it('never splits a turn: an oversized newest turn leaves the window empty', () => {
    const turns = [turn(1, 'short'), turn(2, 'x'.repeat(2_000))];

    expect(
      selectConversationHistoryWindow(turns, {contextWindowTokens: 64}),
    ).toEqual([]);
  });

  it('stays contiguous: an older turn is never admitted past one that did not fit', () => {
    const turns = [
      turn(1, 'short'),
      turn(2, 'x'.repeat(2_000)),
      turn(3, 'short'),
    ];
    const short = estimateConversationTurnTokens(turn(3, 'short'));

    expect(
      selectConversationHistoryWindow(turns, {
        contextWindowTokens: short * 2 * 2 + 2,
      }).map(item => item.eventId),
    ).toEqual(['evt_3']);
  });

  it('rejects a context window that is not a positive whole number', () => {
    for (const contextWindowTokens of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        selectConversationHistoryWindow([], {contextWindowTokens}),
      ).toThrow(
        'contextWindowTokens must be a positive whole number of tokens.',
      );
    }
  });

  it("replays a tool round as the model's text and interim replies, its calls, and the results", () => {
    const withTools: ConversationTurn = {
      ...turn(1, 'done'),
      toolRounds: [
        {
          round: 1,
          text: 'let me look',
          interimReplies: [
            {
              id: 's:message-2',
              role: 'character',
              speakerId: 'mira',
              speakerName: 'Mira',
              text: 'checking',
            },
          ],
          toolCalls: [
            {
              toolCallId: 'call-1',
              pluginId: 'runtime',
              toolName: 'runtime.plugin.list',
              input: {},
              result: {status: 'accepted', output: {plugins: []}},
            },
          ],
        },
      ],
    };

    expect(conversationTurnToChatMessages(withTools)).toEqual([
      {role: 'user', content: 'question 1'},
      {
        role: 'assistant',
        content: 'let me look\n\nchecking',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {name: 'runtime.plugin.list', arguments: '{}'},
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content:
          '{"status":"accepted","pluginId":"runtime","toolName":"runtime.plugin.list","output":{"plugins":[]}}',
      },
      {role: 'assistant', content: 'done'},
    ]);
    expect(
      JSON.stringify(conversationTurnToChatMessages(withTools)),
    ).not.toContain('visible_reply');
  });
});
