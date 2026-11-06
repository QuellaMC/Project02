export type SseFrame = {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
};

/**
 * Splits decoded text into server-sent event frames across chunk
 * boundaries. A frame ends at a blank line; lines end in LF, CRLF, or CR.
 */
export function createSseFrameSplitter(): {
  push(chunk: string): readonly SseFrame[];
} {
  let buffer = '';

  return {
    push(chunk) {
      buffer += chunk;

      // A CR at the very end may be half of a CRLF; hold it for the next chunk.
      const held = buffer.endsWith('\r') ? '\r' : '';
      const text = buffer
        .slice(0, buffer.length - held.length)
        .replaceAll(/\r\n?/gu, '\n');
      const frames: SseFrame[] = [];
      let start = 0;
      let boundary = text.indexOf('\n\n', start);

      while (boundary !== -1) {
        frames.push(parseSseFrame(text.slice(start, boundary)));
        start = boundary + 2;
        boundary = text.indexOf('\n\n', start);
      }

      buffer = text.slice(start) + held;

      return frames;
    },
  };
}

/** One frame's lines to its fields; unknown fields are skipped. */
export function parseSseFrame(raw: string): SseFrame {
  let id: string | undefined;
  let event: string | undefined;
  let comment: string | undefined;
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      comment = line.slice(1).trim();
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');

    if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }

  return Object.freeze({
    ...(id === undefined ? {} : {id}),
    ...(event === undefined ? {} : {event}),
    ...(data.length === 0 ? {} : {data: data.join('\n')}),
    ...(comment === undefined ? {} : {comment}),
  });
}
