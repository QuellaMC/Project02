import { describe, expect, it } from 'vitest';

import { createRuntimeComponentRegistry } from '../../../src/runtime/components.ts';
import { RuntimeAccess } from '../../../src/runtime/operation-registry.ts';
import {
  incidentCompletionRuntimeComponents,
  userTurnRuntimeComponents
} from '../../../src/runtime/built-in-components.ts';
import { InMemoryRawEventLog, type IdGenerator } from '../../../src/runtime/logging.ts';
import type { RoleModelAdapter } from '../../../src/role-model/loop.ts';

class SequenceIdGenerator {
  readonly calls: string[] = [];

  next: IdGenerator = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

function fixedClock(): Date {
  return new Date('2026-06-01T11:00:00.000Z');
}

const adapter: RoleModelAdapter = {
  generate: () => {
    throw new Error('must not call model');
  }
};

describe('runtime access with built-in operations', () => {
  it('rejects cross-calling user-turn and incident-completion operations', () => {
    const rawLog = new InMemoryRawEventLog();
    const ids = new SequenceIdGenerator();
    const registry = createRuntimeComponentRegistry([
      ...userTurnRuntimeComponents({
        adapter,
        rawEventLog: rawLog,
        visibleConversation: {
          append: () => {
            throw new Error('must not append visible records');
          },
          readVisibleConversationRecords: () => []
        },
        idGenerator: ids.next,
        clock: fixedClock
      }),
      ...incidentCompletionRuntimeComponents({
        activeIncidentSource: {
          readActiveIncident: () => {
            throw new Error('must not read incident');
          }
        },
        lifeIncidentCompleteFinalizer: {
          finalizeLifeIncidentComplete: () => {
            throw new Error('must not finalize incident');
          },
          completeLifeIncidentCompleteAfterLogVisible: () => {
            throw new Error('must not complete incident');
          }
        },
        rawEventLog: rawLog,
        idGenerator: ids.next,
        clock: fixedClock
      })
    ]);
    const access = new RuntimeAccess(registry.operationRegistry, {
      rawEventLog: rawLog,
      idGenerator: ids.next,
      clock: fixedClock
    });

    const userCallerIncidentOp = access.execute({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      caller: {
        component_id: 'runtime.user_turn',
        call_type: 'user_turn'
      },
      op: 'incident.complete_from_event',
      input: {}
    });
    const kernelCallerUserOp = access.execute({
      schema_version: '0.1',
      trace_id: 'trace-2',
      event_id: 'event-2',
      event_type: 'INCIDENT_COMPLETION',
      caller: {
        component_id: 'runtime.kernel',
        call_type: 'deterministic_event_commit'
      },
      op: 'visible_conversation.commit_user_message',
      input: {}
    });

    expect(userCallerIncidentOp.failure?.code).toBe('unsupported_caller');
    expect(kernelCallerUserOp.failure?.code).toBe('unsupported_caller');
  });
});
