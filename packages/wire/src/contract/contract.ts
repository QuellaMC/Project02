import type {GatewayHealth} from './generated/contract.ts';

/**
 * The protocol this client speaks, the one the daemon's types declare:
 * bumped there, it does not compile here until this follows. Health
 * carries it so an old frontend meets a clear message, not a mystery.
 */
export const gatewayProtocolVersion: GatewayHealth['protocolVersion'] = 12;

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
 * The longest name a speaker goes by, in characters, as `SpeakerName`
 * declares it: a client that names someone, such as an account asking to
 * pair, cuts the name to it.
 */
export const maxSpeakerNameLength = 128;
