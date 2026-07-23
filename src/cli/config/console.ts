import {createInterface} from 'node:readline/promises';

import {
  createRuntimeConfigMutationBase,
  deriveRuntimeConfigCharacterScope,
  layeredRuntimeConfigFingerprintForScope,
  loadCharacterOverlayForScope,
  loadProject02RuntimeConfig,
  resolveScopedGlobalLayerLocation,
  type RuntimeConfigDiagnostic,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
} from '../../runtime/config/index.ts';
import {
  askForNumber,
  runtimeConfigLocation,
  writeDiagnostics,
  writeLine,
  type RuntimeConfigConsoleContext,
  type RuntimeConfigConsoleOptions,
  type RuntimeConfigConsolePromptAdapter,
  type RuntimeConfigConsoleSnapshot,
} from './console-shared.ts';
import {runProject02ConfigSection} from './console-project02.ts';
import {runPluginConfigSection} from './console-plugins.ts';

export type {
  RuntimeConfigConsoleOptions,
  RuntimeConfigConsolePromptAdapter,
} from './console-shared.ts';

export async function runRuntimeConfigConsole(
  options: RuntimeConfigConsoleOptions,
): Promise<number> {
  const ownedPrompt =
    options.prompt === undefined
      ? createDefaultPrompt(options.stdin ?? process.stdin, options.stdout)
      : undefined;
  const prompt = options.prompt ?? ownedPrompt?.prompt;

  if (prompt === undefined) {
    throw new TypeError('Runtime config console prompt could not be created.');
  }

  const context: RuntimeConfigConsoleContext = {
    ...options,
    prompt,
  };

  try {
    const snapshot = loadConsoleSnapshot(context);

    writeLine(context.stdout, 'Project02 Runtime Config');
    if (snapshot.characterScope !== undefined) {
      writeLine(
        context.stdout,
        `Scope: character ${snapshot.characterScope.characterId} (overlay)`,
      );
    }
    writeDiagnostics(context.stdout, snapshot.diagnostics);
    writeLine(context.stdout, '1) Project02');
    writeLine(context.stdout, '2) Plugins');
    writeLine(context.stdout, 'q) Quit');

    const section = await askForNumber(context, 'Select a section: ', 2);

    if (section === undefined) {
      return 0;
    }

    if (section === 1) {
      await runProject02ConfigSection(context, snapshot);
    } else {
      await runPluginConfigSection(context, snapshot);
    }

    return 0;
  } finally {
    ownedPrompt?.close();
  }
}

function consoleLoadDiagnostics(loaded: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
}): {
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly blockingDiagnostic: RuntimeConfigDiagnostic | undefined;
} {
  let blockingDiagnostic: RuntimeConfigDiagnostic | undefined;
  const diagnostics: RuntimeConfigDiagnostic[] = [];

  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.code !== 'runtime_config_missing') {
      diagnostics.push(diagnostic);
    }

    if (
      blockingDiagnostic === undefined &&
      diagnostic.severity === 'error' &&
      diagnostic.code !== 'runtime_config_missing'
    ) {
      blockingDiagnostic = diagnostic;
    }
  }

  return {diagnostics, blockingDiagnostic};
}

function loadConsoleSnapshot(
  context: RuntimeConfigConsoleContext,
): RuntimeConfigConsoleSnapshot {
  // The owning home's global layer when a character is explicitly
  // requested and --config aliases its overlay: the snapshot's
  // fingerprint must compose the same pair of documents the commit
  // path verifies against. Without --character, an explicit --config
  // keeps plain file semantics.
  const loaded =
    context.character === undefined
      ? loadProject02RuntimeConfig({
          ...runtimeConfigLocation(context),
          ...(context.env === undefined ? {} : {env: context.env}),
        })
      : loadProject02RuntimeConfig(
          resolveScopedGlobalLayerLocation({
            ...runtimeConfigLocation(context),
            ...(context.env === undefined ? {} : {env: context.env}),
            characterId: context.character,
          }),
        );
  const {diagnostics, blockingDiagnostic} = consoleLoadDiagnostics(loaded);

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot open config console because the runtime config is invalid: ${blockingDiagnostic.message}`,
    );
  }

  const config = createRuntimeConfigMutationBase({
    loadedConfig: loaded,
    ...runtimeConfigLocation(context),
  });
  const location = runtimeConfigLocation(context);
  const characterScope = deriveRuntimeConfigCharacterScope({
    loadedConfig: loaded,
    ...(location.storeRoot === undefined
      ? {}
      : {storeRoot: location.storeRoot}),
    ...(context.character === undefined
      ? {}
      : {characterId: context.character}),
  });

  if (context.character !== undefined && characterScope === undefined) {
    throw new TypeError(
      'Cannot open the config console: the character scope is unavailable ' +
        'for this store root.',
    );
  }

  const overlay =
    characterScope === undefined
      ? undefined
      : loadCharacterOverlayForScope(characterScope);
  const overlayError = overlay?.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (context.character !== undefined && overlayError !== undefined) {
    throw new TypeError(
      'Cannot open config console because the character overlay is ' +
        `invalid: ${overlayError.message}`,
    );
  }

  return Object.freeze({
    loadedConfig: loaded,
    config,
    diagnostics: Object.freeze(diagnostics),
    // Same layered composition the control operations verify against.
    fingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: config,
      characterScope,
      overlay,
    }),
    ...(context.character === undefined || characterScope === undefined
      ? {}
      : {
          characterScope,
          scopedConfig:
            overlay?.config ??
            ({version: runtimeConfigVersion} satisfies Project02RuntimeConfig),
        }),
  });
}

function createDefaultPrompt(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): {
  readonly prompt: RuntimeConfigConsolePromptAdapter;
  close(): void;
} {
  let closed = false;
  let inputError: Error | undefined;
  let rejectActiveQuestion: ((error: Error) => void) | undefined;

  const handleInputError = (error: unknown): void => {
    const detail =
      error instanceof Error && error.message.trim().length > 0
        ? `: ${error.message}`
        : '';
    const normalizedError = new TypeError(
      `Could not read runtime config console input${detail}.`,
      {cause: error},
    );

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
                  : new TypeError(
                      'Could not read runtime config console input.',
                      {
                        cause: error,
                      },
                    ),
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
