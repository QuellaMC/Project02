/**
 * The one place a store is born, and the one place a CLI asks first.
 *
 * Every command used to create one silently at whatever `--store`
 * pointed at — including `inspect`, which is otherwise read-only — so a
 * typo produced a new home rather than an error. This gate answers the
 * question once, before any command reaches the startup that writes,
 * and when the answer is yes it performs the creation itself.
 *
 * Creating here rather than leaving it to each route is what makes a
 * store whole: one call to the initializer writes the marker, the
 * character-data root, and the global config together. Routes used to
 * each create their own fragment — `check` a marker with no config, a
 * global `set` a config with no marker — so the same directory answered
 * "is this a store?" differently depending on which command reached it
 * first. Downstream initialization is idempotent, so every route still
 * runs its own and simply finds the home already there.
 *
 * It is home-level on purpose. A `character-data/<id>/` directory inside
 * a home the operator already made is ordinary use of that home, not a
 * new store, so `--character nova` keeps working without asking.
 *
 * Placed here rather than in startup because asking a human is async and
 * `planRuntimeCliActivationStartup` is deliberately synchronous — that
 * split is what guarantees no write precedes a rejection. Standing on
 * the config-stage startup instead costs nothing: it resolves the home
 * without creating anything, and refusing here means the command never
 * reaches the implicit creators either (lock roots, atomic writes).
 */
import {resolveRuntimeCliStartup} from '../../app/index.ts';
import {
  ensureInitializedProject02Store,
  type ResolvedProject02ConfigLocation,
} from '../../runtime/config/index.ts';
import {project02HomeCreationIsNew} from '../../runtime/storage/index.ts';
import {cliPromptAnswerIsYes, createCliPrompt} from './prompt.ts';
import type {RuntimeLocationCliState} from './runtime-location-flags.ts';

export class Project02StoreConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Project02StoreConsentError';
  }
}

export type Project02StoreConsentOptions = {
  readonly location: RuntimeLocationCliState;
  /** The operator already agreed on the command line via `--init`. */
  readonly init: boolean;
  readonly stdout: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: NodeJS.ProcessEnv;
  /** How the command's own env staging resolves a cwd `.env`. */
  readonly cwdDotEnv?: 'always' | 'auto';
  /**
   * What the run would bring into being. Most routes stand up the home
   * itself — character data, locks, activation state — so a missing one
   * is a store this run would create.
   *
   * `'selected-config'` routes write only the config document the
   * operator named. An explicit `--config` or env-selected path is a
   * standalone file with no home semantics, so such a run creates no
   * store and has nothing to ask about; the same verb against a home
   * still does. Defaults to `'home'`.
   */
  readonly creates?: 'home' | 'selected-config';
};

/**
 * Throws unless a store already exists at the selected home, or the
 * operator agrees to create one — in which case it creates it, whole,
 * before returning. Returning normally means the command may proceed
 * against a store that is already there.
 */
export async function assertProject02StoreConsent(
  options: Project02StoreConsentOptions,
): Promise<void> {
  const startup = resolveRuntimeCliStartup({
    stage: 'config',
    location: options.location,
    ...(options.cwdDotEnv === undefined ? {} : {cwdDotEnv: options.cwdDotEnv}),
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const homeRoot = startup.runtimeLocation.homeRoot;

  if (
    !runWouldCreateStore(options, startup.runtimeLocation) ||
    !project02HomeCreationIsNew({homeRoot})
  ) {
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

/**
 * Whether the run reaches a home at all. A `'selected-config'` route
 * writes one document: owned by a home, that write is the home's first
 * content and creates it; standalone, it is a file the operator named
 * and no store comes into being.
 */
function runWouldCreateStore(
  options: Project02StoreConsentOptions,
  runtimeLocation: ResolvedProject02ConfigLocation,
): boolean {
  return (
    options.creates !== 'selected-config' ||
    runtimeLocation.selectedConfig.owner.kind === 'home'
  );
}

async function operatorAgreesToCreateStore(
  options: Project02StoreConsentOptions,
  homeRoot: string,
): Promise<boolean> {
  const stdin = options.stdin ?? process.stdin;

  // A non-interactive run has nobody to ask, and guessing on their
  // behalf is the behavior this gate exists to remove: scripts, CI, and
  // pipes get the flag-or-nothing answer.
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
      ),
    );
  } finally {
    owned.close();
  }
}

function stdinIsInteractive(stdin: NodeJS.ReadableStream): boolean {
  return (stdin as Partial<NodeJS.ReadStream>).isTTY === true;
}
