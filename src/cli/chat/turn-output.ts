import type {ConversationSession} from '../../core/index.ts';
import type {LocalRuntimeTurnProgressEvent} from '../../runtime/index.ts';
import type {ChatTraceSummary} from '../../runtime/evidence/index.ts';

/** What the person sees of a turn as it runs: replies, tool activity, model text, trace. */
export function writeRuntimeProgress(
  stdout: NodeJS.WritableStream,
  session: ConversationSession,
  progressEvent: LocalRuntimeTurnProgressEvent,
): void {
  if (progressEvent.kind === 'visible_reply') {
    stdout.write(`${session.character.displayName}: ${progressEvent.text}\n`);
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
export function writeNonCommittedTopLevelText(
  stdout: NodeJS.WritableStream,
  text: string,
): void {
  stdout.write('[model top-level text | not committed]\n');
  stdout.write(text);

  if (!text.endsWith('\n')) {
    stdout.write('\n');
  }

  stdout.write('[/model top-level text]\n');
}
export function writeTraceSummary(
  stderr: NodeJS.WritableStream,
  summary: ChatTraceSummary,
): void {
  stderr.write(`${JSON.stringify(summary)}\n`);
}
