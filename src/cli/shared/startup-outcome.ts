import {
  runtimeConfigDiagnosticAttribution,
  type RuntimeConfigDiagnostic,
} from '../../runtime/config/index.ts';
import type {RuntimeCliStartupResult} from '../../app/index.ts';

export type RejectedRuntimeCliStartup = {
  readonly outcome: 'rejected';
  readonly diagnostic: RuntimeConfigDiagnostic | undefined;
  readonly fallbackReason: string;
};

/** Warnings ride here so a surface reading only the plan cannot drop them. */
export type UsableRuntimeCliStartup<TStartup> = {
  readonly outcome: 'usable';
  readonly startup: TStartup;
  readonly warnings: readonly string[];
};

/**
 * The one reading of a startup result for an operator-facing surface.
 * An incompletely configured runtime is left to each surface to decide.
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

  // A resolved startup carries a resolved character; this narrows the type.
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
