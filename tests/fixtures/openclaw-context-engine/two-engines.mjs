function engine(id) {
  return () => ({
    info: {id},
    assemble() {
      return {systemPromptAddition: `Assembled by ${id}.`};
    },
    ingest() {
      return {ok: true};
    },
  });
}

export default function register(api) {
  api.registerContextEngine('first-engine', engine('first-engine'));
  api.registerContextEngine('second-engine', engine('second-engine'));
}
