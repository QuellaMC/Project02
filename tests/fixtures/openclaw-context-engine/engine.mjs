export default function register(api) {
  api.registerContextEngine('fixture-engine', ctx => {
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
        const label = ctx.config?.label;
        const credential = ctx.config?.apiKey === undefined ? '' : ' credential:present';

        return {
          messages:
            label === undefined ? [] : [{role: 'user', content: `label:${label}`}],
          estimatedTokens: 8,
          systemPromptAddition: `Engine brief for "${prompt}" after ${String(
            ingested.length,
          )} ingested message(s). budget=${String(params.tokenBudget)}${credential}`,
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
