/**
 * The contract, as a client imports it: every shape that crosses the
 * socket, declared by the generated file the Rust wire types write, and
 * nothing of the daemon behind it. This barrel value-imports nothing
 * (arch rule `clients-see-only-the-wire`).
 */
export type * from './generated/contract.ts';
export {
  gatewayLoopbackHostnames,
  gatewayProtocolVersion,
  turnCommittedTheLine,
} from './contract.ts';
export {foldRunningTurns, type RunningTurns} from './running-turns.ts';
/** What `<home>/daemon.json` holds, for a reader that finds the daemon by it. */
export type {DaemonRecord} from '../../shared/daemon-record.ts';
