export default function register(api) {
  api.registerContextEngine('broken-engine', () => ({
    info: {id: 'broken-engine'},
    assemble() {
      return {messages: [], estimatedTokens: 0};
    },
  }));
}
