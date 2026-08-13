export default function createProvider() {
  return {
    prefetch() {
      return [
        {
          id: 'row-1',
          text: 'Prior detail.',
          sources: [{uuid: 'source-1'}],
        },
      ];
    },
    syncTurn() {
      return {captured: false, summary: 'Nothing.'};
    },
    search() {
      return [];
    },
    shutdown() {},
  };
}
