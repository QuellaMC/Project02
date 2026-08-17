import {
  roleModelDecisionRejectionReasons,
  roleModelProviderErrorRejectionReason,
  type RoleModelDecisionRejection,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  type RejectedRoleModelDecisionResult,
} from '../api/contracts.ts';
import {createRejectedRoleModelDecisionResult} from '../api/decision.ts';
import {isRoleModelRawOutputReplayableDecisionEvidence} from './replay-evidence.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {isOneOf} from '../../shared/one-of.ts';
import {parseRoleModelProviderExchangeSnapshot} from '../api/provider-exchange.ts';
import type {
  RoleModelAssistantChatMessage,
  RoleModelChatToolCall,
} from '../api/chat-wire.ts';

type RoleModelAdapterRawOutputValidationResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly providerExchange?: RoleModelProviderExchangeSnapshot;
      readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
    }
  | {
      readonly status: 'rejected';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly providerExchange?: RoleModelProviderExchangeSnapshot;
      readonly decisionResult: RejectedRoleModelDecisionResult;
    };

/**
 * The adapter is our side of the provider: when what it hands back is not
 * the contract, nothing usable arrived, and the round is a provider error
 * with no raw text — the loop ends the turn rather than hand it back.
 */
export function validateRoleModelAdapterRawOutput(
  rawOutput: unknown,
): RoleModelAdapterRawOutputValidationResult {
  if (!isJsonRecord(rawOutput)) {
    return createProviderFailureResult(
      'Adapter raw output must include string rawOutputText.',
    );
  }

  const rawOutputText = rawOutput['rawOutputText'];

  if (typeof rawOutputText !== 'string') {
    return createProviderFailureResult(
      'Adapter raw output must include string rawOutputText.',
    );
  }

  const providerMetadata = optionalProviderMetadata(
    rawOutput['providerMetadata'],
  );
  const providerExchange = parseRoleModelProviderExchangeSnapshot(
    rawOutput['providerExchange'],
  );

  if (
    rawOutput['providerExchange'] !== undefined &&
    providerExchange === undefined
  ) {
    return createProviderFailureResult(
      'Role-model adapter provider exchange is malformed.',
    );
  }

  const rejection = optionalRoleModelDecisionRejection(rawOutput['rejection']);

  if (rejection !== undefined) {
    const decisionResult = createRejectedRoleModelDecisionResult(
      rejection.reason,
      rejection.details,
    );

    if (
      !isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText,
        decisionResult,
      })
    ) {
      return createProviderFailureResult(
        'Adapter rejection must be replayable from rawOutputText.',
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

  const nativeAssistantMessage = optionalRoleModelAssistantChatMessage(
    rawOutput['nativeAssistantMessage'],
  );

  return Object.freeze({
    status: 'accepted',
    rawOutputText,
    ...providerMetadataOption(providerMetadata),
    ...providerExchangeOption(providerExchange),
    ...(nativeAssistantMessage === undefined ? {} : {nativeAssistantMessage}),
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

function createProviderFailureResult(
  details: string,
): RoleModelAdapterRawOutputValidationResult {
  return Object.freeze({
    status: 'rejected',
    rawOutputText: '',
    decisionResult: createRejectedRoleModelDecisionResult(
      roleModelProviderErrorRejectionReason,
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

function optionalProviderMetadata(
  value: unknown,
): RoleModelProviderMetadata | undefined {
  if (!isJsonRecord(value) || value['provider'] !== 'nvidia') {
    return undefined;
  }

  const model = value['model'];
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  return Object.freeze({
    provider: 'nvidia',
    ...(typeof model === 'string' ? {model} : {}),
    ...(request === undefined ? {} : {request: request.request}),
    ...(response === undefined ? {} : {response: response.response}),
    ...(error === undefined ? {} : {error}),
  } satisfies RoleModelProviderMetadata);
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
