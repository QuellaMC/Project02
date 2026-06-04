import { describe, expect, it } from 'vitest';

import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError
} from '../src/index.ts';

describe('runtime event contract', () => {
  it('creates a deterministic USER_MESSAGE event with separate event and trace identity', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_test_001',
      traceId: 'trace_test_001',
      createdAt: '2026-06-04T00:00:00.000Z'
    });

    const event = createUserMessageRuntimeEvent('  hello  ', identity);

    expect(event).toEqual({
      eventId: 'evt_test_001',
      traceId: 'trace_test_001',
      createdAt: '2026-06-04T00:00:00.000Z',
      type: 'USER_MESSAGE',
      payload: {
        currentUserMessage: 'hello'
      }
    });
    expect(event.eventId).not.toBe(event.traceId);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it('rejects empty input with the identity reserved for the rejected event intake', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_rejected_empty',
      traceId: 'trace_rejected_empty',
      createdAt: '2026-06-04T00:01:00.000Z'
    });

    expect(() => createUserMessageRuntimeEvent('   ', identity)).toThrow(
      RuntimeEventInputError
    );

    try {
      createUserMessageRuntimeEvent('   ', identity);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeEventInputError);

      if (!(error instanceof RuntimeEventInputError)) {
        throw new Error('Expected RuntimeEventInputError.', {
          cause: error
        });
      }

      expect(error.reason).toBe('empty');
      expect(error.identity).toEqual(identity);
      expect(error.message).toBe('Provide exactly one non-empty message.');
    }
  });

  it('rejects multiline input before a USER_MESSAGE event is created', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_rejected_multiline',
      traceId: 'trace_rejected_multiline',
      createdAt: '2026-06-04T00:02:00.000Z'
    });

    try {
      createUserMessageRuntimeEvent('hello\nthere', identity);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeEventInputError);

      if (!(error instanceof RuntimeEventInputError)) {
        throw new Error('Expected RuntimeEventInputError.', {
          cause: error
        });
      }

      expect(error.reason).toBe('multiline');
      expect(error.identity).toEqual(identity);
      expect(error.message).toBe('Provide exactly one non-empty single-line message.');
      return;
    }

    throw new Error('Expected multiline input to be rejected.');
  });
});
