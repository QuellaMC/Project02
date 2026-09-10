import {isJsonRecord} from '../../shared/json-boundary.ts';
import {createSseFrameSplitter} from '../../shared/sse.ts';
import {providerErrorMessageFromBody} from './nvidia-transport.ts';

export type NvidiaStreamObserver = {
  /**
   * A named tool call: once, the moment its name is known, with whatever
   * arguments arrived so far (possibly none), then each piece after.
   */
  readonly onToolCall?: (fragment: {
    readonly index: number;
    readonly name: string;
    readonly text: string;
  }) => void;
};

export type NvidiaStreamedCompletion =
  | {
      readonly status: 'completed';
      /** The whole response, in the shape a non-streamed body would have had. */
      readonly response: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'rejected';
      readonly code: 'malformed_response' | 'provider_error';
      readonly message: string;
    };

type ToolCallAssembly = {
  id: string | undefined;
  name: string | undefined;
  arguments: string;
};

type Rejection = Extract<NvidiaStreamedCompletion, {status: 'rejected'}>;

/**
 * Reads a streamed chat completion — OpenAI's shape, which the NVIDIA
 * endpoint speaks — back into the one message the parser reads whole:
 * content pieces joined, each tool call's fragments joined by index with
 * the id and name its first fragment carried, the last finish reason seen,
 * the last usage seen. Each tool call's pieces are spoken to the observer
 * as they arrive, so a draft can be shown while the model writes; the
 * reassembled message is what gets judged.
 */
export async function readNvidiaChatCompletionStream(
  chunks: AsyncIterable<Uint8Array>,
  observer: NvidiaStreamObserver = {},
): Promise<NvidiaStreamedCompletion> {
  const decoder = new TextDecoder();
  const frames = createSseFrameSplitter();
  const assembly = createCompletionAssembly(observer);

  for await (const chunk of chunks) {
    for (const frame of frames.push(decoder.decode(chunk, {stream: true}))) {
      const outcome = assembly.take(frame.data);

      if (outcome === 'done') {
        return assembly.result();
      }

      if (outcome !== undefined) {
        return outcome;
      }
    }
  }

  return assembly.result();
}

function createCompletionAssembly(observer: NvidiaStreamObserver): {
  /** Undefined to go on, 'done' at the terminator, a rejection for a chunk that is not one. */
  take(data: string | undefined): 'done' | Rejection | undefined;
  result(): NvidiaStreamedCompletion;
} {
  let content: string | null = null;
  let finishReason: string | null = null;
  let usage: unknown;
  const toolCalls = new Map<number, ToolCallAssembly>();

  const takeToolCall = (item: unknown): Rejection | undefined => {
    if (!isJsonRecord(item) || typeof item['index'] !== 'number') {
      return rejectStream(
        'NVIDIA stream chunk tool_calls[] must carry a numeric index.',
      );
    }

    const index = item['index'];
    const call = toolCalls.get(index) ?? {
      id: undefined,
      name: undefined,
      arguments: '',
    };

    toolCalls.set(index, call);

    if (typeof item['id'] === 'string' && item['id'].length > 0) {
      call.id ??= item['id'];
    }

    const fn = item['function'];

    if (!isJsonRecord(fn)) {
      return undefined;
    }

    const incomingName =
      typeof fn['name'] === 'string' && fn['name'].length > 0
        ? fn['name']
        : undefined;
    let named = false;

    if (call.name === undefined && incomingName !== undefined) {
      call.name = incomingName;
      named = true;
    }

    const piece = typeof fn['arguments'] === 'string' ? fn['arguments'] : '';

    call.arguments += piece;

    if (call.name !== undefined && (named || piece.length > 0)) {
      observer.onToolCall?.({
        index,
        name: call.name,
        text: named ? call.arguments : piece,
      });
    }

    return undefined;
  };

  const takeDelta = (delta: unknown): Rejection | undefined => {
    if (delta === undefined || delta === null) {
      return undefined;
    }

    if (!isJsonRecord(delta)) {
      return rejectStream('NVIDIA stream chunk delta must be an object.');
    }

    if (typeof delta['content'] === 'string') {
      content = (content ?? '') + delta['content'];
    }

    const calls = delta['tool_calls'];

    if (calls === undefined || calls === null) {
      return undefined;
    }

    if (!Array.isArray(calls)) {
      return rejectStream('NVIDIA stream chunk tool_calls must be an array.');
    }

    for (const item of calls) {
      const rejected = takeToolCall(item);

      if (rejected !== undefined) {
        return rejected;
      }
    }

    return undefined;
  };

  const takeChunk = (
    chunk: Readonly<Record<string, unknown>>,
  ): Rejection | undefined => {
    // A 200 can still carry the provider's error, as a chunk of its own.
    const providerError = providerErrorMessageFromBody(chunk);

    if (providerError !== undefined) {
      return Object.freeze({
        status: 'rejected',
        code: 'provider_error',
        message: providerError,
      });
    }

    if (chunk['usage'] !== undefined && chunk['usage'] !== null) {
      usage = chunk['usage'];
    }

    const choices = chunk['choices'];

    if (!Array.isArray(choices)) {
      return rejectStream('NVIDIA stream chunk must carry choices.');
    }

    const choice: unknown = choices[0];

    if (choice === undefined) {
      return undefined;
    }

    if (!isJsonRecord(choice)) {
      return rejectStream('NVIDIA stream chunk choices[0] must be an object.');
    }

    if (typeof choice['finish_reason'] === 'string') {
      finishReason = choice['finish_reason'];
    }

    return takeDelta(choice['delta']);
  };

  return {
    take(data) {
      if (data === undefined) {
        return undefined;
      }

      if (data === '[DONE]') {
        return 'done';
      }

      let chunk: unknown;

      try {
        chunk = JSON.parse(data);
      } catch {
        return rejectStream('NVIDIA stream chunk must be JSON.');
      }

      return isJsonRecord(chunk)
        ? takeChunk(chunk)
        : rejectStream('NVIDIA stream chunk must be an object.');
    },
    result() {
      const assembled = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
          id: call.id ?? '',
          type: 'function',
          function: {name: call.name ?? '', arguments: call.arguments},
        }));

      return Object.freeze({
        status: 'completed',
        response: {
          choices: [
            {
              finish_reason: finishReason,
              message: {
                role: 'assistant',
                content,
                ...(assembled.length === 0 ? {} : {tool_calls: assembled}),
              },
            },
          ],
          ...(usage === undefined ? {} : {usage}),
        },
      });
    },
  };
}

function rejectStream(message: string): Rejection {
  return Object.freeze({
    status: 'rejected',
    code: 'malformed_response',
    message,
  });
}
