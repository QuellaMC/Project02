/**
 * Reading append-only JSONL that a crash may have interrupted.
 *
 * A process killed mid-append leaves a record that never finished being
 * written, and so was never committed. Failing the whole read for it would
 * cost a user every earlier turn in the session to report the one that did
 * not land, so an unfinished record is skipped and the rest is returned.
 *
 * "Unfinished" means the text does not parse as JSON: a record cut off
 * mid-write is cut off mid-token. Parsing is what decides, rather than the
 * missing final newline, because the same fragment has to read the same
 * way before and after the next writer terminates it — otherwise a record
 * would vanish and reappear depending on who wrote next.
 *
 * A line that parses but violates its schema is not skipped. That is
 * damage or forgery rather than an interrupted write, and quietly dropping
 * it would hide real data loss. The codec still decides what a well-formed
 * record must contain; this seam only decides which lines are records.
 */
export function readCompleteJsonLines(content: string): readonly string[] {
  if (content.length === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    content
      .split('\n')
      .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter(line => line.trim().length > 0 && isParseableJson(line)),
  );
}

function isParseableJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}
