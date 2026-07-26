export const oneLineMessageMissingErrorMessage =
  'Provide exactly one non-empty message.';
export const oneLineMessageMultilineErrorMessage =
  'Provide exactly one non-empty single-line message.';

const lineBreakPattern = /[\r\n\u2028\u2029]/u;

export type OneLineMessageValidationReason = 'empty' | 'multiline';
export type VisibleMessageTextValidationReason = 'empty';

export class OneLineMessageValidationError extends Error {
  readonly reason: OneLineMessageValidationReason;

  constructor(reason: OneLineMessageValidationReason) {
    super(
      reason === 'empty'
        ? oneLineMessageMissingErrorMessage
        : oneLineMessageMultilineErrorMessage,
    );
    this.name = 'OneLineMessageValidationError';
    this.reason = reason;
  }
}

export class VisibleMessageTextValidationError extends Error {
  readonly reason: VisibleMessageTextValidationReason;

  constructor(reason: VisibleMessageTextValidationReason) {
    super('Provide a non-empty visible message.');
    this.name = 'VisibleMessageTextValidationError';
    this.reason = reason;
  }
}

export function normalizeOneLineMessage(message: string | undefined): string {
  const rawMessage = message ?? '';
  const normalizedMessage = rawMessage.trim();

  if (normalizedMessage.length === 0) {
    throw new OneLineMessageValidationError('empty');
  }

  if (lineBreakPattern.test(rawMessage)) {
    throw new OneLineMessageValidationError('multiline');
  }

  return normalizedMessage;
}

/**
 * Counts characters the way a published JSON Schema `maxLength` does.
 *
 * `String.length` counts UTF-16 code units, so any astral character -- emoji,
 * many CJK extension ideographs -- counts twice. A bound stated in a schema
 * the package author validates against therefore has to be measured in code
 * points here, or an editor-valid package is rejected at activation for being
 * half its documented length.
 */
export function characterLength(value: string): number {
  // `Array.from` iterates code points, matching how a JSON Schema counts.
  // Both callers bound short strings, so this stays simple rather than
  // guarding the common all-BMP case.
  return Array.from(value).length;
}

/**
 * Bound shared by every speaker display name, character or user.
 *
 * The name is stamped into `speakerName` on each message, so it repeats per
 * turn in durable logs, rehydration, inspection, and the prompt. The generic
 * config boundary only caps strings at 16 KiB, which is far too large to repeat
 * that often.
 */
export const maxSpeakerDisplayNameLength = 128;

/**
 * Answers whether a value may be stamped onto messages as a speaker name.
 *
 * One line, trimmed, non-empty, bounded — the same rule the published character
 * schema states as `^\S(.*\S)?$` with `maxLength: 128`. The one-line part
 * matters beyond tidiness: names are interpolated before a colon in chat and
 * relay output, so an embedded newline lets a name forge additional lines.
 */
export function isValidSpeakerDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    characterLength(value) <= maxSpeakerDisplayNameLength &&
    value === value.trim() &&
    !lineBreakPattern.test(value)
  );
}

export function normalizeVisibleMessageText(
  message: string | undefined,
): string {
  const normalizedMessage = message?.replace(/\r\n?/gu, '\n').trim() ?? '';

  if (normalizedMessage.length === 0) {
    throw new VisibleMessageTextValidationError('empty');
  }

  return normalizedMessage;
}
