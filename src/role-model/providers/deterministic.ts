import {type CharacterAgent, type VisibleMessage} from '../../core/index.ts';

export function createDeterministicCharacterAgent(): CharacterAgent {
  return {
    reply(input) {
      const previousUserMessage = findPreviousUserMessage(
        input.recentVisibleMessages,
      );

      if (previousUserMessage === undefined) {
        return {
          text: "I'm here. Tell me what you need.",
        };
      }

      return {
        text: `I remember you said "${previousUserMessage.text}" Stay with me for a minute.`,
      };
    },
  };
}

function findPreviousUserMessage(
  visibleMessages: readonly VisibleMessage[],
): VisibleMessage | undefined {
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const visibleMessage = visibleMessages[index];

    if (visibleMessage?.role === 'user') {
      return visibleMessage;
    }
  }

  return undefined;
}
