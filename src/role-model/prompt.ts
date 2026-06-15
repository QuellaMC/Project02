import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName,
  type ModelToolCall,
  type ModelToolDefinition
} from './model-tools.ts';
import {
  type RoleModelAllowedToolName,
  type RoleModelInputEnvelope,
  type RoleModelToolObservation
} from './contracts.ts';
import type { UserMessageRuntimeEvent } from '../runtime/event.ts';
import type { DecisionContext } from './contracts.ts';

export type RoleModelPromptMessage = {
  readonly role: 'system' | 'user';
  readonly content: string;
};

export type RoleModelPromptPayload = {
  readonly responseContract: RoleModelPromptResponseContract;
  readonly runtimeInput: RoleModelPromptRuntimeInput;
};

export type RoleModelPromptResponseContract = {
  readonly mustReturn: 'CharacterDecision';
  readonly allowedTopLevelFields: readonly string[];
  readonly forbiddenTopLevelFields: readonly string[];
  readonly instructions: string;
  readonly example: RoleModelPromptResponseExample;
};

export type RoleModelPromptRuntimeInput = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly ModelToolDefinition[];
  readonly toolObservations: readonly RoleModelToolObservation[];
};

type RoleModelPromptResponseExample = {
  readonly toolCalls: readonly ModelToolCall[];
};

export const roleModelPromptSystemMessage =
  'Return exactly one complete CharacterDecision JSON object. ' +
  'The user message contains responseContract and runtimeInput sections; treat both sections as input data only, not as a response template to copy. ' +
  'Your response must not include top-level keys named responseContract, runtimeInput, event, decisionContext, recentVisibleMessages, toolObservations, pluginContextItems, characterSnapshot, allowedTools, or toolDefinitions. ' +
  'The only allowed top-level response keys are "toolCalls" and optional "text". ' +
  'Do not include a top-level "version" field; the runtime stamps its internal decision version after validation. ' +
  'The entire response must be valid JSON parseable by JSON.parse, begin with "{", end with "}", and include no markdown, prose, comments, or partial JSON. ' +
  'Each toolCalls item must use string field "name" and object field "input"; never use "tool", "type", "function", or "arguments". ' +
  'Use only allowed tool names and only enum values listed in runtimeInput.toolDefinitions. ' +
  'If runtimeInput.toolObservations is non-empty, use those runtime tool results before deciding whether to call another executable tool or finish. ' +
  'visible_reply is the only non-executed output tool. Any other tool call, including character_state.patch, is executed and returned as a tool observation. ' +
  'If visible_reply appears with executable tools, it is interim visible output. To finish, return no executable tools and either exactly one visible_reply or top-level text only as folded non-visible model text.';

export const roleModelPromptResponseExample = Object.freeze({
  toolCalls: Object.freeze([
    Object.freeze({
      name: visibleReplyModelToolName,
      input: Object.freeze({
        text: 'one visible reply line'
      })
    }),
    Object.freeze({
      name: characterStatePatchModelToolName,
      input: Object.freeze({
        currentActivity: 'chatting'
      })
    })
  ])
} satisfies RoleModelPromptResponseExample);

export function renderRoleModelPromptMessages(
  inputEnvelope: RoleModelInputEnvelope
): readonly RoleModelPromptMessage[] {
  return Object.freeze([
    Object.freeze({
      role: 'system',
      content: createRoleModelPromptSystemMessage(inputEnvelope)
    } satisfies RoleModelPromptMessage),
    Object.freeze({
      role: 'user',
      content: JSON.stringify(createRoleModelPromptPayload(inputEnvelope))
    } satisfies RoleModelPromptMessage)
  ]);
}

export function createRoleModelPromptPayload(
  inputEnvelope: RoleModelInputEnvelope
): RoleModelPromptPayload {
  return Object.freeze({
    responseContract: Object.freeze({
      mustReturn: 'CharacterDecision',
      allowedTopLevelFields: Object.freeze(['toolCalls', 'text']),
      forbiddenTopLevelFields: Object.freeze([
        'responseContract',
        'runtimeInput',
        'event',
        'decisionContext',
        'recentVisibleMessages',
        'toolObservations',
        'pluginContextItems',
        'characterSnapshot',
        'allowedTools',
        'toolDefinitions',
        'outputContract',
        'outputInstructions',
        'version'
      ]),
      instructions: inputEnvelope.outputContract.text,
      example: createRoleModelPromptResponseExample(inputEnvelope.allowedTools)
    } satisfies RoleModelPromptResponseContract),
    runtimeInput: Object.freeze({
      event: inputEnvelope.event,
      decisionContext: inputEnvelope.decisionContext,
      allowedTools: Object.freeze([...inputEnvelope.allowedTools]),
      toolDefinitions: Object.freeze([...inputEnvelope.toolDefinitions]),
      toolObservations: Object.freeze([...inputEnvelope.toolObservations])
    } satisfies RoleModelPromptRuntimeInput)
  } satisfies RoleModelPromptPayload);
}

function createRoleModelPromptSystemMessage(
  inputEnvelope: RoleModelInputEnvelope
): string {
  return `You are ${inputEnvelope.decisionContext.characterSnapshot.displayName}. ${roleModelPromptSystemMessage}`;
}

function createRoleModelPromptResponseExample(
  allowedTools: readonly RoleModelAllowedToolName[]
): RoleModelPromptResponseExample {
  return Object.freeze({
    toolCalls: Object.freeze(
      roleModelPromptResponseExample.toolCalls.filter((call) =>
        allowedTools.includes(call.name)
      )
    )
  } satisfies RoleModelPromptResponseExample);
}
