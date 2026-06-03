import { describe, expect, it } from 'vitest';

import { relayMessage, type RelayAgent } from '../src/relay.ts';

describe('relayMessage', () => {
  it('passes the trimmed message to the injected agent and returns its reply text', async () => {
    const calls: Array<{ readonly message: string }> = [];
    const agent: RelayAgent = {
      reply(input) {
        calls.push(input);
        return { text: `agent replied to ${input.message}` };
      }
    };

    await expect(relayMessage('  hello  ', agent)).resolves.toEqual({
      input: {
        message: 'hello'
      },
      reply: {
        text: 'agent replied to hello'
      }
    });
    expect(calls).toEqual([{ message: 'hello' }]);
  });

  it('rejects invalid input without calling the agent', async () => {
    const calls: Array<{ readonly message: string }> = [];
    const agent: RelayAgent = {
      reply(input) {
        calls.push(input);
        return { text: 'unused' };
      }
    };

    await expect(relayMessage('   ', agent)).rejects.toThrow(
      'Provide exactly one non-empty message.'
    );
    expect(calls).toEqual([]);
  });

  it('rejects multiline input without calling the agent', async () => {
    const calls: Array<{ readonly message: string }> = [];
    const agent: RelayAgent = {
      reply(input) {
        calls.push(input);
        return { text: 'unused' };
      }
    };

    await expect(relayMessage('hello\nthere', agent)).rejects.toThrow(
      'Provide exactly one non-empty single-line message.'
    );
    expect(calls).toEqual([]);
  });

  it('rejects multiline agent replies before returning a result', async () => {
    const agent: RelayAgent = {
      reply() {
        return { text: 'line one\nline two' };
      }
    };

    await expect(relayMessage('hello', agent)).rejects.toThrow(
      'Relay agent returned a multi-line reply.'
    );
  });
});
