import type { ConversationLogRecord } from '../log.ts';
import {
  requiredNormalizedVisibleMessageText,
  requiredVisibleMessageRole
} from './codec-primitives.ts';
import {
  parseJsonObject,
  requiredRecordCanonicalTimestamp,
  requiredRecordString
} from './layout-contract.ts';

export function encodeConversationLogRecord(record: ConversationLogRecord): string {
  return JSON.stringify(record);
}

export function decodeConversationLogRecord(line: string): ConversationLogRecord {
  const record = parseJsonObject(line, 'malformed_record');

  return Object.freeze({
    eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      record,
      'createdAt',
      'malformed_record'
    ),
    id: requiredRecordString(record, 'id', 'malformed_record'),
    role: requiredVisibleMessageRole(record['role']),
    speakerId: requiredRecordString(record, 'speakerId', 'malformed_record'),
    speakerName: requiredRecordString(record, 'speakerName', 'malformed_record'),
    text: requiredNormalizedVisibleMessageText(record, 'text'),
    committedAt: requiredRecordCanonicalTimestamp(
      record,
      'committedAt',
      'malformed_record'
    )
  } satisfies ConversationLogRecord);
}
