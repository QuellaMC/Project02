export default function createProvider() {
  const synced = [];

  return {
    prefetch(query) {
      return {
        items: [
          {
            id: 'row-1',
            text: `Prefetched for "${query}" after ${String(synced.length)} synced turn(s).`,
            sources: [{id: 'row-1', title: 'Fixture row'}],
          },
        ],
      };
    },
    syncTurn(userMessage, assistantMessage) {
      synced.push([userMessage, assistantMessage]);

      return {sources: [{id: `sync-${String(synced.length)}`}]};
    },
    search(query) {
      return [{id: 'search-1', memory: `Search hit for "${query}".`}];
    },
    shutdown() {
      synced.length = 0;
    },
  };
}
