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

export function createMem0MemoryProvider(options: {
  readonly backend: Mem0Backend;
  readonly userId: string;
  readonly agentId: string;
}): Project02MemoryProvider {
  const {backend, userId, agentId} = options;

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
    async captureTurn(turn) {
      const messages: Mem0ChatMessage[] = [
        {role: 'user', content: turn.userMessage},
        ...(turn.characterMessage === undefined
          ? []
          : [{role: 'assistant' as const, content: turn.characterMessage}]),
      ];
      const references = await backend.add({
        messages,
        userId,
        agentId,
        runId: turn.sessionId,
        // The backend owns extraction: it decides what becomes memory.
        infer: true,
        signal: turn.signal,
      });

      if (references.length === 0) {
        return {captured: false, summary: 'No memory extracted.'};
      }

      return {
        captured: true,
        summary: 'Captured turn for memory extraction.',
        sourceReferences: references,
      };
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
        // Store the supplied text directly instead of extracting from it.
        infer: false,
        signal: request.signal,
      });

      return {
        id: references[0]?.id ?? 'mem0-add',
        sourceReferences: references,
      };
    },
    async health(request) {
      try {
        await backend.ping({signal: request.signal});

        return {status: 'ok', summary: 'Mem0 backend reachable.'};
      } catch (error: unknown) {
        if (error instanceof Mem0RequestError) {
          return {
            status:
              error.failureKind === 'network' ? 'unavailable' : 'degraded',
            summary: error.message,
          };
        }

        // Misconfiguration surfaces its own actionable message here.
        return {
          status: 'unavailable',
          summary:
            error instanceof Error && error.message.length > 0
              ? error.message
              : 'Mem0 backend unreachable.',
        };
      }
    },
  };
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
