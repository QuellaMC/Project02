/**
 * The one judgment of whether a durable config effect carries its approval:
 * the writer and recovery both refuse without it.
 */
import {
  preparedRuntimePluginConfigEffectHasApprovalEvidence,
  type PreparedRuntimePluginConfigEffect,
} from '../../plugins/api/index.ts';
import type {RawEventLogRecord} from './records.ts';

type ApprovalToolRecords = {
  started: RawEventLogRecord | undefined;
  finished: RawEventLogRecord | undefined;
};

export function approvalToolRecordsByCallId(
  rawEvents: readonly RawEventLogRecord[],
): ReadonlyMap<string, ApprovalToolRecords> {
  const records = new Map<string, ApprovalToolRecords>();

  for (const rawEvent of rawEvents) {
    if (
      (rawEvent.kind !== 'tool_call_started' &&
        rawEvent.kind !== 'tool_call_finished') ||
      rawEvent.toolCallId === undefined
    ) {
      continue;
    }

    const entry = records.get(rawEvent.toolCallId) ?? {
      started: undefined,
      finished: undefined,
    };

    if (rawEvent.kind === 'tool_call_started') {
      entry.started = rawEvent;
    } else {
      entry.finished = rawEvent;
    }

    records.set(rawEvent.toolCallId, entry);
  }

  return records;
}

export function runtimeConfigEffectHasLoggedApproval(
  effect: PreparedRuntimePluginConfigEffect,
  approvalRecords: ReadonlyMap<string, ApprovalToolRecords>,
): boolean {
  const records = approvalRecords.get(effect.effectId);
  const started = records?.started;
  const finished = records?.finished;

  return (
    started !== undefined &&
    finished !== undefined &&
    preparedRuntimePluginConfigEffectHasApprovalEvidence({
      effect,
      eventIdentity: finished,
      inputIdentity: started,
      inputPluginId: started.toolPluginId,
      inputToolName: started.toolName,
      toolCallId: finished.toolCallId,
      dispatchedToHost: finished.dispatchedToHost,
      pluginId: finished.toolPluginId,
      toolName: finished.toolName,
      result: finished.toolResult,
    })
  );
}
