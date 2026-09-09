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

type RoleModelAdapterRawOutputValidationResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly providerExchange?: RoleModelProviderExchangeSnapshot;
      readonly replyDrafts?: readonly number[];
    }
  | {
      readonly status: 'rejected';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly providerExchange?: RoleModelProviderExchangeSnapshot;
      readonly replyDrafts?: readonly number[];
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

  return Object.freeze({
    status: 'accepted',
    rawOutputText,
    ...providerMetadataOption(providerMetadata),
    ...providerExchangeOption(providerExchange),
    ...replyDraftsOption(rawOutput['replyDrafts']),
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

/** A mapping that is not draft numbers is no mapping: draft n is then reply n. */
function replyDraftsOption(value: unknown): {
  readonly replyDrafts?: readonly number[];
} {
  if (!Array.isArray(value)) {
    return {};
  }

  const drafts = value.filter(
    (entry): entry is number =>
      typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0,
  );

  return drafts.length === value.length
    ? {replyDrafts: Object.freeze(drafts)}
    : {};
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
