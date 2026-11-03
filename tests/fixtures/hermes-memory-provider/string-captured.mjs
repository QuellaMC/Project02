export default function createProvider() {
  return {
    prefetch() {
      return [];
    },
    syncTurn() {
      return {captured: 'false', summary: 'Ambiguous acknowledgement.'};
    },
    search() {
      return [];
    },
    shutdown() {},
  };
}
