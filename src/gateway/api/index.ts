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
  maxSpeakerNameLength,
  turnCommittedTheLine,
} from './contract.ts';
export {foldRunningTurns, type RunningTurns} from './running-turns.ts';
