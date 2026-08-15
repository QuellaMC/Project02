import {isJsonRecord} from '../../shared/json-boundary.ts';

export type RoleModelPromptSizeMeasure = {
  readonly chars: number;
  readonly estimatedTokens: number;
};

export type RoleModelPromptFrameSize = RoleModelPromptSizeMeasure & {
  readonly kind: string;
  /** Wire messages of this kind in the prompt: history and tool rounds have many. */
  readonly count: number;
};

/**
 * How big the prompt was, per frame kind in wire order, plus the tools; the
 * frames sum to the wire messages, so the whole is a sum, not a field.
 * Recorded on every round so an inspection can hold the runtime's chars/4
 * estimate against the tokens the provider reported.
 */
export type RoleModelPromptSize = {
  readonly frames: readonly RoleModelPromptFrameSize[];
  readonly tools: RoleModelPromptSizeMeasure;
};

/** Validates and freezes a prompt size, from the loop or a stored record. */
export function freezeRoleModelPromptSize(value: unknown): RoleModelPromptSize {
  if (!isJsonRecord(value) || !Array.isArray(value['frames'])) {
    throw new TypeError('Role-model prompt size is malformed.');
  }

  return Object.freeze({
    frames: Object.freeze(value['frames'].map(freezeFrameSize)),
    // Only the tools may weigh nothing: a turn without tools sends none.
    tools: freezeMeasure(value['tools'], 'tools', 0),
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
    ...freezeMeasure(value, value['kind'], 1),
  } satisfies RoleModelPromptFrameSize);
}

function freezeMeasure(
  value: unknown,
  field: string,
  minimum: number,
): RoleModelPromptSizeMeasure {
  if (!isJsonRecord(value)) {
    throw new TypeError(`Role-model prompt size ${field} is malformed.`);
  }

  return Object.freeze({
    chars: sizeNumber(value['chars'], `${field}.chars`, minimum),
    estimatedTokens: sizeNumber(
      value['estimatedTokens'],
      `${field}.estimatedTokens`,
      minimum,
    ),
  } satisfies RoleModelPromptSizeMeasure);
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
