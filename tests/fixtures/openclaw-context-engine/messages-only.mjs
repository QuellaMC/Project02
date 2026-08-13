export default function register(api) {
  api.registerContextEngine('messages-only-engine', () => ({
    info: {id: 'messages-only-engine'},
    assemble() {
      return {
        messages: [
          {role: 'user', content: 'Assembled without a prompt addition.'},
        ],
        estimatedTokens: 4,
      };
    },
    ingest() {
      return {ok: true};
    },
  }));
}
