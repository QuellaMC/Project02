import {randomBytes} from 'node:crypto';

import {
  acquireLocalRuntimeDaemonLease,
  LocalRuntimeStorageContractError,
  readDaemonRecord,
  writeDaemonRecord,
  type DaemonRecord,
} from '../runtime/storage/index.ts';
import {gatewayProtocolVersion} from './api/contract.ts';

/**
 * A daemon's claim on its home, held from before the socket is bound
 * until after it is closed. The token and the port belong to the home:
 * a later run finds them in the record and is the same address again.
 */
export type DaemonClaim = {
  readonly token: string;
  /** The port the home's last run bound, for this one to bind again; none on a first run. */
  readonly port?: number;
  /** A record was there and could not be read; the claim minted a token in its place. */
  readonly unreadableRecord?: string;
  /**
   * Says where the daemon listens: the record is rewritten with the port
   * bound and this run. Returns the port the record held when this one
   * differs — the home's port was taken and the address moved.
   */
  publish(port: number): number | undefined;
  /**
   * Rewrites the record without a run, best effort — a record that could
   * not be rewritten is stale, which every reader handles — then lets
   * the lease go. A lease that could not be let go is returned as the
   * problem it is; the next start reclaims it.
   */
  release(): Promise<string | undefined>;
};

export type DaemonClaimOutcome =
  | {readonly status: 'claimed'; readonly claim: DaemonClaim}
  /** Another process holds the home; its record, when there is one to read. */
  | {readonly status: 'held'; readonly record?: DaemonRecord};

/**
 * Takes the home's daemon lease — at once, or within a wait that the
 * signal can end — and reads what the last run left: its token, kept, and
 * its port, to bind again. Nothing is written until `publish`.
 */
export async function claimDaemonHome(options: {
  readonly homeRoot: string;
  readonly waitTimeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<DaemonClaimOutcome> {
  const {homeRoot} = options;
  let lease;

  try {
    lease = await acquireLocalRuntimeDaemonLease(options);
  } catch (error: unknown) {
    if (
      error instanceof LocalRuntimeStorageContractError &&
      error.code === 'storage_busy'
    ) {
      const reading = readDaemonRecord({homeRoot});

      return reading.status === 'ok'
        ? {status: 'held', record: reading.record}
        : {status: 'held'};
    }

    throw error;
  }

  const reading = readDaemonRecord({homeRoot});
  const previous = reading.status === 'ok' ? reading.record : undefined;
  const token = previous?.token ?? randomBytes(32).toString('base64url');
  let published: DaemonRecord | undefined;

  return {
    status: 'claimed',
    claim: Object.freeze({
      token,
      ...(previous === undefined ? {} : {port: previous.port}),
      ...(reading.status === 'unreadable'
        ? {unreadableRecord: reading.message}
        : {}),
      publish(port) {
        published = {
          protocolVersion: gatewayProtocolVersion,
          token,
          port,
          running: {pid: process.pid, startedAt: new Date().toISOString()},
        };
        writeDaemonRecord({homeRoot, record: published});

        return previous !== undefined && previous.port !== port
          ? previous.port
          : undefined;
      },
      async release() {
        if (published !== undefined) {
          try {
            writeDaemonRecord({
              homeRoot,
              record: {
                protocolVersion: gatewayProtocolVersion,
                token,
                port: published.port,
              },
            });
          } catch {
            // Stale, and handled by every reader that finds it so.
          }
        }

        try {
          await lease.release();

          return undefined;
        } catch (error: unknown) {
          return (
            'The daemon lease on this home could not be released: ' +
            `${error instanceof Error ? error.message : String(error)} ` +
            'The next start takes it over.'
          );
        }
      },
    }),
  };
}
