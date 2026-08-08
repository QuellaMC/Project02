import type {RuntimePluginSessionHistoryMessage} from '../../api/session-history-contract.ts';
import type {
  SessionHistoryEngine,
  SessionIndexSearchResult,
  SessionIndexSessionView,
} from './engine/index.ts';
import {
  sessionHistoryPluginId,
  sessionHistorySearchToolName,
} from '../../api/contract.ts';
import {createPluginToolEvidence} from '../../api/evidence-helpers.ts';
import type {
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';
import {boundedText} from '../../api/bounded-text.ts';

export const sessionHistorySessionIdPattern =
  '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';

const sessionHistorySearchDefaultSessionLimit = 3;
// Output stays far inside the JSON boundary (64 KiB total string bytes,
// which THROWS on overflow): 5 sessions x ~10 messages x 200 UTF-16 units
// is ~30 KB at the 3-byte UTF-8 worst case.
const sessionHistoryMessageTextLength = 200;
const sessionHistorySnippetLength = 160;
const sessionHistorySpeakerNameLength = 80;

export function createSessionHistorySearchTool(): RuntimePluginProvidedTool {
  return {
    name: sessionHistorySearchToolName,
    description:
      "Search this character's past conversation sessions. Use it whenever " +
      'the user references an earlier conversation or relevant ' +
      'cross-session context may exist, before asking them to repeat ' +
      'themselves. The query is matched as literal text (no operators). ' +
      'Messages you can currently see never match, so results always add ' +
      'to your context, including older parts of this conversation. Each ' +
      'matching session returns its opening messages, a window around the ' +
      'best match, and its closing messages; scroll further with ' +
      'sessions.read.',
    inputContract: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Literal text to find in past messages.',
        },
        sessionId: {
          type: 'string',
          pattern: sessionHistorySessionIdPattern,
          description: 'Restrict the search to one session.',
        },
        sessionLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Maximum sessions to return (default 3).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    concurrency: 'shared',
    requiresConfirmation: false,
  };
}

export async function handleSessionHistorySearchToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly engine: SessionHistoryEngine;
}): Promise<RuntimePluginToolCallResult> {
  const input = options.call.input;
  const query = typeof input['query'] === 'string' ? input['query'] : '';
  const sessionId =
    typeof input['sessionId'] === 'string' ? input['sessionId'] : undefined;
  const sessionLimit =
    typeof input['sessionLimit'] === 'number'
      ? input['sessionLimit']
      : sessionHistorySearchDefaultSessionLimit;
  // Recall complements the context window: messages the model already
  // sees never match, so search reaches older parts of any session,
  // including this one, without echoing the words in front of it.
  const result = await options.engine.search({
    query,
    sessionLimit,
    ...(sessionId === undefined ? {} : {sessionId}),
    excludeMessageIds: options.context.recentVisibleMessageIds,
    signal: options.context.signal,
  });
  const output = createSessionHistorySearchOutput({result, query});

  return {
    status: 'accepted',
    output,
    evidence: [
      createPluginToolEvidence({
        context: options.context,
        pluginId: sessionHistoryPluginId,
        status: 'accepted',
        summary:
          `Returned ${String(result.sessions.length)} of ` +
          `${String(result.totalSessionsWithHits)} matching session(s).`,
      }),
    ],
  };
}

export function createSessionHistorySearchOutput(options: {
  readonly result: SessionIndexSearchResult;
  readonly query: string;
}): RuntimePluginJsonObject {
  return Object.freeze({
    sessions: Object.freeze(
      options.result.sessions.map(view =>
        sessionHistorySessionViewOutput(view, options.query),
      ),
    ),
    totalSessionsWithHits: options.result.totalSessionsWithHits,
    damagedRecordsSkipped: options.result.damagedRecordCount,
  } satisfies RuntimePluginJsonObject);
}

function sessionHistorySessionViewOutput(
  view: SessionIndexSessionView,
  query: string,
): RuntimePluginJsonValue {
  return Object.freeze({
    sessionId: view.sessionId,
    conversationStart: Object.freeze(
      view.bookendStart.map(message => sessionHistoryMessageOutput(message)),
    ),
    aroundMatch: Object.freeze(
      view.window.map(message =>
        message.messageId === view.matchMessageId
          ? sessionHistoryMatchedMessageOutput(message, query)
          : sessionHistoryMessageOutput(message),
      ),
    ),
    conversationEnd: Object.freeze(
      view.bookendEnd.map(message => sessionHistoryMessageOutput(message)),
    ),
  } satisfies RuntimePluginJsonValue);
}

export function sessionHistoryMessageOutput(
  message: RuntimePluginSessionHistoryMessage,
  textLength = sessionHistoryMessageTextLength,
): RuntimePluginJsonObject {
  return Object.freeze({
    messageId: message.messageId,
    role: message.role,
    speakerName: boundedText(
      message.speakerName,
      sessionHistorySpeakerNameLength,
    ),
    committedAt: message.committedAt,
    text: boundedText(message.text, textLength),
  } satisfies RuntimePluginJsonObject);
}

function sessionHistoryMatchedMessageOutput(
  message: RuntimePluginSessionHistoryMessage,
  query: string,
): RuntimePluginJsonObject {
  return Object.freeze({
    ...sessionHistoryMessageOutput(message),
    matched: true,
    snippet: centeredSnippet(message.text, query, sessionHistorySnippetLength),
  } satisfies RuntimePluginJsonObject);
}

/** The snippet centers on the first query occurrence when one exists. */
export function centeredSnippet(
  text: string,
  query: string,
  maxLength: number,
): string {
  if (text.length <= maxLength) {
    return text;
  }

  const matchStart = text.toLowerCase().indexOf(query.trim().toLowerCase());

  if (matchStart <= 0) {
    return boundedText(text, maxLength);
  }

  const coreLength = maxLength - 6;
  const start = Math.min(
    Math.max(0, matchStart - Math.floor(coreLength / 2)),
    Math.max(0, text.length - coreLength),
  );
  const end = start + coreLength;

  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${
    end < text.length ? '...' : ''
  }`;
}
