import {describe, expect, it} from 'vitest';
import {readNvidiaChatCompletionStream} from '../../src/role-model/providers/nvidia-stream.ts';
import {sseText} from '../support/nvidia-fixtures.ts';

/** The text as bytes, cut into pieces that split frames and characters alike. */
function bytes(text: string, pieceLength = 7): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  const pieces: Uint8Array[] = [];

  for (let start = 0; start < encoded.length; start += pieceLength) {
    pieces.push(encoded.slice(start, start + pieceLength));
  }

  return ReadableStream.from(pieces);
}

const delta = (
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
) => ({choices: [{index: 0, delta, finish_reason: finishReason}]});

describe('NVIDIA chat completion stream', () => {
  it('reassembles content, tool calls by index, the finish reason, and usage, speaking each piece as it arrives', async () => {
    const content: string[] = [];
    const calls: {index: number; name: string; text: string}[] = [];
    const result = await readNvidiaChatCompletionStream(
      bytes(
        sseText([
          delta({role: 'assistant', content: 'Hé'}),
          delta({
            tool_calls: [
              {
                index: 0,
                id: 'a',
                type: 'function',
                function: {name: 'visible_reply', arguments: '{"te'},
              },
            ],
          }),
          delta({content: 'llo'}),
          delta({
            tool_calls: [
              {
                index: 1,
                id: 'b',
                function: {name: 'memory_search', arguments: '{"q'},
              },
            ],
          }),
          delta({tool_calls: [{index: 0, function: {arguments: 'xt":"x"}'}}]}),
          delta({
            tool_calls: [{index: 1, function: {arguments: 'uery":"y"}'}}],
          }),
          delta({}, 'tool_calls'),
          {choices: [], usage: {total_tokens: 9}},
          '[DONE]',
          delta({content: 'not read'}),
        ]),
      ),
      {
        onContent: text => content.push(text),
        onToolCall: fragment => calls.push(fragment),
      },
    );

    expect(result).toEqual({
      status: 'completed',
      response: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Héllo',
              tool_calls: [
                {
                  id: 'a',
                  type: 'function',
                  function: {name: 'visible_reply', arguments: '{"text":"x"}'},
                },
                {
                  id: 'b',
                  type: 'function',
                  function: {name: 'memory_search', arguments: '{"query":"y"}'},
                },
              ],
            },
          },
        ],
        usage: {total_tokens: 9},
      },
    });
    expect(content).toEqual(['Hé', 'llo']);
    expect(calls).toEqual([
      {index: 0, name: 'visible_reply', text: '{"te'},
      {index: 1, name: 'memory_search', text: '{"q'},
      {index: 0, name: 'visible_reply', text: 'xt":"x"}'},
      {index: 1, name: 'memory_search', text: 'uery":"y"}'},
    ]);
  });

  it('announces a call the moment it is named, with what arrived before the name', async () => {
    const calls: {index: number; name: string; text: string}[] = [];
    const result = await readNvidiaChatCompletionStream(
      bytes(
        sseText([
          delta({
            tool_calls: [{index: 0, id: 'a', function: {arguments: '{"te'}}],
          }),
          delta({tool_calls: [{index: 0, function: {arguments: 'xt":'}}]}),
          delta({tool_calls: [{index: 0, function: {name: 'visible_reply'}}]}),
          delta({tool_calls: [{index: 0, function: {arguments: '"x"}'}}]}),
          delta({
            tool_calls: [{index: 1, id: 'b', function: {name: 'memory_list'}}],
          }),
          delta({}, 'tool_calls'),
          '[DONE]',
        ]),
      ),
      {onToolCall: fragment => calls.push(fragment)},
    );

    expect(calls).toEqual([
      {index: 0, name: 'visible_reply', text: '{"text":'},
      {index: 0, name: 'visible_reply', text: '"x"}'},
      {index: 1, name: 'memory_list', text: ''},
    ]);
    expect(result).toMatchObject({
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'a',
                  function: {name: 'visible_reply', arguments: '{"text":"x"}'},
                },
                {id: 'b', function: {name: 'memory_list', arguments: ''}},
              ],
            },
          },
        ],
      },
    });
  });

  it('carries no finish reason when none came, no content when none came, and ignores reasoning and pings', async () => {
    const content: string[] = [];
    const result = await readNvidiaChatCompletionStream(
      bytes(
        ': ping\n\n' +
          sseText([
            delta({role: 'assistant', reasoning_content: 'hmm'}),
            '[DONE]',
          ]),
      ),
      {onContent: text => content.push(text)},
    );

    expect(result).toEqual({
      status: 'completed',
      response: {
        choices: [
          {finish_reason: null, message: {role: 'assistant', content: null}},
        ],
      },
    });
    expect(content).toEqual([]);
  });

  it.each([
    ['{oops', 'malformed_response', 'NVIDIA stream chunk must be JSON.'],
    ['[]', 'malformed_response', 'NVIDIA stream chunk must be an object.'],
    [
      JSON.stringify({choices: 'nope'}),
      'malformed_response',
      'NVIDIA stream chunk must carry choices.',
    ],
    [
      JSON.stringify({object: 'chat.completion.chunk'}),
      'malformed_response',
      'NVIDIA stream chunk must carry choices.',
    ],
    [
      JSON.stringify({choices: [{delta: {tool_calls: [{}]}}]}),
      'malformed_response',
      'NVIDIA stream chunk tool_calls[] must carry a numeric index.',
    ],
    [
      JSON.stringify({error: {message: 'model overloaded', type: 'server'}}),
      'provider_error',
      'NVIDIA provider error: model overloaded',
    ],
  ])(
    "refuses a chunk that is not a completion, naming the provider's own error when it sent one: %s",
    async (data, code, message) => {
      await expect(
        readNvidiaChatCompletionStream(bytes(`data: ${data}\n\n`)),
      ).resolves.toEqual({status: 'rejected', code, message});
    },
  );
});
