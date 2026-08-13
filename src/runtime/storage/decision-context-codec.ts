import {
  createDecisionContext,
  type DecisionContext,
} from '../../role-model/index.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginCuratedContextSection,
  type RuntimePluginContextItem,
  type RuntimePluginCuratedContextSection,
} from '../../plugins/api/index.ts';
import type {CharacterProfile, VisibleMessage} from '../../core/index.ts';
import {
  requiredArray,
  requiredStringArray,
  requiredVisibleMessage,
  throwMalformedRecord,
} from './codec-primitives.ts';
import {isRecord, requiredRecordString} from './layout-contract.ts';

export function requiredDecisionContext(value: unknown): DecisionContext {
  if (!isRecord(value)) {
    throwMalformedRecord('decisionContext');
  }

  return createDecisionContext({
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    characterSnapshot: requiredCharacterProfile(value['characterSnapshot']),
    recentVisibleMessages: requiredVisibleMessages(
      value['recentVisibleMessages'],
      'recentVisibleMessages',
    ),
    runtimeNotes: requiredStringArray(value['runtimeNotes'], 'runtimeNotes'),
    pluginContextItems: optionalRuntimePluginContextItems(
      value['pluginContextItems'],
    ),
    curatedContextSections: optionalRuntimePluginCuratedContextSections(
      value['curatedContextSections'],
    ),
  });
}

function requiredCharacterProfile(value: unknown): CharacterProfile {
  if (!isRecord(value)) {
    throwMalformedRecord('characterSnapshot');
  }

  return Object.freeze({
    id: requiredRecordString(value, 'id', 'malformed_record'),
    displayName: requiredRecordString(value, 'displayName', 'malformed_record'),
  } satisfies CharacterProfile);
}

function requiredVisibleMessages(
  value: unknown,
  key: string,
): readonly VisibleMessage[] {
  const messages: VisibleMessage[] = [];

  for (const item of requiredArray(value, key)) {
    messages.push(requiredVisibleMessage(item, 'recentVisibleMessages'));
  }

  return Object.freeze(messages);
}

function optionalRuntimePluginContextItems(
  value: unknown,
): readonly RuntimePluginContextItem[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  const contextItems: RuntimePluginContextItem[] = [];

  for (const item of requiredArray(value, 'pluginContextItems')) {
    try {
      contextItems.push(createRuntimePluginContextItem(item));
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throwMalformedRecord('pluginContextItems');
      }

      throw error;
    }
  }

  return Object.freeze(contextItems);
}

function optionalRuntimePluginCuratedContextSections(
  value: unknown,
): readonly RuntimePluginCuratedContextSection[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  const sections: RuntimePluginCuratedContextSection[] = [];

  for (const section of requiredArray(value, 'curatedContextSections')) {
    try {
      sections.push(createRuntimePluginCuratedContextSection(section));
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throwMalformedRecord('curatedContextSections');
      }

      throw error;
    }
  }

  return Object.freeze(sections);
}
