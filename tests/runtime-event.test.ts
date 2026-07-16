import { describe, expect, it } from 'vitest';

import {
  assertCanonicalRuntimeTimestamp,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError
} from '../src/core/message-event.ts';

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

  it('rejects blank or duplicate identity fields before event creation', () => {
    expect(() =>
      createRuntimeEventIdentity({
        eventId: '',
        traceId: 'trace_test_001',
        createdAt: '2026-06-04T00:00:00.000Z'
      })
    ).toThrow('Runtime event identity requires non-empty event and trace IDs.');
    expect(() =>
      createRuntimeEventIdentity({
        eventId: 'evt_same',
        traceId: 'evt_same',
        createdAt: '2026-06-04T00:00:00.000Z'
      })
    ).toThrow('Runtime event identity requires separate event and trace IDs.');
  });

  it.each([
    '',
    'not-a-date',
    '2026-06-04T08:00:00.000+08:00',
    '2026-06-04T00:00:00Z'
  ])('rejects non-canonical runtime timestamps', (createdAt) => {
    expect(() =>
      createRuntimeEventIdentity({
        eventId: 'evt_invalid_timestamp',
        traceId: 'trace_invalid_timestamp',
        createdAt
      })
    ).toThrow('Runtime event createdAt must be a canonical UTC ISO timestamp.');
  });

  it('accepts and returns a canonical runtime timestamp unchanged', () => {
    expect(
      assertCanonicalRuntimeTimestamp(
        '2026-06-04T00:00:00.000Z',
        'Runtime event createdAt'
      )
    ).toBe('2026-06-04T00:00:00.000Z');
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
      expect(Object.isFrozen(error.identity)).toBe(true);
      expect(error.message).toBe('Provide exactly one non-empty message.');
    }
  });

  it('snapshots caller-provided identity before rejection details are exposed', () => {
    const mutableIdentity = {
      eventId: 'evt_mutable_rejected',
      traceId: 'trace_mutable_rejected',
      createdAt: '2026-06-04T00:01:30.000Z'
    };

    try {
      createUserMessageRuntimeEvent('', mutableIdentity);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeEventInputError);

      if (!(error instanceof RuntimeEventInputError)) {
        throw new Error('Expected RuntimeEventInputError.', {
          cause: error
        });
      }

      mutableIdentity.eventId = 'evt_mutated_after_rejection';
      mutableIdentity.traceId = 'trace_mutated_after_rejection';
      mutableIdentity.createdAt = '2026-06-04T00:01:31.000Z';

      expect(error.identity).toEqual({
        eventId: 'evt_mutable_rejected',
        traceId: 'trace_mutable_rejected',
        createdAt: '2026-06-04T00:01:30.000Z'
      });
      return;
    }

    throw new Error('Expected empty input to be rejected.');
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

  it.each([
    'hello\u2028world',
    'hello\u2029world',
    '\u2028hello',
    'hello\u2029',
    '\u2028hello\u2029'
  ])(
    'rejects Unicode line separators in one-line input',
    (message) => {
      expect(() => createUserMessageRuntimeEvent(message)).toThrow(
        'Provide exactly one non-empty single-line message.'
      );
    }
  );
});
