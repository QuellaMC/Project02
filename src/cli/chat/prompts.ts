/**
 * Confirmation prompts for this terminal's own turns. A turn's tool may ask
 * for approval while the REPL is blocked in that turn, so the prompt is the
 * only reader then; the person approves exactly what will happen — the
 * summary and the full change — with a line typed after the prompt. A
 * prompt settled elsewhere is withdrawn rather than answered twice.
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
  settle(id: string): void;
  /** The daemon's list on a handshake: what it lacks was settled meanwhile. */
  reconcile(pending: readonly PendingConfirmation[]): void;
  /** Resolves once no prompt is showing or queued. */
  idle(): Promise<void>;
};

export function createConfirmationPrompts(options: {
  readonly client: Pick<GatewayClient, 'answerConfirmation'>;
  readonly lines: Pick<LineDispatcher, 'promptLine'>;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly signal?: AbortSignal;
}): ConfirmationPrompts {
  const call = options.signal === undefined ? {} : {signal: options.signal};
  const asked = new Set<string>();
  const settled = new Set<string>();
  let showing: {readonly id: string; withdraw(): void} | undefined;
  let chain: Promise<void> = Promise.resolve();
  /** Whether the daemon took the answer. */
  const answer = async (
    pending: PendingConfirmation,
    decision: GatewayConfirmationDecision,
  ): Promise<boolean> => {
    try {
      const outcome = await options.client.answerConfirmation(
        pending.id,
        decision,
        call,
      );

      // The daemon has the last word: an answer it did not take is said.
      // Unknown to it means settled before this answer — elsewhere, or by
      // an answer of this terminal's whose reply was lost — so nothing
      // here says what that settlement was.
      if (outcome.status === 'expired') {
        options.stdout.write(
          `${pending.request.toolName} was not ${decision}: the confirmation had expired.\n`,
        );
      } else if (outcome.status === 'unknown') {
        options.stdout.write(
          `${pending.request.toolName} was settled before this answer.\n`,
        );
      }

      return true;
    } catch (error: unknown) {
      options.stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );

      return false;
    }
  };
  const prompt = async (pending: PendingConfirmation): Promise<void> => {
    if (settled.has(pending.id) || Date.now() >= pending.deadlineAt) {
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
        `\n${pending.request.toolName} was settled meanwhile.\n`,
      );

      return;
    }

    if (Date.now() >= pending.deadlineAt) {
      options.stderr.write(
        'Confirmation timed out; the answer was discarded.\n',
      );

      return;
    }

    const taken = await answer(
      pending,
      cliPromptAnswerIsYes(line) ? 'approved' : 'denied',
    );

    // Not heard while a person is still here to answer: the daemon holds
    // the request, so it is asked once more at once — within this same
    // turn of the chain, so a REPL waiting for the chain to go idle waits
    // through the retry too. Once the input ended, or on this terminal's
    // own exit, nobody can answer again.
    if (!taken && line !== undefined && !(options.signal?.aborted ?? false)) {
      await prompt(pending);
    }
  };
  const settle = (id: string): void => {
    settled.add(id);

    if (showing?.id === id) {
      showing.withdraw();
    }
  };

  const ask = (pending: PendingConfirmation): void => {
    if (asked.has(pending.id)) {
      return;
    }

    asked.add(pending.id);
    chain = chain.then(() => prompt(pending));
  };

  return {
    ask,
    settle,
    reconcile(pending) {
      const present = new Set(pending.map(request => request.id));

      for (const id of asked) {
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
