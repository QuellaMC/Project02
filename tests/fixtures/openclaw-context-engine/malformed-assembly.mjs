export default function register(api) {
  api.registerContextEngine('drifted-engine', () => ({
    info: {id: 'drifted-engine'},
    assemble() {
      return 'a later interface returns plain text';
    },
    ingest() {
      return {ok: true};
    },
  }));
}
