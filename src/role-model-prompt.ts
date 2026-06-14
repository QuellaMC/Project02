import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type ModelToolDefinition
} from './model-tools.ts';
import {
  roleModelDecisionContractVersion,
  type RoleModelAllowedToolName,
  type RoleModelInputEnvelope,
  type RoleModelOutputContract,
  type RoleModelToolObservation
} from './role-model-contracts.ts';
import type { UserMessageRuntimeEvent } from './runtime-event.ts';
import type { DecisionContext } from './role-model-contracts.ts';

export type RoleModelPromptMessage = {
  readonly role: 'system' | 'user';
  readonly content: string;
};

export type RoleModelPromptPayload = {
  readonly outputContract: RoleModelOutputContract;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly ModelToolDefinition[];
  readonly toolObservations: readonly RoleModelToolObservation[];
  readonly responseExample: RoleModelPromptResponseExample;
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
};

type RoleModelPromptResponseExample = {
  readonly version: typeof roleModelDecisionContractVersion;
  readonly toolCalls: readonly BuiltInModelToolCall[];
};

export const roleModelPromptSystemMessage =
  'Return exactly one complete CharacterDecision JSON object. ' +
  `The top-level "version" value must be exactly "${roleModelDecisionContractVersion}"; copy that literal from outputContract.version without adding or removing characters. ` +
  'The entire response must be valid JSON parseable by JSON.parse, begin with "{", end with "}", and include no markdown, prose, comments, or partial JSON. ' +
  'Each toolCalls item must use string field "name" and object field "input"; never use "tool", "type", "function", or "arguments". ' +
  'Use only allowed tool names and only enum values listed in toolDefinitions. ' +
  'If toolObservations is non-empty, use those runtime tool results before deciding whether to call another executable tool or finish. ' +
  'visible_reply is the only non-executed output tool. Any other tool call, including character_state.patch, is executed and returned as a tool observation. ' +
  'If visible_reply appears with executable tools, it is interim visible output. To finish, return no executable tools and either exactly one visible_reply or top-level text only as folded non-visible model text.';

export const roleModelPromptResponseExample = Object.freeze({
  version: roleModelDecisionContractVersion,
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
    outputContract: inputEnvelope.outputContract,
    allowedTools: Object.freeze([...inputEnvelope.allowedTools]),
    toolDefinitions: Object.freeze([...inputEnvelope.toolDefinitions]),
    toolObservations: Object.freeze([...inputEnvelope.toolObservations]),
    responseExample: createRoleModelPromptResponseExample(
      inputEnvelope.allowedTools
    ),
    event: inputEnvelope.event,
    decisionContext: inputEnvelope.decisionContext
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
    version: roleModelDecisionContractVersion,
    toolCalls: Object.freeze(
      roleModelPromptResponseExample.toolCalls.filter((call) =>
        allowedTools.includes(call.name)
      )
    )
  } satisfies RoleModelPromptResponseExample);
}
