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

/** Code points, as JSON Schema `maxLength` counts them, not UTF-16 units. */
export function characterLength(value: string): number {
  return Array.from(value).length;
}

/** Stamped on every message, so bounded well below the 16 KiB config cap. */
export const maxSpeakerDisplayNameLength = 128;

/**
 * Mirrors the published character schema's `^\S(.*\S)?$` and `maxLength: 128`.
 * The newline ban is security: names are interpolated before a colon in chat.
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

/**
 * A client's stamp on a message it carried: the surface that said it
 * (`web`, `telegram:<bot>`) or the submission's own id. One token, so it
 * rides a URL, a log line, and a JSON body unchanged.
 */
export const clientStampPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u;

export function isValidClientStamp(value: unknown): value is string {
  return typeof value === 'string' && clientStampPattern.test(value);
}
