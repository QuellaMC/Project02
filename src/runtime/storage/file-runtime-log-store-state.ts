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
  CachedRuntimeSessionEvidence,
  MutableDurableRuntimeSessionEvidence,
} from '../evidence/contract.ts';
import {
  readCoherentRuntimeSessionEvidence,
  readRuntimeEvidenceFileStamps,
  sameRuntimeEvidenceFileStamps,
  scavengeAbandonedRuntimeEvidenceTemporaryFiles,
} from '../evidence/cache.ts';
import {
  createRuntimeEvidenceTransitionMachine,
  type RuntimeEvidenceTransitionMachine,
} from '../evidence/transition.ts';
import {assertDurableRuntimeSessionEvidence} from '../evidence/validation.ts';

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

export class FileRuntimeLogStoreState {
  readonly paths: LocalRuntimeSessionPaths;
  readonly writerLockOwnerToken: LocalRuntimeMutationLockOwnerToken;
  private readonly options: FileRuntimeLogStoreStateOptions;
  private readonly locksRoot: string;
  private readonly writerResourceKey: string;
  private cachedEvidence: CachedRuntimeSessionEvidence | undefined;
  private transitionMachine: RuntimeEvidenceTransitionMachine | undefined;
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
    this.assertSessionReadable();

    if (this.writerIsActive() && !this.temporaryFilesScavenged) {
      scavengeAbandonedRuntimeEvidenceTemporaryFiles(this.paths);
      this.temporaryFilesScavenged = true;
    }

    return this.refreshStoredEvidence();
  }

  refreshStoredEvidence(): MutableDurableRuntimeSessionEvidence {
    const currentStamps = readRuntimeEvidenceFileStamps(this.paths);

    if (
      this.cachedEvidence !== undefined &&
      sameRuntimeEvidenceFileStamps(this.cachedEvidence.stamps, currentStamps)
    ) {
      return this.cachedEvidence.evidence;
    }

    const loaded = readCoherentRuntimeSessionEvidence(
      this.paths,
      this.options.onEvidenceFileRead,
    );
    this.cachedEvidence = loaded;
    this.transitionMachine = undefined;
    return loaded.evidence;
  }

  ensureTransitionMachine(
    evidence: MutableDurableRuntimeSessionEvidence,
  ): RuntimeEvidenceTransitionMachine {
    if (this.transitionMachine === undefined) {
      this.options.onEvidenceValidation?.('cold_snapshot');
      assertDurableRuntimeSessionEvidence({
        paths: this.paths,
        evidence,
        mode: 'public',
        ...(this.options.boundCharacter === undefined
          ? {}
          : {boundCharacter: this.options.boundCharacter}),
        ...(this.options.boundUserSpeaker === undefined
          ? {}
          : {boundUserSpeaker: this.options.boundUserSpeaker}),
      });
      this.transitionMachine = createRuntimeEvidenceTransitionMachine({
        evidence,
        sessionId: this.paths.sessionId,
        ...(this.options.boundCharacter === undefined
          ? {}
          : {boundCharacter: this.options.boundCharacter}),
        ...(this.options.boundUserSpeaker === undefined
          ? {}
          : {boundUserSpeaker: this.options.boundUserSpeaker}),
      });
    }

    return this.transitionMachine;
  }

  recordIncrementalValidation(): void {
    this.options.onEvidenceValidation?.('incremental_append');
  }

  checkpointCachedEvidenceStamps(): void {
    if (this.cachedEvidence === undefined) {
      return;
    }

    this.cachedEvidence = {
      evidence: this.cachedEvidence.evidence,
      stamps: readRuntimeEvidenceFileStamps(this.paths),
    };
  }

  invalidateCachedEvidence(): void {
    this.cachedEvidence = undefined;
    this.transitionMachine = undefined;
  }

  private writerIsActive(): boolean {
    return localRuntimeMutationLockOwnerOwnsResource({
      locksRoot: this.locksRoot,
      resourceKey: this.writerResourceKey,
      ownerToken: this.writerLockOwnerToken,
    });
  }
}
