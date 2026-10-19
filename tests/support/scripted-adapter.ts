import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {demoConfigToneChangeOutput} from './demo-config-tool.ts';

/** Between two pieces of a paced reply: long enough for a page to show the draft. */
const pacedPieceMs = 4;

/**
 * A model scripted by the line it reads, for a daemon a real client talks
 * to. `confirm` asks for the demo-config tone change — a confirmation-gated
 * tool round — and says `done` once the round is in; `reject` writes what
 * the parser refuses; any other line is answered `noted: <line>`, spoken in
 * word pieces the way a model's reply arrives, and paced when the line
 * starts with `slowly` so a client can be seen following the draft.
 */
export function createScriptedAdapter(options: {
  readonly homeRoot: string;
  readonly characterId: string;
}): RoleModelAdapter {
  return {
    async invoke(inputEnvelope, invocation) {
      const line = inputEnvelope.event.payload.currentUserMessage;

      if (line === 'confirm') {
        return {
          rawOutputText:
            inputEnvelope.toolRounds.length === 0
              ? demoConfigToneChangeOutput(
                  options.homeRoot,
                  options.characterId,
                )
              : visibleReply('done'),
        };
      }

      if (line === 'reject') {
        return {rawOutputText: 'not a decision'};
      }

      const text = `noted: ${line}`;

      for (const piece of text.split(/(?<=\s)/u)) {
        invocation.onReplyDelta?.({reply: 0, text: piece});

        if (line.startsWith('slowly')) {
          await new Promise(resolve => setTimeout(resolve, pacedPieceMs));
        }
      }

      return {rawOutputText: visibleReply(text)};
    },
  };
}

function visibleReply(text: string): string {
  return JSON.stringify({toolCalls: [{name: 'visible_reply', input: {text}}]});
}
