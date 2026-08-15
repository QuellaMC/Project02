import {createCliPrompt, type OwnedCliPrompt} from '../shared/prompt.ts';
import {
  createRuntimeConfigAuthoredSnapshot,
  layeredRuntimeConfigFingerprintForScope,
  readCharacterOverlayForScope,
  type RuntimeConfigDiagnostic,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
} from '../../runtime/config/index.ts';
import {
  askForNumber,
  consoleCatalogManifests,
  writeDiagnostics,
  writeLine,
  type RuntimeConfigConsoleContext,
  type RuntimeConfigConsoleOptions,
  type RuntimeConfigConsoleSnapshot,
} from './console-shared.ts';
import {runProject02ConfigSection} from './console-project02.ts';
import {runPluginConfigSection} from './console-plugins.ts';

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
    if (snapshot.scope === 'character') {
      writeLine(
        context.stdout,
        `Scope: character ${snapshot.runtimeLocation.characterScope.characterId} (overlay)`,
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
  const loaded = context.loadedConfig;
  const runtimeLocation = context.runtimeLocation;
  const {diagnostics, blockingDiagnostic} = consoleLoadDiagnostics(loaded);

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot open config console because the runtime config is invalid: ${blockingDiagnostic.message}`,
    );
  }

  const authoredSnapshot = createRuntimeConfigAuthoredSnapshot(loaded);
  const config = authoredSnapshot.validatedConfig;

  if (config === undefined) {
    throw new TypeError(
      'Cannot open config console without a valid authored or bootstrap config.',
    );
  }
  const overlay = readCharacterOverlayForScope(
    runtimeLocation.characterScope,
  ).overlay;
  const overlayError = overlay.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (context.scope === 'character' && overlayError !== undefined) {
    throw new TypeError(
      'Cannot open config console because the character overlay is ' +
        `invalid: ${overlayError.message}`,
    );
  }

  return Object.freeze({
    loadedConfig: loaded,
    runtimeLocation,
    scope: context.scope,
    config,
    overlay,
    diagnostics: Object.freeze(diagnostics),
    // Same layered composition the control operations verify against.
    fingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: config,
      characterScope: runtimeLocation.characterScope,
      overlay,
      pluginManifests: consoleCatalogManifests(context),
    }),
    ...(context.scope === 'global'
      ? {}
      : {
          scopedConfig:
            overlay.config ??
            ({version: runtimeConfigVersion} satisfies Project02RuntimeConfig),
        }),
  });
}

function createDefaultPrompt(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): OwnedCliPrompt {
  return createCliPrompt(
    stdin,
    stdout,
    'Could not read runtime config console input',
  );
}
