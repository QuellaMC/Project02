import {type CharacterProfile, type SpeakerIdentity} from '../../core/index.ts';
import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths,
} from '../storage/layout-contract.ts';
import type {DurableRuntimeSessionEvidence} from './contract.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';

export function validateDurableRuntimeSessionIdentity(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly boundCharacter: CharacterProfile | undefined;
  readonly boundUserSpeaker: SpeakerIdentity | undefined;
  readonly allowUnanchoredCustomCharacter: boolean;
}): {
  readonly character: CharacterProfile | undefined;
  readonly userSpeaker: SpeakerIdentity | undefined;
} {
  assertRoleModelEvidenceMatchesSessionId({
    sessionId: options.paths.sessionId,
    rawEvents: options.evidence.rawEvents,
  });
  const character = durableCharacterProfile({
    messages: options.evidence.conversationMessages,
    rawEvents: options.evidence.rawEvents,
    boundCharacter: options.boundCharacter,
    allowUnanchoredCustomCharacter: options.allowUnanchoredCustomCharacter,
  });
  const userSpeaker = recordedUserSpeakerIdentity(
    options.evidence.conversationMessages,
  );

  if (
    userSpeaker !== undefined &&
    options.boundUserSpeaker !== undefined &&
    // Display names are historical per-session facts; the stable id is
    // the store-bound user identity.
    userSpeaker.id !== options.boundUserSpeaker.id
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Durable user evidence must match the store-bound user.',
    );
  }

  return Object.freeze({character, userSpeaker});
}

export function durableCharacterProfile(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly boundCharacter: CharacterProfile | undefined;
  readonly allowUnanchoredCustomCharacter: boolean;
}): CharacterProfile | undefined {
  return validateDurableCharacterProfiles({
    roleModelCharacter: recordedRoleModelCharacterProfile(options.rawEvents),
    conversationCharacter: recordedConversationCharacterProfile(
      options.messages,
    ),
    boundCharacter: options.boundCharacter,
    allowUnanchoredCustomCharacter: options.allowUnanchoredCustomCharacter,
  });
}

export function recordedRoleModelCharacterProfile(
  rawEvents: readonly RawEventLogRecord[],
): CharacterProfile | undefined {
  let recordedCharacter: CharacterProfile | undefined;

  for (const rawEvent of rawEvents) {
    const candidate = roleModelCharacterSnapshot(rawEvent);

    if (candidate === undefined) {
      continue;
    }

    if (
      recordedCharacter !== undefined &&
      !sameCharacterProfiles(recordedCharacter, candidate)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Role-model character evidence must identify one durable session character.',
      );
    }

    recordedCharacter = candidate;
  }

  return recordedCharacter;
}

export function recordedUserSpeakerIdentity(
  messages: readonly ConversationLogRecord[],
): SpeakerIdentity | undefined {
  let userSpeaker: SpeakerIdentity | undefined;

  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }

    const candidate = Object.freeze({
      id: message.speakerId,
      displayName: message.speakerName,
    } satisfies SpeakerIdentity);

    if (
      userSpeaker !== undefined &&
      (userSpeaker.id !== candidate.id ||
        userSpeaker.displayName !== candidate.displayName)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Durable user messages must identify one session user speaker.',
      );
    }

    userSpeaker = candidate;
  }

  return userSpeaker;
}

export function recordedConversationCharacterProfile(
  messages: readonly ConversationLogRecord[],
): CharacterProfile | undefined {
  let messageCharacter: CharacterProfile | undefined;

  for (const message of messages) {
    if (message.role !== 'character') {
      continue;
    }

    const candidate = Object.freeze({
      id: message.speakerId,
      displayName: message.speakerName,
    } satisfies CharacterProfile);

    if (
      messageCharacter !== undefined &&
      !sameCharacterProfiles(messageCharacter, candidate)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Durable character messages must identify one session character.',
      );
    }

    messageCharacter = candidate;
  }

  return messageCharacter;
}

export function validateDurableCharacterProfiles(options: {
  readonly roleModelCharacter: CharacterProfile | undefined;
  readonly conversationCharacter: CharacterProfile | undefined;
  readonly boundCharacter: CharacterProfile | undefined;
  readonly allowUnanchoredCustomCharacter: boolean;
}): CharacterProfile | undefined {
  if (
    options.roleModelCharacter !== undefined &&
    options.conversationCharacter !== undefined &&
    !sameCharacterProfiles(
      options.roleModelCharacter,
      options.conversationCharacter,
    )
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Durable character speaker metadata must match recorded role-model character evidence.',
    );
  }

  const derivedCharacter =
    options.roleModelCharacter ?? options.conversationCharacter;

  if (
    derivedCharacter !== undefined &&
    options.boundCharacter !== undefined &&
    // Bound id only: display names are per-session historical facts, so a
    // renamed character's old sessions stay readable under the same id.
    // Anchoring does not exempt foreign evidence: a session copied in from
    // another character's store must not open under this character boundary.
    derivedCharacter.id !== options.boundCharacter.id &&
    !options.allowUnanchoredCustomCharacter
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Durable character evidence must match the store-bound character.',
    );
  }

  return derivedCharacter;
}

export function roleModelCharacterSnapshot(
  rawEvent: RawEventLogRecord,
): CharacterProfile | undefined {
  return rawEvent.roleModelIOSnapshot?.inputEnvelope.decisionContext
    .characterSnapshot;
}

export function sameCharacterProfiles(
  left: CharacterProfile,
  right: CharacterProfile,
): boolean {
  return left.id === right.id && left.displayName === right.displayName;
}

export function speakerMatchesCharacter(
  message: ConversationLogRecord,
  character: CharacterProfile,
): boolean {
  return (
    message.speakerId === character.id &&
    message.speakerName === character.displayName
  );
}

export function assertRoleModelEvidenceMatchesSessionId(options: {
  readonly sessionId: string;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  for (const rawEvent of options.rawEvents) {
    const sessionIds = [
      rawEvent.roleModelIOSnapshot?.sessionId,
      rawEvent.roleModelIOSnapshot?.inputEnvelope.decisionContext.sessionId,
      rawEvent.parsedRoleModelDecisionSnapshot?.sessionId,
      rawEvent.commitValidation?.sessionId,
    ];

    for (const sessionId of sessionIds) {
      if (sessionId === undefined || sessionId === options.sessionId) {
        continue;
      }

      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Runtime evidence session identity must match the durable session path.',
      );
    }
  }
}
