import {isJsonRecord} from '../../shared/json-boundary.ts';

export type RoleModelPromptFrameSize = {
  readonly kind: string;
  /** Wire messages of this kind in the prompt: history and tool rounds have many. */
  readonly count: number;
  readonly chars: number;
};

/**
 * How big the prompt was, per frame kind in wire order, plus the tools, in
 * characters of the serialized wire — the one fact measured. The frames sum
 * to the wire messages, so the whole is a sum, and tokens are the estimator
 * applied at read time, so nothing stored can disagree with anything else.
 */
export type RoleModelPromptSize = {
  readonly frames: readonly RoleModelPromptFrameSize[];
  readonly toolChars: number;
};

/** Validates and freezes a prompt size, from the loop or a stored record. */
export function freezeRoleModelPromptSize(value: unknown): RoleModelPromptSize {
  // A rendered prompt always carries at least its protocol and user frames.
  if (
    !isJsonRecord(value) ||
    !Array.isArray(value['frames']) ||
    value['frames'].length === 0
  ) {
    throw new TypeError('Role-model prompt size is malformed.');
  }

  const frames = value['frames'].map(freezeFrameSize);

  // One row per kind: the frames of a kind are summed, so a repeated kind
  // would count twice in the whole.
  if (new Set(frames.map(frame => frame.kind)).size !== frames.length) {
    throw new TypeError('Role-model prompt size repeats a frame kind.');
  }

  return Object.freeze({
    frames: Object.freeze(frames),
    // Only the tools may weigh nothing: a turn without tools sends none.
    toolChars: sizeNumber(value['toolChars'], 'toolChars', 0),
  } satisfies RoleModelPromptSize);
}

/** A row exists only for frames that were sent, so every figure is at least one. */
function freezeFrameSize(value: unknown): RoleModelPromptFrameSize {
  if (
    !isJsonRecord(value) ||
    typeof value['kind'] !== 'string' ||
    value['kind'].length === 0
  ) {
    throw new TypeError('Role-model prompt frame size must name its kind.');
  }

  return Object.freeze({
    kind: value['kind'],
    count: sizeNumber(value['count'], `${value['kind']}.count`, 1),
    chars: sizeNumber(value['chars'], `${value['kind']}.chars`, 1),
  } satisfies RoleModelPromptFrameSize);
}

function sizeNumber(value: unknown, field: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new TypeError(
      `Role-model prompt size ${field} must be an integer of at least ${String(
        minimum,
      )}.`,
    );
  }

  return value;
}
