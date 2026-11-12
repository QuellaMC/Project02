/**
 * The Responses protocol as the model server speaks it in the OpenAI
 * API's place and in a ChatGPT plan's: a response's output items, a
 * function call or plain words, each streamed by its events at its place
 * in the output and held whole by the event that ends the response, or,
 * as the plan's service may end one, by its own last event alone, or whole
 * in one body for a request that does not stream; the service's error, a
 * plan's usage used up and a token refused; and the input a request showed
 * the model.
 */
import {
  pieces,
  type Answer,
  type ModelRequest,
  type ResponseEvent,
} from './model-server.ts';

/** An item of a response's output: the events that stream it at its place, and the item as the finished response holds it. */
export type OutputItem = {
  readonly events: (index: number) => readonly ResponseEvent[];
  readonly item: (index: number) => object;
};

/** An item of a request's input: a message's text plain, or, as a plan's service takes it, one part. */
export type InputItem = {
  readonly type: string;
  readonly role?: string;
  readonly content?:
    string | readonly {readonly type: string; readonly text: string}[];
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly output?: string;
};

/** A call of the tool the model knows as `name`, its arguments written in pieces cut at the given offsets. */
export function functionCall(
  name: string,
  args: string,
  ...cuts: number[]
): OutputItem {
  const item = (index: number, written: string) => ({
    type: 'function_call',
    id: `fc_${String(index)}`,
    call_id: `call_model_${String(index)}`,
    name,
    arguments: written,
  });

  return {
    events: index => [
      {
        type: 'response.output_item.added',
        output_index: index,
        item: item(index, ''),
      },
      ...pieces(args, cuts).map(delta => ({
        type: 'response.function_call_arguments.delta',
        output_index: index,
        item_id: `fc_${String(index)}`,
        delta,
      })),
      {
        type: 'response.output_item.done',
        output_index: index,
        item: item(index, args),
      },
    ],
    item: index => item(index, args),
  };
}

/** The character speaking through `visible_reply`, its arguments cut at the given offsets. */
export function replying(words: string, ...cuts: number[]): OutputItem {
  return functionCall('visible_reply', JSON.stringify({text: words}), ...cuts);
}

/** The model's words as a plain completion answers: a message holding them as its text. */
export function saying(words: string): OutputItem {
  const item = (index: number, written: string) => ({
    type: 'message',
    id: `msg_${String(index)}`,
    role: 'assistant',
    content: written === '' ? [] : [{type: 'output_text', text: written}],
  });

  return {
    events: index => [
      {
        type: 'response.output_item.added',
        output_index: index,
        item: item(index, ''),
      },
      {
        type: 'response.output_text.delta',
        output_index: index,
        content_index: 0,
        delta: words,
      },
      {
        type: 'response.output_item.done',
        output_index: index,
        item: item(index, words),
      },
    ],
    item: index => item(index, words),
  };
}

/** The events of a response that completes with these items. */
export function responseEvents(
  ...items: readonly OutputItem[]
): ResponseEvent[] {
  return [
    {type: 'response.created', response: {status: 'in_progress', output: []}},
    ...streamed(items),
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: items.map((item, index) => item.item(index)),
        usage: {input_tokens: 12, output_tokens: 34, total_tokens: 46},
      },
    },
  ];
}

/** A response that completes with these items. */
export function responded(...items: readonly OutputItem[]): Answer {
  return {events: responseEvents(...items)};
}

/** A response that completes with these items, whole in one body, as the OpenAI API answers a request that does not stream. */
export function respondedWhole(...items: readonly OutputItem[]): Answer {
  return {
    completion: {
      status: 'completed',
      output: items.map((item, index) => item.item(index)),
    },
  };
}

/** The events of a response as a ChatGPT plan's service streams it: each item held whole by its own last event, and an end that carries no output. */
export function planEvents(...items: readonly OutputItem[]): ResponseEvent[] {
  return [
    {type: 'response.created', response: {status: 'in_progress', output: []}},
    ...streamed(items),
    {type: 'response.completed', response: {}},
  ];
}

/** A response that completes with these items, as a ChatGPT plan's service streams it. */
export function planResponded(...items: readonly OutputItem[]): Answer {
  return {events: planEvents(...items)};
}

/** A ChatGPT plan's service refusing a request because the plan's usage is used up. */
export function usageLimitReached(): Answer {
  return {
    status: 429,
    body: {
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
      },
    },
  };
}

/** A ChatGPT plan's service refusing the token a request carried. */
export function unauthorized(): Answer {
  return {status: 401, body: {detail: 'Unauthorized'}};
}

/** These items streamed, then the service's error in its words. */
export function erred(
  message: string,
  ...items: readonly OutputItem[]
): Answer {
  return {
    events: [
      ...streamed(items),
      {type: 'error', code: 'server_error', message},
    ],
  };
}

/** The input a request showed the model, in order. */
export function inputOf(
  request: ModelRequest | undefined,
): readonly InputItem[] {
  return (
    (request?.body as {readonly input?: readonly InputItem[]} | undefined)
      ?.input ?? []
  );
}

function streamed(items: readonly OutputItem[]): ResponseEvent[] {
  return items.flatMap((item, index) => item.events(index));
}
