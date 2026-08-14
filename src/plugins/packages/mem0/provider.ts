import type {
  MemoryRecallItem,
  Project02MemoryProvider,
} from '../../builtin/memory-provider/index.ts';
import {
  Mem0RequestError,
  type Mem0Backend,
  type Mem0ChatMessage,
} from './backend.ts';

export const mem0PluginId = 'mem0';

/**
 * How many turns may wait on extraction at once. Deep enough to ride out
 * a slow local model, shallow enough that a session cannot grow a queue
 * it will never finish.
 */
const mem0MaxPendingCaptures = 8;

/**
 * Per-capture bound. A local model can legitimately take tens of seconds
 * to extract; past a minute the request is stuck, and settling it is what
 * lets the queue advance instead of losing every later turn behind it.
 */
const mem0CaptureTimeoutMs = 60_000;

/** Node's timer ceiling; beyond it a timeout fires immediately. */
const maximumDrainWaitMs = 2_147_483_647;

export function createMem0MemoryProvider(options: {
  readonly backend: Mem0Backend;
  readonly userId: string;
  readonly agentId: string;
  /** Display name spoken in captured turns, so memories name the person. */
  readonly userName: string;
}): Project02MemoryProvider {
  const {backend, userId, agentId, userName} = options;
  // Capture runs behind the turn: the next prompt never needs the memory
  // that is still being extracted, so the hook only queues. Work chains
  // serially, close() drains it, and health carries the last outcome so
  // background failures stay observable.
  let captureQueue: Promise<void> = Promise.resolve();
  let lastCaptureSummary: string | undefined;
  // Background work outlives the hook that queued it, so it needs its own
  // cancellation: the turn's signal is already abandoned, and close()
  // must be able to stop a stalled request instead of waiting forever.
  const backgroundWork = new AbortController();
  let pendingCaptures = 0;
  // A queued capture has no retry, so a capture that did not complete is
  // a turn memory may not hold: the count is a running total for the
  // provider's lifetime, not a streak a later success can clear. What
  // exactly happened to the most recent one is in its own message --
  // refused, rejected, or abandoned with its outcome unknown.
  let incompleteCaptures = 0;
  let lastLossSummary: string | undefined;

  return {
    id: mem0PluginId,
    displayName: 'Mem0 Memory',
    async recall(request) {
      const hits = await backend.search({
        query: request.currentUserMessage,
        userId,
        agentId,
        limit: request.maxItems,
        signal: request.signal,
      });

      return {items: hits.map(memoryItemFromHit)};
    },
    captureTurn(turn) {
      // Extraction names entities from the conversation text, so speakers
      // introduce themselves; role labels alone would surface as memories
      // about "user" and "assistant", which mean nothing in roleplay.
      const characterName = turn.characterName ?? 'The character';
      // The session's own speaker wins: a reopened session keeps the name
      // its transcript was recorded under, whatever the config now says.
      const speaker = turn.userName ?? userName;
      const messages: Mem0ChatMessage[] = [
        {role: 'user', content: `${speaker}: ${turn.userMessage}`},
        ...(turn.characterMessage === undefined
          ? []
          : [
              {
                role: 'assistant' as const,
                content: `${characterName}: ${turn.characterMessage}`,
              },
            ]),
      ];

      // Extraction can be slower than the user types, and an unbounded
      // chain would grow for the whole session while recall fell further
      // behind. Past the backlog limit the turn is refused outright, which
      // the summary and health both say, rather than queued forever.
      if (pendingCaptures >= mem0MaxPendingCaptures) {
        incompleteCaptures += 1;
        lastLossSummary = `${String(incompleteCaptures)} capture(s) did not complete; most recent: extraction backlog is full (${String(mem0MaxPendingCaptures)} queued), so the turn was never sent.`;

        return Promise.resolve({
          captured: false,
          summary:
            'Memory extraction is behind; this turn was not queued for capture.',
        });
      }

      pendingCaptures += 1;
      captureQueue = captureQueue.then(async () => {
        // The turn is committed and the user is waiting on the reply, not
        // on extraction: yielding here keeps the hook's own return ahead
        // of any backend work, whatever shape that backend has.
        await new Promise(resolve => {
          setImmediate(resolve);
        });

        try {
          const references = await backend.add({
            messages,
            userId,
            agentId,
            runId: turn.sessionId,
            // Same provenance an explicit add carries: a memory extracted
            // from a turn must be traceable to it too.
            sourceIds: turn.sourceReferences.map(reference => reference.id),
            // The backend owns extraction: it decides what becomes memory.
            infer: true,
            // Each job gets its own bound: the hook timeout was already
            // honored at queue time, and one stalled extraction must
            // settle instead of holding every later capture behind it.
            signal: AbortSignal.any([
              backgroundWork.signal,
              AbortSignal.timeout(mem0CaptureTimeoutMs),
            ]),
          });

          // A queue receipt is an acknowledgement, not a stored memory:
          // the platform may still reject what it accepted.
          const stored = references.filter(
            reference => reference.kind === 'memory',
          ).length;

          lastCaptureSummary =
            references.length === 0
              ? 'No memory extracted from the last captured turn.'
              : stored === 0
                ? 'Queued the last captured turn with the backend.'
                : `Stored ${String(stored)} memory item(s) from the last captured turn.`;
        } catch (error: unknown) {
          incompleteCaptures += 1;
          lastLossSummary = `${String(incompleteCaptures)} capture(s) did not complete; most recent: ${captureFailureMessage(error)}`;
        } finally {
          pendingCaptures -= 1;
        }
      });

      return Promise.resolve({
        captured: true,
        // Losses ride along into this turn's durable evidence: health
        // reports them too, but a reload builds a fresh provider and its
        // count starts over, while the turn record does not.
        summary:
          incompleteCaptures === 0
            ? 'Queued turn for memory extraction.'
            : `Queued turn for memory extraction. ${String(incompleteCaptures)} earlier capture(s) did not complete.`,
        sourceReferences: [
          {
            kind: 'external_contract',
            id: `${mem0PluginId}.capture_queue`,
            title: 'Queued memory capture',
          },
        ],
      });
    },
    async search(request) {
      const hits = await backend.search({
        query: request.query,
        userId,
        agentId,
        limit: request.maxItems,
        signal: request.signal,
      });

      return {items: hits.map(memoryItemFromHit)};
    },
    async add(request) {
      const references = await backend.add({
        messages: [{role: 'user', content: request.text}],
        userId,
        agentId,
        // The turn a memory came from is provenance the backend keeps with
        // it; an add that drops it stores a fact nothing traces back.
        sourceIds: request.sourceReferences.map(reference => reference.id),
        // Store the supplied text directly instead of extracting from it.
        infer: false,
        signal: request.signal,
      });

      // A synchronous backend that created nothing has rejected or
      // deduplicated the write; there is no queue behind it to wait for.
      if (references.length === 0) {
        throw new Mem0RequestError({
          operation: 'add',
          failureKind: 'nothing_stored',
        });
      }

      // The platform acknowledges asynchronously with an event id, which
      // is a receipt for a queued write and not a memory id.
      const stored = references.find(reference => reference.kind === 'memory');

      return {
        ...(stored === undefined ? {} : {id: stored.id}),
        sourceReferences: references,
      };
    },
    async health(request) {
      // A capture that did not complete means a user turn memory may not
      // hold, and no later success brings it back -- least of all a
      // failing ping during the very outage that caused it. It leads on
      // every path, because the host bounds this summary and the outcome
      // warning is the part an operator must not lose to the trim.
      const losses = lastLossSummary === undefined ? '' : `${lastLossSummary} `;

      try {
        const readiness = await backend.ping({signal: request.signal});
        const backlog =
          pendingCaptures === 0
            ? ''
            : ` ${String(pendingCaptures)} capture(s) still running.`;

        if (incompleteCaptures > 0) {
          return {
            status: 'degraded',
            summary: `${losses}${readiness.summary}${backlog}`.trim(),
          };
        }

        return {
          // The backend is the authority on what its check proved: a ping
          // that contacted nothing reports itself unverified until real
          // work has exercised the model and embedder.
          status: readiness.verified ? 'ok' : 'degraded',
          summary:
            lastCaptureSummary === undefined
              ? `${readiness.summary}${backlog}`.trim()
              : `${readiness.summary} ${lastCaptureSummary}${backlog}`,
        };
      } catch (error: unknown) {
        if (error instanceof Mem0RequestError) {
          return {
            status:
              error.failureKind === 'network' ? 'unavailable' : 'degraded',
            summary: `${losses}${error.message}`.trim(),
          };
        }

        // Misconfiguration surfaces its own actionable message here.
        return {
          status: 'unavailable',
          summary: `${losses}${
            error instanceof Error && error.message.length > 0
              ? error.message
              : 'Mem0 backend unreachable.'
          }`.trim(),
        };
      }
    },
    async close(scope) {
      // Drain queued captures so a clean exit never drops an extraction,
      // but abort them when the shutdown deadline passes: one stalled
      // request must not hold the process open.
      const drainDeadline = setTimeout(
        () => {
          backgroundWork.abort();
        },
        // Clamped to the timer's range: a far-future deadline would
        // overflow and fire immediately, aborting healthy work.
        Math.min(
          maximumDrainWaitMs,
          Math.max(0, scope.deadlineAt - Date.now()),
        ),
      );
      scope.signal.addEventListener('abort', () => {
        backgroundWork.abort();
      });

      try {
        await captureQueue;
      } finally {
        clearTimeout(drainDeadline);
        // Drained or not, nothing may use this backend again: retiring
        // it stops a still-pending engine load from building stores a
        // replacement provider is about to open.
        backend.retire?.();
      }

      // The last word on this provider: no turn and no health check runs
      // after shutdown, and the next launch counts from zero, so a
      // capture the drain could not finish is only recorded here.
      return incompleteCaptures === 0
        ? undefined
        : {
            drained: false,
            summary: `Closed memory provider. ${lastLossSummary ?? ''}`.trim(),
          };
    },
  };
}

/**
 * Every backend bounds its own failures at the third-party boundary --
 * the REST transports and the embedded engine alike -- and states what
 * an abandoned write leaves unknown, so a message that arrives here is
 * already safe to show, to persist, and to act on.
 */
function captureFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the memory backend rejected the write.';
}

/**
 * Every verb of a misconfigured provider fails with the same actionable
 * message, and health carries it, so the operator learns what to set
 * without the runtime pretending memory works.
 */
export function createMisconfiguredMem0Backend(message: string): Mem0Backend {
  const fail = (): Promise<never> => Promise.reject(new TypeError(message));

  return Object.freeze({
    search: fail,
    add: fail,
    ping: fail,
  });
}

function memoryItemFromHit(hit: {
  readonly id: string;
  readonly text: string;
  readonly score?: number;
}): MemoryRecallItem {
  return {
    id: hit.id,
    text: hit.text,
    sourceReferences: [{kind: 'memory', id: hit.id, title: 'Mem0 memory'}],
    ...(hit.score === undefined
      ? {}
      : {confidence: Math.min(1, Math.max(0, hit.score))}),
  };
}
