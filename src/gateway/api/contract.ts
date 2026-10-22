import type {TurnOutcome} from './generated/contract.ts';

/**
 * Bumped when a client could no longer read what the daemon says. Health
 * carries it so an old frontend meets a clear message, not a mystery.
 */
export const gatewayProtocolVersion = 7;

/**
 * The only hosts the daemon answers on, and the only ones a client may be
 * pointed at: a token and a thread never leave the machine in the clear.
 * The daemon binds IPv4 loopback alone, so the IPv6 literal is not one.
 */
export const gatewayLoopbackHostnames: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
]);

/**
 * Whether a turn put the line it was given in the log. A surface holds a
 * line until it knows: one that was committed belongs to the thread, and
 * one that was not is the person's to write again. Nothing else answers
 * it — the log is read in pages, and a busy turn can put a hundred
 * messages between a line and now.
 */
export function turnCommittedTheLine(outcome: TurnOutcome): boolean {
  switch (outcome.status) {
    case 'completed':
      return true;
    case 'refused':
      // A duplicate is the one refusal that means the line is in the log
      // already: an earlier run of the daemon took it under this same id.
      return outcome.reason === 'duplicate_submission';
    default:
      return outcome.committed;
  }
}
