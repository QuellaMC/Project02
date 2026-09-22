/**
 * The user lines a conversation's closed segments hold, by segment and
 * client id: what a delivery asks to refuse a line an earlier run took,
 * however far back. One JSON file per conversation beside the character's
 * sessions, rewritten whole. The segments stay the source of truth: a
 * file that is missing or will not parse reads as empty, and the
 * conversation driver builds it again from them.
 */
import {join} from 'node:path';

import {
  atomicReplaceFileSync,
  cleanupAbandonedAtomicReplacementFilesSync,
} from './atomic-file.ts';
import {createLocalRuntimeStorageLayout} from './layout-contract.ts';
import {readOptionalStoreText, storeWriteFailed} from './store-file.ts';

/** Segment number → client message id → the message id the line was committed as. */
export type TakenLines = ReadonlyMap<number, ReadonlyMap<string, string>>;

export type TakenLinesOptions = {
  readonly storeRoot: string;
  readonly conversationId: string;
};

export function takenLinesPath(options: TakenLinesOptions): string {
  return join(
    createLocalRuntimeStorageLayout({storeRoot: options.storeRoot})
      .takenLinesRoot,
    `${options.conversationId}.json`,
  );
}

export function readTakenLines(options: TakenLinesOptions): TakenLines {
  const text = readOptionalStoreText(takenLinesPath(options));

  if (text === undefined) {
    return new Map();
  }

  try {
    return decodeTakenLines(JSON.parse(text));
  } catch {
    return new Map();
  }
}

export function writeTakenLines(
  options: TakenLinesOptions,
  lines: TakenLines,
): void {
  const targetPath = takenLinesPath(options);
  const segments: Record<string, Record<string, string>> = {};

  for (const [segment, taken] of [...lines].sort(
    ([left], [right]) => left - right,
  )) {
    segments[String(segment)] = Object.fromEntries(taken);
  }

  try {
    cleanupAbandonedAtomicReplacementFilesSync(targetPath);
    atomicReplaceFileSync({
      targetPath,
      content: `${JSON.stringify({segments})}\n`,
    });
  } catch (error: unknown) {
    throw storeWriteFailed(targetPath, error);
  }
}

/** The message id an earlier run committed the line as, if any segment holds it. */
export function takenLine(
  lines: TakenLines,
  clientMessageId: string,
): string | undefined {
  for (const taken of lines.values()) {
    const messageId = taken.get(clientMessageId);

    if (messageId !== undefined) {
      return messageId;
    }
  }

  return undefined;
}

/** The file's shape, exactly; anything else is no record at all. */
function decodeTakenLines(value: unknown): TakenLines {
  const lines = new Map<number, ReadonlyMap<string, string>>();
  const segments =
    isRecord(value) && isRecord(value['segments']) ? value['segments'] : {};

  for (const [key, taken] of Object.entries(segments)) {
    if (
      !/^[1-9][0-9]*$/u.test(key) ||
      !isRecord(taken) ||
      !Object.values(taken).every(messageId => typeof messageId === 'string')
    ) {
      return new Map();
    }

    lines.set(
      Number(key),
      new Map(Object.entries(taken) as [string, string][]),
    );
  }

  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
