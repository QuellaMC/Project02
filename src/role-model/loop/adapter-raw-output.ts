import {
  roleModelAdapterNativeToolCallArgumentErrorsMalformedDetails,
  roleModelAdapterRejectionNotReplayableDetails,
  roleModelAdapterProviderExchangeMalformedDetails,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelDecisionRejectionReasons,
  roleModelMalformedOutputRejectionReason,
  type RoleModelDecisionRejection,
  type RoleModelMalformedAdapterRawOutputDetails,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  type RoleModelToolObservation,
  type RejectedRoleModelDecisionResult,
} from '../api/contracts.ts';
import {createRejectedRoleModelDecisionResult} from '../api/decision.ts';
import {normalizeReplayableRejectedRoleModelDecisionResult} from './replay-evidence.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {isOneOf} from '../../shared/one-of.ts';
import {parseRoleModelProviderExchangeSnapshot} from '../api/provider-exchange.ts';
import type {RoleModelNativeToolCallArgumentError} from '../api/adapter.ts';
import type {
  RoleModelAssistantChatMessage,
  RoleModelChatToolCall,
} from '../api/chat-wire.ts';
import {type RoleModelAllowedToolName} from '../api/tool-names.ts';

export type RoleModelAdapterRawOutputValidationResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly providerExchange?: RoleModelProviderExchangeSnapshot;
      readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
      readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
    }
  | {
      readonly status: 'rejected';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly providerExchange?: RoleModelProviderExchangeSnapshot;
      readonly decisionResult: RejectedRoleModelDecisionResult;
    };

