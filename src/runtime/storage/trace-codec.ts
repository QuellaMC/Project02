import {
  runtimeTraceStepValues,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName
} from '../log.ts';
import { isOneOf, throwMalformedRecord } from './codec-primitives.ts';
import {
  parseJsonObject,
  requiredRecordCanonicalTimestamp,
  requiredRecordString
} from './layout-contract.ts';

export function encodeRuntimeTraceEntry(entry: RuntimeTraceEntry): string {
  return JSON.stringify(entry);
}

export function decodeRuntimeTraceEntry(line: string): RuntimeTraceEntry {
  const record = parseJsonObject(line, 'malformed_record');

  return Object.freeze({
    eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      record,
      'createdAt',
      'malformed_record'
    ),
    step: requiredRuntimeTraceStep(record['step'])
  } satisfies RuntimeTraceEntry);
}

function requiredRuntimeTraceStep(value: unknown): RuntimeTraceStepName {
  if (isOneOf(value, runtimeTraceStepValues)) {
    return value;
  }

  throwMalformedRecord('step');
}
