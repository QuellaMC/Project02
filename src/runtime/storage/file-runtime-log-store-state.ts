import type {CharacterProfile, SpeakerIdentity} from '../../core/index.ts';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths,
  type LocalRuntimeSessionPathsOptions,
} from './layout-contract.ts';
import {
  assertLocalRuntimeSessionDirectoryIsReal,
  assertLocalRuntimeSessionReadable,
} from './session-store.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  localRuntimeMutationLockOwnerOwnsResource,
  type LocalRuntimeMutationLockOwnerToken,
} from './mutation-lock.ts';
import type {
  MutableDurableRuntimeSessionEvidence,
  RuntimeEvidenceFileStamps,
} from '../evidence/contract.ts';
import {
  readCoherentRuntimeSessionRecords,
  readRuntimeEvidenceFileStamps,
  sameRuntimeEvidenceFileStamps,
  scavengeAbandonedRuntimeEvidenceTemporaryFiles,
} from '../evidence/cache.ts';
import {
  replayRuntimeEvidence,
  type RuntimeEvidenceTransitionMachine,
} from '../evidence/transition.ts';

export type FileRuntimeLogStoreStateOptions =
  LocalRuntimeSessionPathsOptions & {
    readonly characterId: string;
    readonly writerLockOwnerToken?: LocalRuntimeMutationLockOwnerToken;
    readonly boundCharacter?: CharacterProfile;
    readonly boundUserSpeaker?: SpeakerIdentity;
    readonly onEvidenceValidation?: (
      mode: 'cold_snapshot' | 'incremental_append',
    ) => void;
    readonly onEvidenceFileRead?: (event: {
      readonly filePath: string;
      readonly attempt: number;
    }) => void;
  };

type LoadedRuntimeSessionEvidence = {
  readonly stamps: RuntimeEvidenceFileStamps;
  readonly evidence: MutableDurableRuntimeSessionEvidence;
  readonly machine: RuntimeEvidenceTransitionMachine;
};

export class FileRuntimeLogStoreState {
  readonly paths: LocalRuntimeSessionPaths;
  readonly writerLockOwnerToken: LocalRuntimeMutationLockOwnerToken;
  private readonly options: FileRuntimeLogStoreStateOptions;
  private readonly locksRoot: string;
  private readonly writerResourceKey: string;
  private loadedEvidence: LoadedRuntimeSessionEvidence | undefined;
  private sessionReadabilityChecked = false;
  private temporaryFilesScavenged = false;

  constructor(options: FileRuntimeLogStoreStateOptions) {
    if (
      options.boundCharacter !== undefined &&
      options.boundCharacter.id !== options.characterId
    ) {
      throw new LocalRuntimeStorageContractError(
        'character_identity_mismatch',
        `File runtime log store character "${options.characterId}" does not match bound character "${options.boundCharacter.id}".`,
      );
    }

    this.options = options;
    this.paths = createLocalRuntimeSessionPaths(options);
    this.locksRoot = createLocalRuntimeStorageLayout({
      storeRoot: this.paths.storeRoot,
    }).locksRoot;
    this.writerResourceKey = `session-writer:${this.paths.sessionId}`;
    this.writerLockOwnerToken =
      options.writerLockOwnerToken ??
      createLocalRuntimeMutationLockOwnerToken();
  }

  assertSessionReadable(): void {
    const sessionOptions = {
      storeRoot: this.options.storeRoot,
      sessionId: this.paths.sessionId,
      characterId: this.options.characterId,
    };

    if (this.sessionReadabilityChecked) {
      // Session identity is settled, but the directory being a real directory is
      // a live filesystem property: a swap to a symlink after the first read
      // would otherwise let later appends write through the link.
      assertLocalRuntimeSessionDirectoryIsReal(sessionOptions);
      return;
    }

    assertLocalRuntimeSessionReadable(sessionOptions);
    this.sessionReadabilityChecked = true;
  }

  assertWriterOwnership(): void {
    if (this.writerIsActive()) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'session_busy',
      `Durable runtime mutation requires the active session writer lease: ${this.paths.sessionId}.`,
    );
  }

  readStoredEvidence(): MutableDurableRuntimeSessionEvidence {
    return this.loadStoredEvidence().evidence;
  }

  transitionMachine(): RuntimeEvidenceTransitionMachine {
    return this.loadStoredEvidence().machine;
  }

  private loadStoredEvidence(): LoadedRuntimeSessionEvidence {
    this.assertSessionReadable();

    if (this.writerIsActive() && !this.temporaryFilesScavenged) {
      scavengeAbandonedRuntimeEvidenceTemporaryFiles(this.paths);
      this.temporaryFilesScavenged = true;
    }

    const currentStamps = readRuntimeEvidenceFileStamps(this.paths);

    if (
      this.loadedEvidence !== undefined &&
      sameRuntimeEvidenceFileStamps(this.loadedEvidence.stamps, currentStamps)
    ) {
      return this.loadedEvidence;
    }

    const loaded = readCoherentRuntimeSessionRecords(
      this.paths,
      this.options.onEvidenceFileRead,
    );

    // The stored log is validated the one way anything enters evidence:
    // by replaying it through the append gate. A file that does not
    // replay never becomes cached evidence.
    this.options.onEvidenceValidation?.('cold_snapshot');
    const replayed = replayRuntimeEvidence({
      rawEvents: loaded.rawEvents,
      sessionId: this.paths.sessionId,
      ...(this.options.boundCharacter === undefined
        ? {}
        : {boundCharacter: this.options.boundCharacter}),
      ...(this.options.boundUserSpeaker === undefined
        ? {}
        : {boundUserSpeaker: this.options.boundUserSpeaker}),
    });

    this.loadedEvidence = {
      stamps: loaded.stamps,
      evidence: replayed.evidence,
      machine: replayed.machine,
    };
    return this.loadedEvidence;
  }

  recordIncrementalValidation(): void {
    this.options.onEvidenceValidation?.('incremental_append');
  }

  checkpointCachedEvidenceStamps(): void {
    if (this.loadedEvidence === undefined) {
      return;
    }

    this.loadedEvidence = {
      ...this.loadedEvidence,
      stamps: readRuntimeEvidenceFileStamps(this.paths),
    };
  }

  invalidateCachedEvidence(): void {
    this.loadedEvidence = undefined;
  }

  private writerIsActive(): boolean {
    return localRuntimeMutationLockOwnerOwnsResource({
      locksRoot: this.locksRoot,
      resourceKey: this.writerResourceKey,
      ownerToken: this.writerLockOwnerToken,
    });
  }
}
