import {describe, expect, it} from 'vitest';

import {jsonArray, jsonRecord} from '../support/json-view.ts';

import {createSessionHistoryReadOutput} from '../../src/plugins/packages/session-history/read.ts';
import {
  centeredSnippet,
  createSessionHistorySearchOutput,
} from '../../src/plugins/packages/session-history/search.ts';
import type {RuntimePluginSessionHistoryMessage} from '../../src/plugins/api/session-history-contract.ts';
import type {SessionIndexSessionView} from '../../src/plugins/packages/session-history/engine/index.ts';
import {createJsonBoundarySnapshot} from '../../src/shared/json-boundary.ts';

describe('session history output shaping', () => {
  it('centers snippets on the match with ellipses', () => {
    const text = `${'a'.repeat(300)} anchovy pizza ${'b'.repeat(300)}`;
    const snippet = centeredSnippet(text, 'anchovy', 160);

    expect(snippet.length).toBeLessThanOrEqual(160);
    expect(snippet).toContain('anchovy');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);

    expect(centeredSnippet('short text', 'short', 160)).toBe('short text');

    // A query FTS matched but substring cannot locate falls back to the head.
    const fallback = centeredSnippet('c'.repeat(300), 'absent', 160);

    expect(fallback.length).toBeLessThanOrEqual(160);
    expect(fallback.endsWith('...')).toBe(true);
  });

  it('bounds message text and flags the matched message', () => {
    const view = sessionView({
      matchText: `${'x'.repeat(250)} narwhal fact ${'y'.repeat(250)}`,
    });
    const output = createSessionHistorySearchOutput({
      result: {
        sessions: [view],
        totalSessionsWithHits: 4,
        damagedRecordCount: 2,
      },
      query: 'narwhal',
    });

    expect(output).toMatchObject({
      totalSessionsWithHits: 4,
      damagedRecordsSkipped: 2,
    });

    const sessions = jsonArray(jsonRecord(output)['sessions']);

    expect(sessions).toHaveLength(1);
    expect(jsonRecord(sessions[0])['sessionId']).toBe('s1');

    const matchedRows = jsonArray(jsonRecord(sessions[0])['aroundMatch'])
      .map(row => jsonRecord(row))
      .filter(row => row['matched'] === true);

    expect(matchedRows).toHaveLength(1);
    expect(String(matchedRows[0]?.['snippet'])).toContain('narwhal');
    expect(String(matchedRows[0]?.['text']).length).toBeLessThanOrEqual(200);
  });

  it('stores no half of a surrogate pair where it cuts text or a snippet', () => {
    const emoji = '😀'.repeat(150);
    const output = createSessionHistorySearchOutput({
      result: {
        sessions: [sessionView({matchText: `${emoji} narwhal ${emoji}`})],
        totalSessionsWithHits: 1,
        damagedRecordCount: 0,
      },
      query: 'narwhal',
    });

    // JSON writes a lone half as an escape, `\udXXX`; a whole pair as is.
    expect(JSON.stringify(output)).not.toMatch(/\\ud[89a-f]/u);
  });

  it('maps read windows with paging flags', () => {
    const output = createSessionHistoryReadOutput({
      sessionId: 's1',
      conversation: {
        messages: [message(1, 'z'.repeat(900))],
        hasBefore: true,
        hasAfter: false,
        damagedRecordCount: 1,
      },
    });

    expect(output).toMatchObject({
      sessionId: 's1',
      hasBefore: true,
      hasAfter: false,
      damagedRecordsSkipped: 1,
    });

    const texts = jsonArray(jsonRecord(output)['messages']).map(row =>
      String(jsonRecord(row)['text']),
    );

    expect(texts[0]?.length).toBeLessThanOrEqual(400);
  });

  it('stays inside the JSON boundary at multi-byte worst case', () => {
    // The boundary THROWS on overflow (surfacing as handler_failed), so the
    // caps are proven here against 3-byte UTF-8 text at maximum fan-out.
    const cjk = '测'.repeat(1_000);
    const fullView = sessionView({matchText: cjk, fillerText: cjk});
    const searchOutput = createSessionHistorySearchOutput({
      result: {
        sessions: [fullView, fullView, fullView, fullView, fullView],
        totalSessionsWithHits: 5,
        damagedRecordCount: 0,
      },
      query: '测测测',
    });

    expect(() =>
      createJsonBoundarySnapshot(searchOutput, {
        field: 'session history search output',
        redact: true,
      }),
    ).not.toThrow();

    const readOutput = createSessionHistoryReadOutput({
      sessionId: 's1',
      conversation: {
        messages: Array.from({length: 31}, (_, index) => message(index, cjk)),
        hasBefore: true,
        hasAfter: true,
        damagedRecordCount: 0,
      },
    });

    expect(() =>
      createJsonBoundarySnapshot(readOutput, {
        field: 'session history read output',
        redact: true,
      }),
    ).not.toThrow();
  });
});

function message(
  ordinal: number,
  text: string,
): RuntimePluginSessionHistoryMessage {
  return {
    sessionId: 's1',
    messageId: `s1:message-${String(ordinal)}`,
    role: ordinal % 2 === 0 ? 'user' : 'character',
    speakerName: 'Speaker'.repeat(20),
    text,
    committedAt: '2026-07-16T01:00:00.000Z',
  };
}

function sessionView(options: {
  readonly matchText: string;
  readonly fillerText?: string;
}): SessionIndexSessionView {
  const filler = options.fillerText ?? 'filler';

  return {
    sessionId: 's1',
    bookendStart: [message(0, filler), message(1, filler)],
    window: [
      message(2, filler),
      message(3, filler),
      message(4, filler),
      message(5, options.matchText),
      message(6, filler),
      message(7, filler),
      message(8, filler),
    ],
    bookendEnd: [message(9, filler), message(10, filler)],
    matchMessageId: 's1:message-5',
  } satisfies SessionIndexSessionView;
}
