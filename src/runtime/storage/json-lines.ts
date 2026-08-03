import {
  readFileBytesSync,
  readFinalByteSync,
  truncateFileSync,
} from '../../shared/file-system.ts';

/**
 * A record is committed once its terminating newline is on disk, so text
 * after the final newline is dropped — a crash left it unfinished. A line
 * before that tail which does not parse is damage, not an interrupted
 * append, and fails the read.
 */
export function readCompleteJsonLines(content: string): readonly string[] {
  if (content.length === 0) {
    return Object.freeze([]);
  }

  const lines = content
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  lines.pop();

  const records: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    if (isParseableJson(line)) {
      records.push(line);
      continue;
    }

    throw new MalformedJsonLineError(index + 1);
  }

  return Object.freeze(records);
}

/**
 * Drops an unfinished trailing record, so an append starts on its own
 * line. Every append-only JSONL writer here calls this first.
 */
export function discardTornJsonLineTail(filePath: string): void {
  const finalByte = readFinalByteSync(filePath);

  if (finalByte === undefined || finalByte === 0x0a) {
    return;
  }

  // Bytes, not characters: truncation counts bytes, and a string offset
  // would cut into the previous record when the tail is non-ASCII.
  const content = readFileBytesSync(filePath);

  truncateFileSync(filePath, content.lastIndexOf(0x0a) + 1);
}

/** A committed record that does not parse: damage, not a torn append. */
export class MalformedJsonLineError extends TypeError {
  readonly lineNumber: number;

  constructor(lineNumber: number) {
    super(`JSONL line ${String(lineNumber)} is not valid JSON.`);
    this.name = 'MalformedJsonLineError';
    this.lineNumber = lineNumber;
  }
}

function isParseableJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}
