/**
 * Confirmation prompts chain: each prints only when it is next and consumes
 * its own line, so one keystroke never approves two proposed effects. The
 * person approves exactly what will happen — the summary and the full
 * change — only for the character this terminal talks to, and a prompt
 * answered on another surface is withdrawn here rather than answered twice.
 */
import type {GatewayClient} from '../../gateway/client/index.ts';
import type {
  GatewayConfirmationDecision,
  PendingConfirmation,
} from '../../gateway/index.ts';
import {cliPromptAnswerIsYes} from '../shared/prompt.ts';
import type {LineDispatcher} from './lines.ts';

export type ConfirmationPrompts = {
  ask(pending: PendingConfirmation): void;
  /** The daemon settled it — here or elsewhere; nothing to ask any more. */
  settle(id: string, decision: SettledDecision): void;
  /** Resolves once no prompt is showing or queued. */
  idle(): Promise<void>;
};

export type SettledDecision = GatewayConfirmationDecision | 'cancelled';

export function createConfirmationPrompts(options: {
  readonly client: Pick<GatewayClient, 'answerConfirmation'>;
  readonly characterId: string;
  readonly lines: Pick<LineDispatcher, 'promptLine'>;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}): ConfirmationPrompts {
  const asked = new Set<string>();
  const settled = new Map<string, SettledDecision>();
  let showing: {readonly id: string; withdraw(): void} | undefined;
  let chain: Promise<void> = Promise.resolve();
  const answer = (
    id: string,
    decision: GatewayConfirmationDecision,
  ): Promise<void> =>
    options.client.answerConfirmation(id, decision).then(
      () => undefined,
      (error: unknown) => {
        options.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  const prompt = async (pending: PendingConfirmation): Promise<void> => {
    if (settled.has(pending.id)) {
      return;
    }

    // Expired while queued: the daemon already cancelled it, and asking
    // now would feed the answer to the REPL.
    if (Date.now() >= pending.deadlineAt) {
      await answer(pending.id, 'denied');

      return;
    }

    options.stdout.write(
      `Confirm ${pending.request.toolName} (${pending.request.pluginId}): ` +
        `${pending.request.summary}\n` +
        `${JSON.stringify(pending.request.preview, null, 2)}\n[y/N] `,
    );

    const withdrawn = new AbortController();
    let line: string | undefined;

    showing = {
      id: pending.id,
      withdraw: () => {
        withdrawn.abort();
      },
    };

    try {
      line = await options.lines.promptLine(withdrawn.signal);
    } catch {
      // A failed read is a denial, never a parked confirmation.
      await answer(pending.id, 'denied');

      return;
    } finally {
      showing = undefined;
    }

    if (withdrawn.signal.aborted) {
      options.stdout.write(
        `\n${pending.request.toolName} was ${settled.get(pending.id) ?? 'settled'} elsewhere.\n`,
      );

      return;
    }

    if (Date.now() >= pending.deadlineAt) {
      options.stderr.write(
        'Confirmation timed out; the answer was discarded.\n',
      );
      await answer(pending.id, 'denied');

      return;
    }

    await answer(
      pending.id,
      cliPromptAnswerIsYes(line) ? 'approved' : 'denied',
    );
  };

  return {
    ask: pending => {
      if (
        pending.characterId !== options.characterId ||
        asked.has(pending.id)
      ) {
        return;
      }

      asked.add(pending.id);
      chain = chain.then(() => prompt(pending));
    },
    settle: (id, decision) => {
      settled.set(id, decision);

      if (showing?.id === id) {
        showing.withdraw();
      }
    },
    idle: () => chain,
  };
}
