import {
  builtInModelToolDefinitionsForUserTurn,
  characterStatePatchModelToolName,
  visibleReplyModelToolName,
  type BuiltInModelToolDefinition
} from './model-tools.ts';
import {
  roleModelDecisionContractVersion,
  type RoleModelAllowedToolName,
  type RoleModelInputEnvelope,
  type RoleModelOutputContract
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
  readonly toolDefinitions: readonly BuiltInModelToolDefinition[];
  readonly responseExample: RoleModelPromptResponseExample;
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
};

type RoleModelPromptResponseExample = {
  readonly version: typeof roleModelDecisionContractVersion;
  readonly toolCalls: readonly [
    {
      readonly name: typeof visibleReplyModelToolName;
      readonly input: {
        readonly text: string;
      };
    },
    {
      readonly name: typeof characterStatePatchModelToolName;
      readonly input: {
        readonly currentActivity: 'chatting';
      };
    }
  ];
};

export const roleModelPromptSystemMessage =
  'You are Mira. Return exactly one complete CharacterDecision JSON object. ' +
  `The top-level "version" value must be exactly "${roleModelDecisionContractVersion}"; copy that literal from outputContract.version without adding or removing characters. ` +
  'The entire response must be valid JSON parseable by JSON.parse, begin with "{", end with "}", and include no markdown, prose, comments, or partial JSON. ' +
  'Each toolCalls item must use string field "name" and object field "input"; never use "tool", "type", "function", or "arguments". ' +
  'Use only allowed tool names and only enum values listed in toolDefinitions.';

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
      content: roleModelPromptSystemMessage
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
    toolDefinitions: toolDefinitionsForAllowedTools(inputEnvelope.allowedTools),
    responseExample: roleModelPromptResponseExample,
    event: inputEnvelope.event,
    decisionContext: inputEnvelope.decisionContext
  } satisfies RoleModelPromptPayload);
}

function toolDefinitionsForAllowedTools(
  allowedTools: readonly RoleModelAllowedToolName[]
): readonly BuiltInModelToolDefinition[] {
  return Object.freeze(
    builtInModelToolDefinitionsForUserTurn().filter((definition) =>
      allowedTools.includes(definition.name)
    )
  );
}
