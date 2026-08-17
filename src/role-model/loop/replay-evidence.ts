import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {
  roleModelProviderErrorRejectionReason,
  type RoleModelDecisionResult,
} from '../api/contracts.ts';
import {parseRoleModelDecision} from './decision-parser.ts';

/**
 * A stored decision must be what the raw output says: the parser is
 * deterministic, so re-parsing the raw text reproduces the accepted decision
 * or the parser's own refusal. The one thing raw text cannot say is that
 * nothing arrived — a provider error leaves the raw text empty.
 */
export function isRoleModelRawOutputReplayableDecisionEvidence(options: {
  readonly rawOutputText: string;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  const {rawOutputText, decisionResult} = options;

  if (resultsMatch(decisionResult, parseRoleModelDecision(rawOutputText))) {
    return true;
  }

  return (
    rawOutputText.length === 0 &&
    decisionResult.status === 'rejected' &&
    decisionResult.rejection.reason === roleModelProviderErrorRejectionReason
  );
}

function resultsMatch(
  stored: RoleModelDecisionResult,
  reparsed: RoleModelDecisionResult,
): boolean {
  if (stored.status === 'accepted') {
    return (
      reparsed.status === 'accepted' &&
      canonicalJsonValuesEqual(stored.decision, reparsed.decision)
    );
  }

  return (
    reparsed.status === 'rejected' &&
    stored.rejection.reason === reparsed.rejection.reason &&
    stored.rejection.details === reparsed.rejection.details
  );
}
