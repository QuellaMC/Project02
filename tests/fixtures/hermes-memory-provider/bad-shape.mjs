export default function createProvider() {
  return {
    prefetch() {
      return 'not a result shape';
    },
    syncTurn() {
      return {};
    },
    search() {
      return [];
    },
    shutdown() {},
  };
}
