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
  settle(id: string, decision?: SettledDecision): void;
  /**
   * The daemon's pending list, read on a handshake, is the whole truth:
   * what it holds is asked, and what it no longer holds is retired.
   */
  reconcile(pending: readonly PendingConfirmation[]): void;
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
  /** Runs once a prompt has left the screen, answered or withdrawn. */
  readonly afterPrompt?: () => void;
}): ConfirmationPrompts {
  const asked = new Set<string>();
  // Asked and not yet through the prompt: showing, or queued behind one.
  const outstanding = new Set<string>();
  const settled = new Map<string, SettledDecision | undefined>();
  let showing: {readonly id: string; withdraw(): void} | undefined;
  let chain: Promise<void> = Promise.resolve();
  // The daemon has the last word: an answer that lands after the deadline,
  // or after another surface's, is reported, never assumed to have counted.
  const answer = (
    pending: PendingConfirmation,
    decision: GatewayConfirmationDecision,
  ): Promise<void> =>
    options.client.answerConfirmation(pending.id, decision).then(
      outcome => {
        if (outcome.status === 'expired') {
          options.stdout.write(
            `${pending.request.toolName} was not ${decision}: the confirmation had expired.\n`,
          );
        } else if (outcome.status === 'unknown') {
          options.stdout.write(
            `${pending.request.toolName} was not ${decision}: it was settled elsewhere first.\n`,
          );
        }
      },
      (error: unknown) => {
        // The daemon never heard the answer; the request is still pending
        // there, and the next handshake may ask again.
        asked.delete(pending.id);
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
      await answer(pending, 'denied');

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
      await answer(pending, 'denied');

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
      await answer(pending, 'denied');

      return;
    }

    await answer(pending, cliPromptAnswerIsYes(line) ? 'approved' : 'denied');
  };

  const ask = (pending: PendingConfirmation): void => {
    if (pending.characterId !== options.characterId || asked.has(pending.id)) {
      return;
    }

    asked.add(pending.id);
    outstanding.add(pending.id);
    chain = chain.then(() =>
      prompt(pending).finally(() => {
        outstanding.delete(pending.id);
        options.afterPrompt?.();
      }),
    );
  };
  const settle = (id: string, decision?: SettledDecision): void => {
    settled.set(id, decision);

    if (showing?.id === id) {
      showing.withdraw();
    }
  };

  return {
    ask,
    settle,
    reconcile: pending => {
      const present = new Set(pending.map(request => request.id));

      for (const id of outstanding) {
        if (!present.has(id)) {
          settle(id);
        }
      }

      for (const request of pending) {
        ask(request);
      }
    },
    idle: () => chain,
  };
}
