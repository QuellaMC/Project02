import {
  sessionHistoryPluginId,
  sessionHistoryReadToolName,
} from '../../api/contract.ts';
import {createPluginToolEvidence} from '../../api/evidence-helpers.ts';
import type {
  SessionHistoryEngine,
  SessionIndexConversationWindow,
} from './engine/index.ts';
import type {
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';
import {
  sessionHistoryMessageOutput,
  sessionHistorySessionIdPattern,
} from './search.ts';

const sessionHistoryReadDefaultWindow = 8;
// 2x15+1 messages x 400 UTF-16 units stays inside the JSON boundary at the
// 3-byte UTF-8 worst case (~37 KB of 64 KiB).
const sessionHistoryReadTextLength = 400;

export function createSessionHistoryReadTool(): RuntimePluginProvidedTool {
  return {
    name: sessionHistoryReadToolName,
    description:
      'Read a window of messages from one past session, oldest-first. ' +
      'Without anchorMessageId it returns the latest messages. To scroll, ' +
      'pass a returned messageId as anchorMessageId to get the messages ' +
      'around it; hasBefore and hasAfter say whether more exist beyond the ' +
      'window.',
    inputContract: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          pattern: sessionHistorySessionIdPattern,
          description: 'The session to read, from sessions.search results.',
        },
        anchorMessageId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Center the window on this messageId.',
        },
        window: {
          type: 'integer',
          minimum: 1,
          maximum: 15,
          description: 'Messages on each side of the anchor (default 8).',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    concurrency: 'shared',
    requiresConfirmation: false,
  };
}

export async function handleSessionHistoryReadToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly engine: SessionHistoryEngine;
}): Promise<RuntimePluginToolCallResult> {
  const input = options.call.input;
  const sessionId =
    typeof input['sessionId'] === 'string' ? input['sessionId'] : '';
  const anchorMessageId =
    typeof input['anchorMessageId'] === 'string'
      ? input['anchorMessageId']
      : undefined;
  const window =
    typeof input['window'] === 'number'
      ? input['window']
      : sessionHistoryReadDefaultWindow;
  const conversation = await options.engine.readAround({
    sessionId,
    window,
    ...(anchorMessageId === undefined ? {} : {anchorMessageId}),
    signal: options.context.signal,
  });
  const output = createSessionHistoryReadOutput({conversation, sessionId});

  return {
    status: 'accepted',
    output,
    evidence: [
      createPluginToolEvidence({
        context: options.context,
        pluginId: sessionHistoryPluginId,
        status: 'accepted',
        summary: `Returned ${String(conversation.messages.length)} message(s) from one session.`,
      }),
    ],
  };
}

export function createSessionHistoryReadOutput(options: {
  readonly conversation: SessionIndexConversationWindow;
  readonly sessionId: string;
}): RuntimePluginJsonObject {
  return Object.freeze({
    sessionId: options.sessionId,
    messages: Object.freeze(
      options.conversation.messages.map(message =>
        sessionHistoryMessageOutput(message, sessionHistoryReadTextLength),
      ),
    ),
    hasBefore: options.conversation.hasBefore,
    hasAfter: options.conversation.hasAfter,
    damagedRecordsSkipped: options.conversation.damagedRecordCount,
  } satisfies RuntimePluginJsonObject);
}
