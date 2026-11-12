/**
 * Anthropic's Messages protocol as the model server speaks it in the
 * Claude API's place: a message's content blocks, her reply or another
 * tool call, plain text or a thought, each streamed by its events at its
 * place in the message, and the message stopped for its reason; a decline
 * and the service's error; and the conversation a request showed the
 * model.
 */
import {
  pieces,
  type Answer,
  type ModelRequest,
  type ResponseEvent,
} from './model-server.ts';

/** A block of a message's content: the events that stream it at its place, and whether it calls a tool. */
export type ContentBlock = {
  readonly events: (index: number) => readonly ResponseEvent[];
  readonly calls: boolean;
};

/** A block of a request's message: text, a call of a tool or a call's result. */
export type MessageBlock = {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: string;
};

/** A message of a request's conversation: a line as its text, or its blocks. */
export type Turn = {
  readonly role: string;
  readonly content: string | readonly MessageBlock[];
};

/** A call of the tool the model knows as `name`, its arguments written in pieces cut at the given offsets. */
export function toolUse(
  name: string,
  args: string,
  ...cuts: number[]
): ContentBlock {
  return block(
    index => ({
      type: 'tool_use',
      id: `toolu_${String(index)}`,
      name,
      input: {},
    }),
    pieces(args, cuts).map(piece => ({
      type: 'input_json_delta',
      partial_json: piece,
    })),
    true,
  );
}

/** The character speaking through `visible_reply`, its arguments cut at the given offsets. */
export function replyUse(words: string, ...cuts: number[]): ContentBlock {
  return toolUse('visible_reply', JSON.stringify({text: words}), ...cuts);
}

/** The model's words as text of the message. */
export function textBlock(words: string): ContentBlock {
  return block(
    () => ({type: 'text', text: ''}),
    [{type: 'text_delta', text: words}],
    false,
  );
}

/** The model's thought, with the signature that comes after it. */
export function thinkingBlock(words: string): ContentBlock {
  return block(
    () => ({type: 'thinking', thinking: ''}),
    [
      {type: 'thinking_delta', thinking: words},
      {type: 'signature_delta', signature: 'c2lnbmVk'},
    ],
    false,
  );
}

/** The events of a message with these blocks, stopped as they end it: for a tool if one calls one, else at the end of its turn. */
export function messageEvents(
  ...blocks: readonly ContentBlock[]
): ResponseEvent[] {
  return [
    ...started(),
    ...streamed(blocks),
    ...stopped(blocks.some(content => content.calls) ? 'tool_use' : 'end_turn'),
  ];
}

/** A message with these blocks, stopped as they end it. */
export function messaged(...blocks: readonly ContentBlock[]): Answer {
  return {events: messageEvents(...blocks)};
}

/** A message the model declines to write, for the category the service names. */
export function declined(category: string): Answer {
  return {
    events: [
      ...started(),
      ...stopped('refusal', {
        type: 'refusal',
        category,
        explanation: 'This was declined.',
      }),
    ],
  };
}

/** These blocks streamed, then the service's error in its words. */
export function messageErred(
  message: string,
  ...blocks: readonly ContentBlock[]
): Answer {
  return {
    events: [
      ...started(),
      ...streamed(blocks),
      {type: 'error', error: {type: 'api_error', message}},
    ],
  };
}

/** The conversation a request showed the model, in order. */
export function turnsOf(request: ModelRequest | undefined): readonly Turn[] {
  return (
    (request?.body as {readonly messages?: readonly Turn[]} | undefined)
      ?.messages ?? []
  );
}

function block(
  start: (index: number) => object,
  deltas: readonly object[],
  calls: boolean,
): ContentBlock {
  return {
    events: index => [
      {type: 'content_block_start', index, content_block: start(index)},
      ...deltas.map(delta => ({type: 'content_block_delta', index, delta})),
      {type: 'content_block_stop', index},
    ],
    calls,
  };
}

/** A message begun, its input tokens counted, and a ping. */
function started(): ResponseEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: null,
        usage: {input_tokens: 12, output_tokens: 1},
      },
    },
    {type: 'ping'},
  ];
}

/** A message stopped for `reason`, with its details when it has them, its output tokens counted. */
function stopped(reason: string, details?: object): ResponseEvent[] {
  return [
    {
      type: 'message_delta',
      delta: {
        stop_reason: reason,
        stop_sequence: null,
        ...(details === undefined ? {} : {stop_details: details}),
      },
      usage: {output_tokens: 34},
    },
    {type: 'message_stop'},
  ];
}

function streamed(blocks: readonly ContentBlock[]): ResponseEvent[] {
  return blocks.flatMap((content, index) => content.events(index));
}
