import type {
  RuntimePluginDatabaseOpener,
  RuntimePluginSessionHistoryFeed,
} from '../../api/index.ts';

export type SessionHistoryCapabilities = {
  readonly sessionHistory: RuntimePluginSessionHistoryFeed;
  readonly sessionHistoryDatabase: RuntimePluginDatabaseOpener;
};

const sessionHistoryCapabilitySnapshots =
  new WeakSet<SessionHistoryCapabilities>();

/**
 * Injected by the composition root; the plugin never imports the
 * implementations. Frozen so caller mutation cannot retarget the
 * advertised history tools.
 */
export function createSessionHistoryCapabilitiesSnapshot(
  capabilities: SessionHistoryCapabilities,
): SessionHistoryCapabilities {
  if (sessionHistoryCapabilitySnapshots.has(capabilities)) {
    return capabilities;
  }

  const feed = capabilities.sessionHistory;

  if (typeof feed !== 'object') {
    throw new TypeError('sessionHistory must be an object.');
  }

  if (typeof feed.characterId !== 'string' || feed.characterId.length === 0) {
    throw new TypeError('sessionHistory must carry a non-empty characterId.');
  }

  for (const methodName of ['listSessions', 'readNewMessages'] as const) {
    if (typeof feed[methodName] !== 'function') {
      throw new TypeError(`sessionHistory.${methodName} must be a function.`);
    }
  }

  if (typeof capabilities.sessionHistoryDatabase !== 'function') {
    throw new TypeError('sessionHistoryDatabase must be a function.');
  }

  const snapshot = Object.freeze({
    sessionHistory: Object.freeze({
      characterId: feed.characterId,
      listSessions: () => feed.listSessions(),
      readNewMessages: options => feed.readNewMessages(options),
    } satisfies RuntimePluginSessionHistoryFeed),
    sessionHistoryDatabase: (options =>
      capabilities.sessionHistoryDatabase(
        options,
      )) satisfies RuntimePluginDatabaseOpener,
  } satisfies SessionHistoryCapabilities);

  sessionHistoryCapabilitySnapshots.add(snapshot);
  return snapshot;
}
