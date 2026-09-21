/**
 * The terminal question adapter for a CLI that asks one thing and leaves:
 * the store consent gate and the config console. A closed stream answers
 * `undefined`; a stream that fails while read rejects.
 */
import {createInterface} from 'node:readline/promises';

export type CliPromptAdapter = {
  /** An aborted signal abandons the question; that answers `undefined`. */
  question(prompt: string, signal?: AbortSignal): Promise<string | undefined>;
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
      question(
        prompt: string,
        signal?: AbortSignal,
      ): Promise<string | undefined> {
        if (closed || signal?.aborted === true) {
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
              settle(
                await readline.question(
                  prompt,
                  signal === undefined ? {} : {signal},
                ),
              );
            } catch (error: unknown) {
              if (signal?.aborted === true) {
                settle(undefined);

                return;
              }

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

/** Silence is no: nothing destructive proceeds on a stream that closed. */
export function cliPromptAnswerIsYes(answer: string | undefined): boolean {
  const normalized = answer?.trim().toLowerCase();

  return normalized === 'y' || normalized === 'yes';
}
