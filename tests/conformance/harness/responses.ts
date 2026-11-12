/**
 * The Responses protocol as the model server speaks it in the OpenAI
 * API's place: a response's output items, each streamed by its events at
 * its place in the output and held whole by the event that ends the
 * response, the service's error, and the input a request showed the model.
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

/** An item of a request's input. */
export type InputItem = {
  readonly type: string;
  readonly role?: string;
  readonly content?: string;
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
