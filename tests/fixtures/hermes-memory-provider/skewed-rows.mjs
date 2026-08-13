export default function createProvider() {
  return {
    prefetch() {
      return [{uuid: 'row-1', content: 'A later row shape.'}];
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
