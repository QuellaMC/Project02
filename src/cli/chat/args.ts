import {readFlagValue} from '../shared/flags.ts';
import {
  matchesRuntimeStoreInitFlag,
  parseRuntimeStoreFlag,
  type RuntimeLocationCliState,
} from '../shared/runtime-location-flags.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {
  parseProviderName,
  providerOption,
  type ChatProviderName,
} from '../../role-model/index.ts';
import {
  createProject02HomeLayout,
  normalizeLocalRuntimeSessionId,
} from '../../runtime/storage/index.ts';

export type ChatCliArgs = {
  readonly traceMode: boolean;
  readonly init: boolean;
  readonly provider?: ChatProviderName;
  readonly storeRoot?: string;
  readonly configPath?: string;
  readonly character?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
};

export function parseChatCliArgs(args: readonly string[]): ChatCliArgs {
  let traceMode = false;
  let provider: ChatProviderName | undefined;
  let location: RuntimeLocationCliState = {};
  let init = false;
  let sessionId: string | undefined;
  let newSessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      continue;
    }

    if (arg === '--trace') {
      traceMode = true;
      continue;
    }

    if (arg === '--provider') {
      if (provider !== undefined) {
        throw new CliUsageError('--provider can only be provided once.');
      }

      provider = parseProviderName(readFlagValue(args, index, '--provider'));
      index += 1;
      continue;
    }

    if (matchesRuntimeStoreInitFlag(arg, init)) {
      init = true;
      continue;
    }

    const storeResult = parseRuntimeStoreFlag({
      args,
      index,
      location,
    });

    if (storeResult.status === 'matched') {
      location = storeResult.location;
      index = storeResult.nextIndex;
      continue;
    }

    if (arg === '--session') {
      if (sessionId !== undefined) {
        throw new CliUsageError('--session can only be provided once.');
      }

      sessionId = readFlagValue(args, index, '--session');
      index += 1;
      continue;
    }

    if (arg === '--new-session') {
      if (newSessionId !== undefined) {
        throw new CliUsageError('--new-session can only be provided once.');
      }

      newSessionId = readFlagValue(args, index, '--new-session');
      index += 1;
      continue;
    }

    throw new CliUsageError(`Unknown chat option: ${arg}.`);
  }

  if (sessionId !== undefined && newSessionId !== undefined) {
    throw new CliUsageError('Use either --session or --new-session, not both.');
  }

  return {
    traceMode,
    init,
    ...providerOption(provider),
    ...(location.character === undefined
      ? {}
      : {character: location.character}),
    ...(location.storeRoot === undefined
      ? {}
      : {storeRoot: location.storeRoot}),
    ...(location.configPath === undefined
      ? {}
      : {configPath: location.configPath}),
    ...(sessionId === undefined ? {} : {sessionId}),
    ...(newSessionId === undefined ? {} : {newSessionId}),
  } satisfies ChatCliArgs;
}

export function validateDurableSessionArgs(args: ChatCliArgs): void {
  if (args.storeRoot !== undefined) {
    createProject02HomeLayout({homeRoot: args.storeRoot});
  }

  if (args.sessionId !== undefined) {
    normalizeLocalRuntimeSessionId(args.sessionId);
  }

  if (args.newSessionId !== undefined) {
    normalizeLocalRuntimeSessionId(args.newSessionId);
  }
}
