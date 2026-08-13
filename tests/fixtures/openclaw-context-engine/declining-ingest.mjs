export default function register(api) {
  api.registerContextEngine('declining-engine', () => ({
    info: {id: 'declining-engine'},
    assemble() {
      return {systemPromptAddition: 'Engine brief.'};
    },
    ingest() {
      return {ok: false, reason: 'quota exhausted'};
    },
  }));
}
