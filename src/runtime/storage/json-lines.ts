import {
  readFileBytesSync,
  readFinalByteSync,
  truncateFileSync,
} from '../../shared/file-system.ts';

/**
 * A record is committed once its terminating newline is on disk, so text
 * after the final newline is an unfinished append and is dropped.
 */
export function readCompleteJsonLines(content: string): readonly string[] {
  return Object.freeze(
    committedJsonLines(content).map((line, index) => {
      if (!isParseableJson(line)) {
        throw new MalformedJsonLineError(index + 1);
      }

      return line;
    }),
  );
}

export function readUndamagedJsonLines(content: string): readonly string[] {
  return Object.freeze(committedJsonLines(content).filter(isParseableJson));
}

function committedJsonLines(content: string): readonly string[] {
  if (content.length === 0) {
    return Object.freeze([]);
  }

  const lines = content
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));

  lines.pop();
  return Object.freeze(lines);
}

/** Every append-only JSONL writer here calls this first. */
export function discardTornJsonLineTail(filePath: string): void {
  const finalByte = readFinalByteSync(filePath);

  if (finalByte === undefined || finalByte === 0x0a) {
    return;
  }

  // Truncation counts bytes; a string offset would cut into a non-ASCII record.
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

export function isParseableJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}
