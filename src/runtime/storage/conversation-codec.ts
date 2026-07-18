import type {ConversationLogRecord} from '../evidence/records.ts';
import {
  requiredNormalizedVisibleMessageText,
  requiredRuntimeEventIdentity,
  requiredVisibleMessageRole,
} from './codec-primitives.ts';
import {
  parseJsonObject,
  requiredRecordCanonicalTimestamp,
  requiredRecordString,
} from './layout-contract.ts';

export function encodeConversationLogRecord(
  record: ConversationLogRecord,
): string {
  return JSON.stringify(record);
}

export function decodeConversationLogRecord(
  line: string,
): ConversationLogRecord {
  const record = parseJsonObject(line, 'malformed_record');
  const identity = requiredRuntimeEventIdentity(record);

  return Object.freeze({
    ...identity,
    id: requiredRecordString(record, 'id', 'malformed_record'),
    role: requiredVisibleMessageRole(record['role']),
    speakerId: requiredRecordString(record, 'speakerId', 'malformed_record'),
    speakerName: requiredRecordString(
      record,
      'speakerName',
      'malformed_record',
    ),
    text: requiredNormalizedVisibleMessageText(record, 'text'),
    committedAt: requiredRecordCanonicalTimestamp(
      record,
      'committedAt',
      'malformed_record',
    ),
  } satisfies ConversationLogRecord);
}
