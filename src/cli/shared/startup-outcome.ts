import {
  runtimeConfigDiagnosticAttribution,
  type RuntimeConfigDiagnostic,
} from '../../runtime/config/index.ts';
import type {RuntimeCliStartupResult} from '../../app/index.ts';

/**
 * A startup result an operator surface refuses to run on, reduced to
 * what every surface needs: the diagnostic that blocked it (absent when
 * the failure carries no diagnostic) and a fallback describing the
 * status. Surfaces keep their own message format — `formatReason` is
 * offered for the common one, not imposed.
 */
export type RejectedRuntimeCliStartup = {
  readonly outcome: 'rejected';
  readonly diagnostic: RuntimeConfigDiagnostic | undefined;
  readonly fallbackReason: string;
};

/**
 * A startup an operator surface may run on. `warnings` is carried here
 * rather than left on the activation, because a surface that reads only
 * the resolved plan is exactly how discovery warnings went unreported.
 */
export type UsableRuntimeCliStartup<TStartup> = {
  readonly outcome: 'usable';
  readonly startup: TStartup;
  readonly warnings: readonly string[];
};

/**
 * The one reading of a startup result for an operator-facing surface
 * (chat, inspect).
 *
 * Each surface used to re-derive this by hand, and they drifted: two
 * emitted character discovery warnings and one dropped them. Deciding
 * it once means a new surface starts out handling every case it shares
 * with the others.
 *
 * What is *not* decided here: an incompletely configured runtime, which
 * arrives either as `activation_blocked_before_runtime_env` or as
 * activation errors on a resolved plan. Chat refuses it, because it
 * constructs plugin resources from that plan. Inspect
 * reports it and exits 0 — describing a partly-configured runtime is
 * precisely what an operator runs inspect for, so refusing would remove
 * the answer they came for. That is a real difference in what these
 * surfaces are, not drift, so it stays with each surface.
 */
export function interpretRuntimeCliStartup<
  TStartup extends RuntimeCliStartupResult,
>(
  startup: TStartup,
):
  | RejectedRuntimeCliStartup
  | UsableRuntimeCliStartup<
      Extract<TStartup, {status: 'resolved'}> & {
        readonly characterActivation: {readonly status: 'resolved'};
      }
    > {
  if (startup.status === 'character_invalid') {
    return rejected(
      undefined,
      startup.characterActivation.status === 'failed'
        ? (startup.characterActivation.messages[0] ??
            'Character activation failed.')
        : 'Character activation failed.',
    );
  }

  if (startup.status === 'config_invalid') {
    return rejected(
      firstError(startup.activationPlan.resolvedConfig.diagnostics),
      'Runtime config is invalid.',
    );
  }

  const characterActivation = startup.characterActivation;

  // A resolved startup carries a resolved character by construction;
  // this narrows the type rather than expecting to fire.
  if (characterActivation.status !== 'resolved') {
    return rejected(undefined, 'Character activation failed.');
  }

  return Object.freeze({
    outcome: 'usable',
    startup: startup as Extract<TStartup, {status: 'resolved'}> & {
      readonly characterActivation: {readonly status: 'resolved'};
    },
    warnings: characterActivation.warnings,
  });
}

/**
 * The common one-line rendering of a rejection: the blocking
 * diagnostic with its character attribution, or the status fallback.
 */
export function formatRejectedRuntimeCliStartup(
  rejection: RejectedRuntimeCliStartup,
): string {
  return rejection.diagnostic === undefined
    ? rejection.fallbackReason
    : `${runtimeConfigDiagnosticAttribution(rejection.diagnostic)}${
        rejection.diagnostic.message
      }`;
}

function rejected(
  diagnostic: RuntimeConfigDiagnostic | undefined,
  fallbackReason: string,
): RejectedRuntimeCliStartup {
  return Object.freeze({outcome: 'rejected', diagnostic, fallbackReason});
}

function firstError(
  diagnostics: readonly RuntimeConfigDiagnostic[],
): RuntimeConfigDiagnostic | undefined {
  return diagnostics.find(diagnostic => diagnostic.severity === 'error');
}
