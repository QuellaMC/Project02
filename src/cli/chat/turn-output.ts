import type {
  LocalRuntimeTurnProgressEvent,
  SegmentRotation,
} from '../../runtime/index.ts';
import type {ChatTraceSummary} from '../../runtime/evidence/index.ts';

/** What the person sees of a turn as it runs: replies, tool activity, trace. */
export function writeRuntimeProgress(
  stdout: NodeJS.WritableStream,
  progressEvent: LocalRuntimeTurnProgressEvent,
): void {
  if (progressEvent.kind === 'visible_reply') {
    stdout.write(`${progressEvent.speakerName}: ${progressEvent.text}\n`);
    return;
  }

  if (progressEvent.kind === 'tool_calls_requested') {
    stdout.write(
      `[tools] Model requested ${String(progressEvent.toolNames.length)} ${progressEvent.toolNames.length === 1 ? 'tool call' : 'tool calls'}: ${progressEvent.toolNames.join(', ')}\n`,
    );
    return;
  }

  stdout.write(
    `[tools] ${progressEvent.toolName} ${progressEvent.status === 'accepted' ? 'completed' : 'rejected'}\n`,
  );
}
export function writeTraceSummary(
  stderr: NodeJS.WritableStream,
  summary: ChatTraceSummary,
): void {
  stderr.write(`${JSON.stringify(summary)}\n`);
}

/** A rotation that succeeds stays invisible; one that broke must not. */
export function writeRotationWarnings(
  stderr: NodeJS.WritableStream,
  rotation: SegmentRotation,
): void {
  if (rotation.status === 'failed') {
    stderr.write(
      `Warning: the conversation could not continue in a new session and stays in ${rotation.from}: ${rotation.message}\n`,
    );
    return;
  }

  if (rotation.endFailure !== undefined) {
    stderr.write(
      `Warning: session ${rotation.from} could not be closed cleanly: ${rotation.endFailure}\n`,
    );
  }
}
