/**
 * Cross-module imports of gateway land here; arch:check rule 5 accepts
 * first- and second-level barrels. A client of the socket imports
 * `api/index.ts` and `client/index.ts` instead — the contract and the
 * reference client, without the daemon behind them.
 */
export * from './api/index.ts';
export {createGateway, type CreateGatewayOptions} from './gateway.ts';
export {
  claimDaemonHome,
  type DaemonClaim,
  type DaemonClaimOutcome,
} from './discovery.ts';
export {
  createGatewayServer,
  type GatewayServer,
  type GatewayServerOptions,
} from './http/server.ts';
export {
  createLocalCharacterRuntime,
  type LocalCharacterRuntime,
  type LocalCharacterRuntimeOptions,
} from './runtime/character-runtime.ts';
