type CompleteJsonLinesErrorReason =
  | 'blank_record'
  | 'missing_terminal_newline';

export class CompleteJsonLinesError extends TypeError {
  readonly reason: CompleteJsonLinesErrorReason;

  constructor(reason: CompleteJsonLinesErrorReason) {
    super(
      reason === 'missing_terminal_newline'
        ? 'JSONL content ended without a complete record.'
        : 'JSONL content contains a blank record.'
    );
    this.name = 'CompleteJsonLinesError';
    this.reason = reason;
  }
}

export function splitCompleteJsonLines(content: string): readonly string[] {
  if (content.length === 0) {
    return Object.freeze([]);
  }

  if (!content.endsWith('\n')) {
    throw new CompleteJsonLinesError('missing_terminal_newline');
  }

  const lines = content.split('\n');
  lines.pop();

  return Object.freeze(
    lines.map((line) => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;

      if (normalized.trim().length === 0) {
        throw new CompleteJsonLinesError('blank_record');
      }

      return normalized;
    })
  );
}
