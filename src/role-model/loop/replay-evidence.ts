import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {
  isRoleModelMalformedAdapterRawOutputDetails,
  roleModelDisallowedToolRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelPluginToolRejectedRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  roleModelUnknownToolRejectionReason,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionResult,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderMetadata,
  type RoleModelToolObservation,
} from '../api/contracts.ts';
import {createRejectedRoleModelDecisionResult} from '../api/decision.ts';
import {type RoleModelAllowedToolName} from '../api/tool-names.ts';
import {parseRoleModelDecision} from './decision-parser.ts';

export function isRoleModelRawOutputReplayableDecisionEvidence(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[] | undefined;
  readonly pluginToolDefinitions?:
    readonly RoleModelPluginToolDefinition[] | undefined;
  readonly toolObservations?: readonly RoleModelToolObservation[] | undefined;
}): boolean {
  const parsedRawOutputDecision = parseRoleModelDecision(
    options.rawOutputText,
    options.allowedTools,
    options.pluginToolDefinitions,
    options.toolObservations,
  );

  return (
    roleModelDecisionResultsMatch({
      actual: options.decisionResult,
      expected: parsedRawOutputDecision,
    }) ||
    isRoleModelMalformedAdapterRawOutputEvidence({
      rawOutputText: options.rawOutputText,
      decisionResult: options.decisionResult,
    }) ||
    isRoleModelTerminalEmptyOutputRejectionEvidence({
      parsedRawOutputDecision,
      decisionResult: options.decisionResult,
    }) ||
    isRoleModelLoopSynthesizedRejectionEvidence({
      parsedRawOutputDecision,
      decisionResult: options.decisionResult,
    }) ||
    isRoleModelProviderErrorRawOutputEvidence({
      rawOutputText: options.rawOutputText,
      providerMetadata: options.providerMetadata,
      decisionResult: options.decisionResult,
    })
  );
}

export function normalizeReplayableRejectedRoleModelDecisionResult(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations?: readonly RoleModelToolObservation[];
}): RejectedRoleModelDecisionResult | undefined {
  // Fill missing requested tool names from the raw output first: a stored
  // rejection without names may already be replayable as-is, but the decoded
  // snapshot should still carry the names the raw output proves.
  if (options.decisionResult.requestedToolNames === undefined) {
    const normalized = fillRequestedToolNamesFromRawOutput(options);

    if (normalized !== undefined) {
      return normalized;
    }
  }

  return isRoleModelRawOutputReplayableDecisionEvidence({
    rawOutputText: options.rawOutputText,
    providerMetadata: options.providerMetadata,
    decisionResult: options.decisionResult,
    ...(options.allowedTools === undefined
      ? {}
      : {allowedTools: options.allowedTools}),
    ...(options.pluginToolDefinitions === undefined
      ? {}
      : {pluginToolDefinitions: options.pluginToolDefinitions}),
    ...(options.toolObservations === undefined
      ? {}
      : {toolObservations: options.toolObservations}),
  })
    ? options.decisionResult
    : undefined;
}

function fillRequestedToolNamesFromRawOutput(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations?: readonly RoleModelToolObservation[];
}): RejectedRoleModelDecisionResult | undefined {
  const canonicalResult = parseRoleModelDecision(
    options.rawOutputText,
    options.allowedTools,
    options.pluginToolDefinitions,
    options.toolObservations,
  );
  const requestedToolNames =
    canonicalResult.status === 'rejected'
      ? canonicalResult.requestedToolNames
      : loopSynthesizedRejectionReasons.includes(
            options.decisionResult.rejection.reason,
          )
        ? Object.freeze(
            canonicalResult.decision.toolCalls.map(call => call.name),
          )
        : undefined;

  if (requestedToolNames === undefined) {
    return undefined;
  }

  const normalizedResult = createRejectedRoleModelDecisionResult(
    options.decisionResult.rejection.reason,
    options.decisionResult.rejection.details,
    {
      requestedToolNames,
    },
  );

  return isRoleModelRawOutputReplayableDecisionEvidence({
    rawOutputText: options.rawOutputText,
    providerMetadata: options.providerMetadata,
    decisionResult: normalizedResult,
    ...(options.allowedTools === undefined
      ? {}
      : {allowedTools: options.allowedTools}),
    ...(options.pluginToolDefinitions === undefined
      ? {}
      : {pluginToolDefinitions: options.pluginToolDefinitions}),
    ...(options.toolObservations === undefined
      ? {}
      : {toolObservations: options.toolObservations}),
  })
    ? normalizedResult
    : undefined;
}

