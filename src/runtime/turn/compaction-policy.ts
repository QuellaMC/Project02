import type {VisibleMessage} from '../../core/index.ts';
import {
  estimateConversationTurnTokens,
  selectConversationHistoryWindow,
  type ConversationTurn,
} from '../../role-model/index.ts';
import {maxContextSummaryChars} from '../evidence/records.ts';

/**
 * How much of the context window the carried tail may fill: enough that the
 * character keeps its exact last exchanges, small enough that the new session
 * starts light. The trigger is not a token guess: a session continues the
 * moment its history window would drop a whole turn.
 */
const carriedHistoryShare = 0.25;
const summarizerInputShare = 0.6;
const summarizerLineHeadChars = 1200;
const summarizerLineTailChars = 400;
export const maxFallbackSummaryChars = 2000;

export type SessionContinuationSelection = {
  /** Oldest first: what the summary must now cover. */
  readonly summarized: readonly ConversationTurn[];
  /** Oldest first: what the new session replays verbatim. */
  readonly carried: readonly ConversationTurn[];
};

export function selectSessionContinuation(
  turns: readonly ConversationTurn[],
  options: {readonly contextWindowTokens: number},
): SessionContinuationSelection | undefined {
  const window = selectConversationHistoryWindow(turns, options);

  if (window.length === turns.length) {
    return undefined;
  }

  const budget = Math.floor(options.contextWindowTokens * carriedHistoryShare);
  const carried: ConversationTurn[] = [];
  let used = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (turn === undefined) {
      continue;
    }

    const cost = estimateConversationTurnTokens(turn);

    if (carried.length > 0 && used + cost > budget) {
      break;
    }

    carried.unshift(turn);
    used += cost;
  }

  const summarized = turns.slice(0, turns.length - carried.length);

  return summarized.length === 0
    ? undefined
    : Object.freeze({
        summarized: Object.freeze(summarized),
        carried: Object.freeze(carried),
      });
}

/**
 * The summariser reads a plain transcript: one line per message, speakers by
 * name, tool calls and results as bracketed lines, long lines shortened from
 * the middle, oldest lines dropped first when the whole would not fit.
 */
export function serializeTurnsForSummarizer(options: {
  readonly turns: readonly ConversationTurn[];
  readonly previousSummary?: string;
  readonly userDisplayName?: string;
  readonly contextWindowTokens: number;
}): string {
  const userName = options.userDisplayName ?? 'User';
  const lines: string[] = [];
  let lastDay: string | undefined;

  for (const turn of options.turns) {
    const day = turn.createdAt.slice(0, 10);

    if (day !== lastDay) {
      lines.push(`[${day}]`);
      lastDay = day;
    }

    lines.push(speakerLine(userName, turn.userMessage));

    for (const round of turn.toolRounds) {
      for (const reply of round.interimReplies) {
        lines.push(speakerLine(reply.speakerName, reply));
      }

      for (const call of round.toolCalls) {
        lines.push(
          shortenLine(
            `[tool call ${call.toolName}] ${JSON.stringify(call.input)}`,
          ),
        );
        lines.push(
          shortenLine(
            call.result.status === 'accepted'
              ? `[tool result ${call.toolName}] ${JSON.stringify(call.result.output)}`
              : `[tool result ${call.toolName}] rejected: ${call.result.message}`,
          ),
        );
      }
    }

    for (const reply of turn.finalReplies) {
      lines.push(speakerLine(reply.speakerName, reply));
    }
  }

  const capChars = Math.floor(
    options.contextWindowTokens * 4 * summarizerInputShare,
  );
  let dropped = 0;

  while (lines.length > 1 && lines.join('\n').length > capChars) {
    lines.shift();
    dropped += 1;
  }

  const transcript = [
    ...(dropped === 0
      ? []
      : [`[… ${String(dropped)} earlier lines omitted …]`]),
    ...lines,
  ].join('\n');

  return options.previousSummary === undefined
    ? `<conversation>\n${transcript}\n</conversation>`
    : `<existing_summary>\n${options.previousSummary}\n</existing_summary>\n<conversation>\n${transcript}\n</conversation>`;
}

/** Trims and bounds model output; an empty result means the model gave nothing usable. */
export function capSummaryText(text: string): string | undefined {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.length <= maxContextSummaryChars) {
    return trimmed;
  }

  const head = trimmed.slice(0, maxContextSummaryChars);
  const boundary = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('\n'),
    head.lastIndexOf('。'),
  );

  return boundary > maxContextSummaryChars * 0.8
    ? head.slice(0, boundary + 1).trim()
    : head.trim();
}

/**
 * When no model can summarise, the record still says what happened: how much
 * conversation went by, when, and the last few things the person said.
 */
export function mechanicalSummary(options: {
  readonly summarized: readonly ConversationTurn[];
  readonly previousSummary?: string;
  readonly userDisplayName?: string;
}): string {
  const first = options.summarized[0];
  const last = options.summarized[options.summarized.length - 1];
  const userName = options.userDisplayName ?? 'the person';
  const recentUserLines = options.summarized
    .slice(-3)
    .map(turn => `“${shortenTo(turn.userMessage.text, 160)}”`)
    .join(' · ');
  const tools = [
    ...new Set(
      options.summarized.flatMap(turn =>
        turn.toolRounds.flatMap(round =>
          round.toolCalls.map(call => call.toolName),
        ),
      ),
    ),
  ];
  const section = shortenTo(
    [
      `Earlier conversation (${String(options.summarized.length)} turns, ${
        first?.createdAt.slice(0, 10) ?? '?'
      } to ${last?.createdAt.slice(0, 10) ?? '?'}) is not in context verbatim.`,
      `Most recent things ${userName} said there: ${recentUserLines}.`,
      ...(tools.length === 0 ? [] : [`Tools used there: ${tools.join(', ')}.`]),
      'Details from that part are not available in context.',
    ].join(' '),
    maxFallbackSummaryChars,
  );

  if (options.previousSummary === undefined) {
    return section;
  }

  const room = maxContextSummaryChars - section.length - 2;

  return `${shortenTo(options.previousSummary, room)}\n\n${section}`;
}

function speakerLine(name: string, message: VisibleMessage): string {
  return shortenLine(`${name}: ${message.text.replaceAll('\n', ' ')}`);
}

function shortenLine(line: string): string {
  if (line.length <= summarizerLineHeadChars + summarizerLineTailChars) {
    return line;
  }

  const omitted =
    line.length - summarizerLineHeadChars - summarizerLineTailChars;

  return `${line.slice(0, summarizerLineHeadChars)} [… ${String(
    omitted,
  )} chars omitted …] ${line.slice(-summarizerLineTailChars)}`;
}

function shortenTo(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
