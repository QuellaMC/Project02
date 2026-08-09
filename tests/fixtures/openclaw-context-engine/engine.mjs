export default function register(api) {
  api.registerContextEngine('fixture-engine', () => {
    const ingested = [];

    return {
      info: {
        id: 'fixture-engine',
        name: 'Fixture Engine',
        ownsCompaction: false,
        acceptedHostParams: [],
      },
      assemble(params) {
        const prompt = params.messages.at(-1)?.content ?? '';

        return {
          messages: [],
          estimatedTokens: 8,
          systemPromptAddition: `Engine brief for "${prompt}" after ${String(
            ingested.length,
          )} ingested message(s).`,
        };
      },
      ingest(params) {
        ingested.push(params.message);

        return {ok: true};
      },
      dispose() {
        ingested.length = 0;
      },
    };
  });
}