/**
 * Rejections synthesized above the parser (loop policy: exceeded tool
 * rounds, blank visible_reply) or produced by stricter historical parsers
 * (disallowed/unknown tools, cross-round duplicate limits) legitimately
 * pair a rejected stored snapshot with raw output that re-parses as
 * accepted. They stay replayable, provided any recorded requested tool
 * names still agree with the raw output.
 */
const loopSynthesizedRejectionReasons: readonly string[] = Object.freeze([
  roleModelPluginToolRejectedRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelDisallowedToolRejectionReason,
  roleModelUnknownToolRejectionReason,
]);

function isRoleModelLoopSynthesizedRejectionEvidence(options: {
  readonly parsedRawOutputDecision: RoleModelDecisionResult;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  if (
    options.parsedRawOutputDecision.status !== 'accepted' ||
    options.decisionResult.status !== 'rejected' ||
    !loopSynthesizedRejectionReasons.includes(
      options.decisionResult.rejection.reason,
    )
  ) {
    return false;
  }

  const recordedNames = options.decisionResult.requestedToolNames;

  if (recordedNames === undefined) {
    return true;
  }

  const parsedNames = options.parsedRawOutputDecision.decision.toolCalls.map(
    call => call.name,
  );

  return (
    recordedNames.length === parsedNames.length &&
    recordedNames.every((name, index) => name === parsedNames[index])
  );
}

function isRoleModelTerminalEmptyOutputRejectionEvidence(options: {
  readonly parsedRawOutputDecision: RoleModelDecisionResult;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  return (
    options.parsedRawOutputDecision.status === 'accepted' &&
    options.parsedRawOutputDecision.decision.toolCalls.length === 0 &&
    options.parsedRawOutputDecision.nonCommittedText === undefined &&
    options.decisionResult.status === 'rejected' &&
    options.decisionResult.rejection.reason ===
      roleModelMalformedOutputRejectionReason &&
    options.decisionResult.rejection.details ===
      roleModelTerminalEmptyOutputRejectionDetails
  );
}

export function isRoleModelProviderErrorRawOutputEvidence(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  const providerError = options.providerMetadata?.error;

  return (
    options.rawOutputText.length === 0 &&
    providerError !== undefined &&
    options.decisionResult.status === 'rejected' &&
    options.decisionResult.rejection.reason ===
      roleModelProviderErrorRejectionReason &&
    options.decisionResult.rejection.details === providerError.message
  );
}

function roleModelDecisionResultsMatch(options: {
  readonly actual: RoleModelDecisionResult;
  readonly expected: RoleModelDecisionResult;
}): boolean {
  if (options.actual.status !== options.expected.status) {
    return false;
  }

  if (options.actual.status === 'accepted') {
    return (
      options.expected.status === 'accepted' &&
      options.actual.nonCommittedText === options.expected.nonCommittedText &&
      canonicalJsonValuesEqual(
        options.actual.decision,
        options.expected.decision,
      )
    );
  }

  return (
    options.expected.status === 'rejected' &&
    options.actual.rejection.reason === options.expected.rejection.reason &&
    options.actual.rejection.details === options.expected.rejection.details &&
    isDeepEqualStringArray(
      options.actual.requestedToolNames,
      options.expected.requestedToolNames,
    )
  );
}

function isDeepEqualStringArray(
  actual: readonly string[] | undefined,
  expected: readonly string[] | undefined,
): boolean {
  return (
    actual === expected ||
    (actual !== undefined &&
      expected !== undefined &&
      actual.length === expected.length &&
      actual.every((item, index) => item === expected[index]))
  );
}

function isRoleModelMalformedAdapterRawOutputEvidence(options: {
  readonly rawOutputText: string;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  return (
    options.rawOutputText.length === 0 &&
    options.decisionResult.status === 'rejected' &&
    options.decisionResult.rejection.reason ===
      roleModelMalformedOutputRejectionReason &&
    isRoleModelMalformedAdapterRawOutputDetails(
      options.decisionResult.rejection.details,
    )
  );
}