export function validateRoleModelAdapterRawOutput(
  rawOutput: unknown,
  allowedTools: readonly RoleModelAllowedToolName[],
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
  toolObservations: readonly RoleModelToolObservation[],
): RoleModelAdapterRawOutputValidationResult {
  if (!isJsonRecord(rawOutput)) {
    return createMalformedAdapterRawOutputResult();
  }

  const rawOutputTextValue = rawOutput['rawOutputText'];

  if (typeof rawOutputTextValue !== 'string') {
    return createMalformedAdapterRawOutputResult();
  }
  const rawOutputText = rawOutputTextValue;

  const providerMetadataResult = optionalProviderMetadata(
    rawOutput['providerMetadata'],
  );
  const providerExchange = parseRoleModelProviderExchangeSnapshot(
    rawOutput['providerExchange'],
  );

  if (providerMetadataResult.status === 'rejected') {
    return createMalformedAdapterRawOutputResult(
      providerMetadataResult.details,
    );
  }

  if (
    rawOutput['providerExchange'] !== undefined &&
    providerExchange === undefined
  ) {
    return createMalformedAdapterRawOutputResult(
      roleModelAdapterProviderExchangeMalformedDetails,
    );
  }

  const providerMetadata = providerMetadataResult.providerMetadata;
  const rejection = optionalRoleModelDecisionRejection(rawOutput['rejection']);
  const nativeAssistantMessage = optionalRoleModelAssistantChatMessage(
    rawOutput['nativeAssistantMessage'],
  );
  const nativeToolCallArgumentErrors =
    optionalRoleModelNativeToolCallArgumentErrors(
      rawOutput['nativeToolCallArgumentErrors'],
    );

  if (
    rawOutput['nativeToolCallArgumentErrors'] !== undefined &&
    nativeToolCallArgumentErrors === undefined
  ) {
    return createMalformedAdapterRawOutputResult(
      roleModelAdapterNativeToolCallArgumentErrorsMalformedDetails,
    );
  }

  if (rejection !== undefined) {
    const decisionResult = normalizeReplayableRejectedRoleModelDecisionResult({
      rawOutputText,
      providerMetadata,
      decisionResult: createRejectedRoleModelDecisionResult(
        rejection.reason,
        rejection.details,
      ),
      allowedTools,
      pluginToolDefinitions,
      toolObservations,
    });

    if (decisionResult === undefined) {
      return createMalformedAdapterRawOutputResult(
        roleModelAdapterRejectionNotReplayableDetails,
      );
    }

    return Object.freeze({
      status: 'rejected',
      rawOutputText,
      ...providerMetadataOption(providerMetadata),
      ...providerExchangeOption(providerExchange),
      decisionResult,
    } satisfies RoleModelAdapterRawOutputValidationResult);
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText,
    ...providerMetadataOption(providerMetadata),
    ...providerExchangeOption(providerExchange),
    ...nativeAssistantMessageOption(nativeAssistantMessage),
    ...nativeToolCallArgumentErrorsOption(nativeToolCallArgumentErrors),
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

function createMalformedAdapterRawOutputResult(
  details: RoleModelMalformedAdapterRawOutputDetails = roleModelAdapterRawOutputMissingTextRejectionDetails,
): RoleModelAdapterRawOutputValidationResult {
  return Object.freeze({
    status: 'rejected',
    rawOutputText: '',
    decisionResult: createRejectedRoleModelDecisionResult(
      roleModelMalformedOutputRejectionReason,
      details,
    ),
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

export function providerMetadataOption(
  providerMetadata: RoleModelProviderMetadata | undefined,
): {readonly providerMetadata?: RoleModelProviderMetadata} {
  return providerMetadata === undefined ? {} : {providerMetadata};
}

export function providerExchangeOption(
  providerExchange: RoleModelProviderExchangeSnapshot | undefined,
): {readonly providerExchange?: RoleModelProviderExchangeSnapshot} {
  return providerExchange === undefined ? {} : {providerExchange};
}

function nativeAssistantMessageOption(
  nativeAssistantMessage: RoleModelAssistantChatMessage | undefined,
): {readonly nativeAssistantMessage?: RoleModelAssistantChatMessage} {
  return nativeAssistantMessage === undefined ? {} : {nativeAssistantMessage};
}

function nativeToolCallArgumentErrorsOption(
  nativeToolCallArgumentErrors:
    readonly RoleModelNativeToolCallArgumentError[] | undefined,
): {
  readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
} {
  return nativeToolCallArgumentErrors === undefined
    ? {}
    : {nativeToolCallArgumentErrors};
}

function optionalRoleModelNativeToolCallArgumentErrors(
  value: unknown,
): readonly RoleModelNativeToolCallArgumentError[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const errors: RoleModelNativeToolCallArgumentError[] = [];

  for (const item of value) {
    if (!isJsonRecord(item)) {
      return undefined;
    }

    const executableIndex = item['executableIndex'];
    const toolName = item['toolName'];
    const reason = item['reason'];
    const message = item['message'];

    if (
      typeof executableIndex !== 'number' ||
      !Number.isInteger(executableIndex) ||
      executableIndex < 0 ||
      typeof toolName !== 'string' ||
      toolName.length === 0 ||
      typeof reason !== 'string' ||
      reason.length === 0 ||
      typeof message !== 'string' ||
      message.length === 0
    ) {
      return undefined;
    }

    errors.push(
      Object.freeze({
        executableIndex,
        toolName,
        reason: reason,
        message: message,
      } satisfies RoleModelNativeToolCallArgumentError),
    );
  }

  return Object.freeze(errors);
}

function optionalRoleModelAssistantChatMessage(
  value: unknown,
): RoleModelAssistantChatMessage | undefined {
  if (!isJsonRecord(value) || value['role'] !== 'assistant') {
    return undefined;
  }

  const content = value['content'];
  const toolCalls = optionalRoleModelChatToolCalls(value['tool_calls']);

  if (content !== null && typeof content !== 'string') {
    return undefined;
  }

  return Object.freeze({
    role: 'assistant',
    content: typeof content === 'string' ? content : null,
    ...(toolCalls === undefined ? {} : {tool_calls: toolCalls}),
  } satisfies RoleModelAssistantChatMessage);
}

function optionalRoleModelChatToolCalls(
  value: unknown,
): readonly RoleModelChatToolCall[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const calls: RoleModelChatToolCall[] = [];

  for (const item of value) {
    const call = optionalRoleModelChatToolCall(item);

    if (call === undefined) {
      return undefined;
    }

    calls.push(call);
  }

  return Object.freeze(calls);
}

function optionalRoleModelChatToolCall(
  value: unknown,
): RoleModelChatToolCall | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const id = value['id'];
  const type = value['type'];
  const fn = value['function'];

  if (typeof id !== 'string' || type !== 'function' || !isJsonRecord(fn)) {
    return undefined;
  }

  const name = fn['name'];
  const args = fn['arguments'];

  if (typeof name !== 'string' || typeof args !== 'string') {
    return undefined;
  }

  return Object.freeze({
    id,
    type: 'function',
    function: Object.freeze({
      name,
      arguments: args,
    }),
  } satisfies RoleModelChatToolCall);
}

function optionalProviderMetadata(value: unknown):
  | {
      readonly status: 'accepted';
      readonly providerMetadata?: RoleModelProviderMetadata;
    }
  | {
      readonly status: 'rejected';
      readonly details: RoleModelMalformedAdapterRawOutputDetails;
    } {
  if (value === undefined) {
    return Object.freeze({status: 'accepted'});
  }

  if (!isJsonRecord(value)) {
    return Object.freeze({status: 'accepted'});
  }

  const provider = value['provider'];

  if (provider !== 'local' && provider !== 'nvidia') {
    return Object.freeze({status: 'accepted'});
  }

  const model = value['model'];
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  return Object.freeze({
    status: 'accepted',
    providerMetadata: Object.freeze({
      provider,
      ...(typeof model === 'string' ? {model} : {}),
      ...(request === undefined ? {} : {request: request.request}),
      ...(response === undefined ? {} : {response: response.response}),
      ...(error === undefined ? {} : {error}),
    } satisfies RoleModelProviderMetadata),
  });
}

type ProviderRequestMetadata = NonNullable<
  RoleModelProviderMetadata['request']
>;
type ProviderResponseMetadata = NonNullable<
  RoleModelProviderMetadata['response']
>;

function optionalProviderRequestMetadata(value: unknown):
  | {
      readonly status: 'accepted';
      readonly request: ProviderRequestMetadata;
    }
  | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const endpoint = value['endpoint'];
  const messageCount = value['messageCount'];

  return Object.freeze({
    status: 'accepted',
    request: Object.freeze({
      ...(typeof endpoint === 'string' ? {endpoint: endpoint} : {}),
      ...(typeof messageCount === 'number' ? {messageCount} : {}),
      stream: false,
    }),
  });
}

function optionalProviderResponseMetadata(value: unknown):
  | {
      readonly status: 'accepted';
      readonly response: ProviderResponseMetadata;
    }
  | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const status = value['status'];

  return Object.freeze({
    status: 'accepted',
    response: Object.freeze({
      ...(typeof status === 'number' ? {status} : {}),
    }),
  });
}

function optionalProviderErrorMetadata(
  value: unknown,
): RoleModelProviderMetadata['error'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const code = value['code'];
  const message = value['message'];

  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return Object.freeze({
    code: code,
    message: message,
  });
}

function optionalRoleModelDecisionRejection(
  value: unknown,
): RoleModelDecisionRejection | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const reason = value['reason'];
  const details = value['details'];

  if (!isOneOf(reason, roleModelDecisionRejectionReasons)) {
    return undefined;
  }

  return Object.freeze({
    reason,
    ...(typeof details === 'string' ? {details: details} : {}),
  } satisfies RoleModelDecisionRejection);
}
