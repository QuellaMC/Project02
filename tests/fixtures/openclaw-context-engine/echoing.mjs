export default function register(api) {
  api.registerContextEngine('echoing-engine', () => ({
    info: {id: 'echoing-engine'},
    assemble(params) {
      return {
        messages: [
          ...params.messages,
          {role: 'assistant', content: 'Recalled: they take tea black.'},
        ],
      };
    },
    ingest() {
      return {ok: true};
    },
  }));
}
