export type RelayAgent = {
  reply(input: {
    readonly message: string;
  }): Promise<{ readonly text: string }> | { readonly text: string };
};

export type RelayResult = {
  readonly input: {
    readonly message: string;
  };
  readonly reply: {
    readonly text: string;
  };
};

const inputErrorMessage = 'Provide exactly one non-empty message.';

export class RelayInputError extends Error {
  constructor(message = inputErrorMessage) {
    super(message);
    this.name = 'RelayInputError';
  }
}

export async function relayMessage(
  message: string | undefined,
  agent: RelayAgent
): Promise<RelayResult> {
  const normalizedMessage = normalizeMessage(message);
  const reply = await agent.reply({ message: normalizedMessage });

  if (reply.text.trim().length === 0) {
    throw new Error('Relay agent returned an empty reply.');
  }

  return {
    input: {
      message: normalizedMessage
    },
    reply: {
      text: reply.text
    }
  };
}

export function createLocalRelayAgent(): RelayAgent {
  return {
    reply(input) {
      return {
        text: `relay: ${input.message}`
      };
    }
  };
}

function normalizeMessage(message: string | undefined): string {
  const normalizedMessage = message?.trim() ?? '';

  if (normalizedMessage.length === 0) {
    throw new RelayInputError();
  }

  return normalizedMessage;
}
