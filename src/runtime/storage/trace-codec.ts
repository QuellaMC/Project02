import {
  runtimeTraceStepValues,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName
} from '../evidence/records.ts';
import {
  isOneOf,
  requiredRuntimeEventIdentity,
  throwMalformedRecord
} from './codec-primitives.ts';
import {
  parseJsonObject
} from './layout-contract.ts';

export function encodeRuntimeTraceEntry(entry: RuntimeTraceEntry): string {
  return JSON.stringify(entry);
}

export function decodeRuntimeTraceEntry(line: string): RuntimeTraceEntry {
  const record = parseJsonObject(line, 'malformed_record');
  const identity = requiredRuntimeEventIdentity(record);

  return Object.freeze({
    ...identity,
    step: requiredRuntimeTraceStep(record['step'])
  } satisfies RuntimeTraceEntry);
}

function requiredRuntimeTraceStep(value: unknown): RuntimeTraceStepName {
  if (isOneOf(value, runtimeTraceStepValues)) {
    return value;
  }

  throwMalformedRecord('step');
}
