/**
 * Reading append-only JSONL that a crash may have interrupted.
 *
 * A process killed mid-append leaves a record that never finished being
 * written, and so was never committed. Failing the whole read for it would
 * cost a user every earlier turn in the session to report the one that did
 * not land, so that record is skipped and the rest is returned.
 *
 * Only the file's last line may be skipped, and only when it does not
 * parse — a record cut off mid-write is cut off mid-token. Appends are
 * ordered, so that is the only place an unfinished record can be, and the
 * writer truncates such a fragment before appending after it rather than
 * leaving it behind. A fragment therefore never acquires records after
 * itself, and the answer does not change depending on who wrote next.
 *
 * Anything else that fails to parse fails the read. An unparseable line
 * with committed records after it was never an unfinished append — it is
 * damage, and silently dropping it would hand a caller a short history
 * while reporting success. The codec still decides what a well-formed
 * record must contain; this seam only decides which lines are records.
 */
export function readCompleteJsonLines(content: string): readonly string[] {
  if (content.length === 0) {
    return Object.freeze([]);
  }

  const lines = content
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const lastIndex = lines.length - 1;
  const records: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    if (isParseableJson(line)) {
      records.push(line);
      continue;
    }

    if (index === lastIndex) {
      continue;
    }

    throw new MalformedJsonLineError(index + 1);
  }

  return Object.freeze(records);
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
