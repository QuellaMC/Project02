import {
  readFileBytesSync,
  readFinalByteSync,
  truncateFileSync,
} from '../../shared/file-system.ts';

/**
 * Reading append-only JSONL that a crash may have interrupted.
 *
 * A process killed mid-append leaves a record that never finished being
 * written, and so was never committed. Failing the whole read for it would
 * cost a user every earlier turn in the session to report the one that did
 * not land, so that record is skipped and the rest is returned.
 *
 * A record counts as committed once its terminating newline is on disk,
 * so text after the final newline is not returned — whether or not it
 * happens to parse. The writer draws the line in the same place,
 * discarding exactly that tail before it appends, so a record cannot be
 * visible to recovery on one read and deleted by the next append.
 *
 * Everything before that tail finished being written, so a line there
 * that does not parse is damage rather than an interrupted append, and
 * fails the read. Silently dropping it would hand a caller a short
 * history while reporting success. The codec still decides what a
 * well-formed record must contain; this seam only decides which lines
 * are records.
 */
export function readCompleteJsonLines(content: string): readonly string[] {
  if (content.length === 0) {
    return Object.freeze([]);
  }

  const lines = content
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  // Text after the final newline: empty for a complete file, and the
  // unfinished record for an interrupted one. A record is committed when
  // its newline is on disk, so this is dropped either way — and the
  // writer agrees, discarding exactly this tail before it appends. Were
  // it read as committed, a complete-but-unterminated record would be
  // visible to recovery and then deleted by the next append.
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

    // A committed record that does not parse is damage, not an
    // interrupted write: appends are ordered, so anything before the
    // torn tail finished being written.
    throw new MalformedJsonLineError(index + 1);
  }

  return Object.freeze(records);
}

/**
 * Drops a record a crash left unfinished, before appending after it.
 *
 * Every append-only JSONL writer here calls this first. Writing straight
 * after a fragment splices the new record onto it and makes one unreadable
 * line out of two, so it has to go somewhere.
 *
 * It is removed rather than terminated with a newline. A terminated
 * fragment survives as a committed-looking line that never parses, and
 * once later records land after it nothing distinguishes it from
 * corruption — which would force `readCompleteJsonLines` to tolerate bad
 * lines anywhere, and that is how a damaged log gets read back as a short
 * one. The fragment never finished being written, so it was never
 * committed and nothing is lost.
 */
export function discardTornJsonLineTail(filePath: string): void {
  const finalByte = readFinalByteSync(filePath);

  if (finalByte === undefined || finalByte === 0x0a) {
    return;
  }

  // Searched and measured in bytes, because that is what truncation
  // counts. A string offset would be short by one for every non-ASCII
  // character before the newline — cutting the newline off with the
  // fragment, so the next append would land on the previous record and
  // destroy one that had committed.
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
