/**
 * The one error a CLI throws for a command line it cannot use. Every
 * entrypoint catches it and prints the message, so the text is the whole
 * report the operator gets.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}
