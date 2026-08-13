export default function createProvider() {
  return {
    prefetch() {
      return {items: []};
    },
    search() {
      return [];
    },
    shutdown() {},
  };
}
