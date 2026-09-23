/**
 * The one place a store is born: creation happens here, whole and in one
 * call, before any command writes, so no write precedes a rejection.
 */
import {loadProject02Home} from '../../app/index.ts';
import {ensureInitializedProject02Store} from '../../runtime/config/index.ts';
import {project02HomeCreationIsNew} from '../../runtime/storage/index.ts';
import {cliPromptAnswerIsYes, createCliPrompt} from './prompt.ts';
import type {RuntimeLocationCliState} from './runtime-location-flags.ts';

export class Project02StoreConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Project02StoreConsentError';
  }
}

type Project02StoreConsentOptions = {
  readonly location: RuntimeLocationCliState;
  /** The operator already agreed on the command line via `--init`. */
  readonly init: boolean;
  readonly stdout: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: NodeJS.ProcessEnv;
  /** A run being stopped abandons the question, which is a no. */
  readonly signal?: AbortSignal;
};

/** Returns only when a store exists at the selected home; throws otherwise. */
export async function assertProject02StoreConsent(
  options: Project02StoreConsentOptions,
): Promise<void> {
  const home = loadProject02Home({
    location: options.location,
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const homeRoot = home.runtimeLocation.homeRoot;

  if (!project02HomeCreationIsNew({homeRoot})) {
    return;
  }

  if (
    !options.init &&
    !(await operatorAgreesToCreateStore(options, homeRoot))
  ) {
    throw new Project02StoreConsentError(
      `No Project02 store at "${homeRoot}". Re-run with --init to create ` +
        'one there, or pass --store to point at an existing store.',
    );
  }

  await ensureInitializedProject02Store({homeRoot});
}

async function operatorAgreesToCreateStore(
  options: Project02StoreConsentOptions,
  homeRoot: string,
): Promise<boolean> {
  const stdin = options.stdin ?? process.stdin;

  // Nobody to ask: scripts, CI, and pipes get the flag-or-nothing answer.
  if (!stdinIsInteractive(stdin)) {
    return false;
  }

  const owned = createCliPrompt(
    stdin,
    options.stdout,
    'Could not read the store initialization answer',
  );

  try {
    return cliPromptAnswerIsYes(
      await owned.prompt.question(
        `No Project02 store at "${homeRoot}". Create one there? [y/N] `,
        options.signal,
      ),
    );
  } finally {
    owned.close();
  }
}

function stdinIsInteractive(stdin: NodeJS.ReadableStream): boolean {
  return (stdin as Partial<NodeJS.ReadStream>).isTTY === true;
}
