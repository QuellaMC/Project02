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
import {createProject02HomeLayout} from '../../runtime/storage/index.ts';

export type ChatCliArgs = {
  readonly traceMode: boolean;
  readonly init: boolean;
  readonly provider?: ChatProviderName;
  readonly storeRoot?: string;
  readonly configPath?: string;
  readonly character?: string;
};

export function parseChatCliArgs(args: readonly string[]): ChatCliArgs {
  let traceMode = false;
  let provider: ChatProviderName | undefined;
  let location: RuntimeLocationCliState = {};
  let init = false;

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

    throw new CliUsageError(`Unknown chat option: ${arg}.`);
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
  } satisfies ChatCliArgs;
}

export function validateChatStoreArgs(args: ChatCliArgs): void {
  if (args.storeRoot !== undefined) {
    createProject02HomeLayout({homeRoot: args.storeRoot});
  }
}
