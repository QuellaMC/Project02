import {checkFrame} from './schema.ts';
import type {Address} from './daemon.ts';
import {onTestFinished} from './runner.ts';
import {attachEvidence, failure, within} from './wait.ts';

/** One server-sent event as it came: data lines joined by LF, a comment line's text. */
export type Frame = {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
};

export type Events = {
  /** Every frame so far, in order. */
  readonly frames: readonly Frame[];
  /** The first frame after the one `next` last returned that matches, as soon as it is here. */
  readonly next: (match: (frame: Frame) => boolean) => Promise<Frame>;
  /** Settles when the daemon ends the stream, and fails if it breaks off instead. */
  readonly ended: () => Promise<void>;
};

/** `GET /api/events`, from the ready frame that opens it. */
export async function openEvents(daemon: Address): Promise<Events> {
  const abort = new AbortController();

  onTestFinished(() => {
    abort.abort();
  });

  const response = await within(
    'the event stream to open',
    fetch(new URL('/api/events', daemon.origin), {
      headers: {authorization: `Bearer ${daemon.token}`},
      signal: abort.signal,
    }),
  );

  if (response.status !== 200 || response.body === null) {
    throw failure(
      `The event stream answered ${String(response.status)}: ${await within(
        "the event stream's refusal to be read",
        response.text(),
      )}`,
    );
  }

  const frames: Frame[] = [];
  let arrival = Promise.withResolvers<undefined>();
  let over = false;
  /** A frame the contract does not describe, which fails the test whether or not it looks again. */
  let mismatch: Error | undefined;
  const wake = (): void => {
    arrival.resolve(undefined);
    arrival = Promise.withResolvers();
  };
  const parser = createFrameParser(frame => {
    frames.push(frame);
    wake();
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const reading = (async () => {
    for (;;) {
      const {done, value} = await reader.read();

      if (done) {
        parser.end();

        return;
      }

      try {
        parser.feed(value);
      } catch (error: unknown) {
        if (error instanceof Error) {
          mismatch = error;
        }

        throw error;
      }
    }
  })();

  onTestFinished(() => {
    if (mismatch !== undefined) {
      throw mismatch;
    }
  });

  let taken = 0;
  const end = (): void => {
    over = true;
    wake();
  };

  // Awaited by `ended`; a stream nobody asks about may break off unheard.
  reading.then(end, end);
  attachEvidence(
    () =>
      `events from ${daemon.origin}:\n${frames.map(describeFrame).join('\n')}`,
  );

  return {
    frames,
    next: match =>
      within(
        'the next matching frame',
        (async () => {
          for (;;) {
            const index = frames.findIndex(
              (frame, at) => at >= taken && match(frame),
            );
            const frame = frames[index];

            if (frame !== undefined) {
              taken = index + 1;

              return frame;
            }

            if (mismatch !== undefined) {
              throw mismatch;
            }

            if (over) {
              throw failure('The stream ended before the next matching frame.');
            }

            await arrival.promise;
          }
        })(),
      ),
    ended: () => within('the stream to end', reading),
  };
}

/** A frame of this kind whose JSON data holds everything the pattern names. */
export function frameOf(
  event: string,
  pattern: object = {},
): (frame: Frame) => boolean {
  return frame =>
    frame.event === event &&
    holds(JSON.parse(frame.data ?? 'null') as unknown, pattern);
}

/** Objects by the keys the pattern names, arrays element by element, the rest by identity. */
function holds(value: unknown, pattern: unknown): boolean {
  if (typeof pattern !== 'object' || pattern === null) {
    return Object.is(value, pattern);
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) !== Array.isArray(pattern) ||
    (Array.isArray(value) &&
      Array.isArray(pattern) &&
      value.length !== pattern.length)
  ) {
    return false;
  }

  return Object.entries(pattern).every(([key, expected]) =>
    holds(Reflect.get(value, key), expected),
  );
}

/**
 * Lines end in LF, CRLF or CR, and a blank one ends a frame. A CR held back
 * as the possible first half of a CRLF is a line's end once the stream
 * ends; a line the stream ends in the middle of is not a line. A frame that
 * carries data is held to the contract before it is handed on.
 */
function createFrameParser(emit: (frame: Frame) => void): {
  readonly feed: (text: string) => void;
  readonly end: () => void;
} {
  let rest = '';
  let fields: {id?: string; event?: string; data?: string; comment?: string} =
    {};
  const feed = (text: string): void => {
    rest += text;

    for (;;) {
      const end = /\r\n|\r|\n/u.exec(rest);

      // A CR at the very end may be the first half of a CRLF.
      if (end === null || (end[0] === '\r' && end.index === rest.length - 1)) {
        return;
      }

      const line = rest.slice(0, end.index);

      rest = rest.slice(end.index + end[0].length);

      if (line === '') {
        if (fields.data !== undefined) {
          checkFrame(fields.event, fields.data);
        }

        if (Object.keys(fields).length > 0) {
          emit(fields);
        }

        fields = {};
        continue;
      }

      const colon = line.indexOf(':');
      const name = colon === -1 ? line : line.slice(0, colon);
      const value =
        colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');

      if (name === '') {
        fields.comment = value;
      } else if (name === 'data') {
        fields.data =
          fields.data === undefined ? value : `${fields.data}\n${value}`;
      } else if (name === 'id' || name === 'event') {
        fields[name] = value;
      }
    }
  };

  return {
    feed,
    end: () => {
      if (rest.endsWith('\r')) {
        feed('\n');
      }
    },
  };
}

function describeFrame(frame: Frame): string {
  return Object.entries(frame)
    .map(([field, value]) => `${field}: ${value}`)
    .join(' | ');
}
