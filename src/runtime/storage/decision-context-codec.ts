import {
  createDecisionContext,
  type ConversationHistoryWindow,
  type DecisionContext,
  type DecisionRuntimeNote,
} from '../../role-model/index.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginCuratedContextSection,
  type RuntimePluginContextItem,
  type RuntimePluginCuratedContextSection,
} from '../../plugins/api/index.ts';
import type {CharacterProfile} from '../../core/index.ts';
import {
  requiredArray,
  requiredStringArray,
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
    historyWindow: optionalConversationHistoryWindow(value['historyWindow']),
    ...(value['contextSummary'] === undefined
      ? {}
      : {
          contextSummary: requiredRecordString(
            value,
            'contextSummary',
            'malformed_record',
          ),
        }),
    runtimeNotes: requiredDecisionRuntimeNotes(value['runtimeNotes']),
    pluginContextItems: optionalRuntimePluginContextItems(
      value['pluginContextItems'],
    ),
    curatedContextSections: optionalRuntimePluginCuratedContextSections(
      value['curatedContextSections'],
    ),
  });
}

function requiredDecisionRuntimeNotes(
  value: unknown,
): readonly DecisionRuntimeNote[] {
  return Object.freeze(
    requiredArray(value, 'runtimeNotes').map(item => {
      if (!isRecord(item)) {
        throwMalformedRecord('runtimeNotes');
      }

      const pluginId = item['pluginId'];

      if (pluginId !== undefined && typeof pluginId !== 'string') {
        throwMalformedRecord('runtimeNotes');
      }

      return Object.freeze({
        id: requiredRecordString(item, 'id', 'malformed_record'),
        text: requiredRecordString(item, 'text', 'malformed_record'),
        ...(pluginId === undefined ? {} : {pluginId}),
      } satisfies DecisionRuntimeNote);
    }),
  );
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

/** Optional so records written before the window existed decode unchanged. */
function optionalConversationHistoryWindow(
  value: unknown,
): ConversationHistoryWindow {
  if (value === undefined) {
    return Object.freeze({turnEventIds: Object.freeze([])});
  }

  if (!isRecord(value)) {
    throwMalformedRecord('historyWindow');
  }

  return Object.freeze({
    turnEventIds: requiredStringArray(value['turnEventIds'], 'turnEventIds'),
  });
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
