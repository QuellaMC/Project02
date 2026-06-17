export const oneLineMessageMissingErrorMessage = 'Provide exactly one non-empty message.';
export const oneLineMessageMultilineErrorMessage =
  'Provide exactly one non-empty single-line message.';

const lineBreakPattern = /[\r\n]/u;

export type OneLineMessageValidationReason = 'empty' | 'multiline';
export type VisibleMessageTextValidationReason = 'empty';

export class OneLineMessageValidationError extends Error {
  readonly reason: OneLineMessageValidationReason;

  constructor(reason: OneLineMessageValidationReason) {
    super(
      reason === 'empty'
        ? oneLineMessageMissingErrorMessage
        : oneLineMessageMultilineErrorMessage
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
  const normalizedMessage = message?.trim() ?? '';

  if (normalizedMessage.length === 0) {
    throw new OneLineMessageValidationError('empty');
  }

  if (lineBreakPattern.test(normalizedMessage)) {
    throw new OneLineMessageValidationError('multiline');
  }

  return normalizedMessage;
}

export function normalizeVisibleMessageText(
  message: string | undefined
): string {
  const normalizedMessage = message?.replace(/\r\n?/gu, '\n').trim() ?? '';

  if (normalizedMessage.length === 0) {
    throw new VisibleMessageTextValidationError('empty');
  }

  return normalizedMessage;
}
