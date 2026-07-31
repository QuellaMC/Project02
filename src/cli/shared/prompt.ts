/**
 * The one terminal question adapter every CLI asks through.
 *
 * A closed stream answers `undefined` rather than throwing, because
 * "the operator is not there to answer" is a normal outcome each caller
 * decides for itself: the config console quits, the store gate refuses.
 * A stream that fails while being read is not that, and rejects.
 */
import {createInterface} from 'node:readline/promises';

export type CliPromptAdapter = {
  question(prompt: string): Promise<string | undefined>;
};

export type OwnedCliPrompt = {
  readonly prompt: CliPromptAdapter;
  close(): void;
};

export function createCliPrompt(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  inputErrorMessage: string,
): OwnedCliPrompt {
  let closed = false;
  let inputError: Error | undefined;
  let rejectActiveQuestion: ((error: Error) => void) | undefined;

  const handleInputError = (error: unknown): void => {
    const detail =
      error instanceof Error && error.message.trim().length > 0
        ? `: ${error.message}`
        : '';
    const normalizedError = new TypeError(`${inputErrorMessage}${detail}.`, {
      cause: error,
    });

    inputError = normalizedError;
    rejectActiveQuestion?.(normalizedError);
  };
  stdin.on('error', handleInputError);
  const readline = createInterface({input: stdin, output: stdout});

  readline.once('close', () => {
    closed = true;
  });
  readline.on('error', handleInputError);

  return {
    prompt: Object.freeze({
      question(prompt: string): Promise<string | undefined> {
        if (closed) {
          return Promise.resolve(undefined);
        }

        if (inputError !== undefined) {
          return Promise.reject(inputError);
        }

        return new Promise<string | undefined>((resolve, reject) => {
          let settled = false;
          const settle = (answer: string | undefined): void => {
            if (settled) {
              return;
            }

            settled = true;
            rejectActiveQuestion = undefined;
            readline.off('close', handleClose);
            resolve(answer);
          };
          const rejectQuestion = (error: Error): void => {
            if (settled) {
              return;
            }

            settled = true;
            rejectActiveQuestion = undefined;
            readline.off('close', handleClose);
            reject(error);
          };
          const handleClose = (): void => {
            settle(undefined);
          };

          rejectActiveQuestion = rejectQuestion;
          readline.once('close', handleClose);
          void (async () => {
            try {
              settle(await readline.question(prompt));
            } catch (error: unknown) {
              rejectQuestion(
                error instanceof Error
                  ? error
                  : new TypeError(`${inputErrorMessage}.`, {cause: error}),
              );
            }
          })();
        });
      },
    }),
    close() {
      stdin.off('error', handleInputError);
      readline.off('error', handleInputError);
      readline.close();
    },
  };
}

/**
 * One reading of a yes/no answer, so "y" means the same thing at every
 * prompt. Silence is no: an absent answer is a stream that closed, and
 * nothing destructive should proceed on it.
 */
export function cliPromptAnswerIsYes(answer: string | undefined): boolean {
  const normalized = answer?.trim().toLowerCase();

  return normalized === 'y' || normalized === 'yes';
}
