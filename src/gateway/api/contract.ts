import type {CharacterPackageDiagnostic} from '../../characters/index.ts';
import type {RuntimePluginToolConfirmationRequest} from '../../plugins/index.ts';
import type {RuntimeConfigDiagnostic} from '../../runtime/config/index.ts';
import type {
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageRejectionReason,
} from '../../runtime/index.ts';
import type {LocalRuntimeStorageContractError} from '../../runtime/storage/index.ts';

/**
 * Bumped when a client could no longer read what the daemon says. Health
 * carries it so an old frontend meets a clear message, not a mystery.
 */
export const gatewayProtocolVersion = 1;

/**
 * A message from one participant into one conversation. The shape is
 * participant-agnostic; the current gateway accepts only the local user as
 * sender and refuses anything else with a structured outcome. The two
 * stamps are the client's own words about the submission, persisted with
 * it and echoed on the stream: which surface carried it (`web`,
 * `telegram:<bot>`) and an id a repeat of the same submission reuses.
 * Neither is trusted for anything but rendering and correlation.
 */
export type GatewayMessage = {
  readonly conversationId: string;
  readonly senderId: string;
  readonly text: string;
  readonly source: string;
  readonly clientMessageId: string;
};

export type GatewayConfirmationDecision = 'approved' | 'denied';

export type CharacterRuntimeState =
  'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

/** One committed visible message, as a client renders it. */
export type GatewayVisibleMessage = {
  readonly messageId: string;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
};

/** The gateway refused before any turn ran; nothing was recorded. */
export type GatewayRefusalReason =
  | 'unknown_character'
  | 'unknown_conversation'
  | 'sender_not_supported'
  | 'character_unavailable'
  | 'invalid_message';

export type TurnOutcome =
  | {
      readonly status: 'completed';
      readonly characterId: string;
      readonly conversationId: string;
      readonly messages: readonly GatewayVisibleMessage[];
    }
  | {
      readonly status: 'rejected';
      readonly characterId: string;
      readonly conversationId: string;
      readonly reason: LocalRuntimeUserMessageRejectionReason;
      readonly message: string;
    }
  | {
      readonly status: 'refused';
      readonly reason: GatewayRefusalReason;
      readonly message: string;
    }
  | {
      readonly status: 'failed';
      readonly characterId: string;
      readonly conversationId: string;
      readonly message: string;
    };

/**
 * An ordinary operational failure of the home's storage — a full disk, a
 * permission, a damaged record — reported to the person, never a bug.
 */
export type StorageFailure = {
  readonly status: 'failed';
  readonly code: LocalRuntimeStorageContractError['code'];
  readonly message: string;
};

export type OpenOutcome =
  | {
      readonly status: 'opened';
      readonly conversationId: string;
      readonly characterId: string;
      /** Who the caller is in this thread — the senderId a delivery must carry. */
      readonly userParticipantId: string;
    }
  | {
      readonly status: 'refused';
      readonly reason:
        'unknown_character' | 'character_unavailable' | 'conversation_busy';
      readonly message: string;
    }
  | StorageFailure;

/** `settled` says the start ran; the summary's state says how it ended. */
export type StartOutcome =
  | {readonly status: 'settled'; readonly character: CharacterSummary}
  | {
      readonly status: 'refused';
      readonly reason: 'unknown_character' | 'gateway_stopped';
      readonly message: string;
    };

/**
 * `expired`: the deadline had passed, so the broker settled the request as
 * cancelled instead — the client is never the judge of the deadline.
 */
export type ConfirmationAnswerStatus = 'answered' | 'expired' | 'unknown';

export type AnswerOutcome = {readonly status: ConfirmationAnswerStatus};

/** A parked tool confirmation, as the stream announced it and the list shows it. */
export type PendingConfirmation = {
  readonly characterId: string;
  /** Unique across the whole gateway; answerConfirmation routes by it alone. */
  readonly id: string;
  readonly request: RuntimePluginToolConfirmationRequest;
  readonly deadlineAt: number;
};

/**
 * A background problem the conversation never sees: a segment rotation that
 * failed (the plan is simply made again next turn) or a closed segment's
 * session-end hooks that did not finish. Health keeps the latest.
 */
export type MaintenanceFailure = {
  readonly at: string;
  readonly message: string;
};

export type GatewayEvent =
  | {
      readonly kind: 'turn_progress';
      readonly characterId: string;
      readonly conversationId: string;
      readonly progress: LocalRuntimeTurnProgressEvent;
    }
  | {
      readonly kind: 'turn_completed';
      readonly characterId: string;
      readonly conversationId: string;
      readonly status: TurnOutcome['status'];
      /** The terminal explanation every surface can show, not only the sender. */
      readonly reason?: string;
      readonly message?: string;
    }
  | ({readonly kind: 'confirmation_requested'} & PendingConfirmation)
  | {
      readonly kind: 'confirmation_settled';
      readonly characterId: string;
      readonly id: string;
      readonly decision: 'approved' | 'denied' | 'cancelled';
    }
  | {
      readonly kind: 'state_changed';
      readonly characterId: string;
      readonly state: CharacterRuntimeState;
      /** Present when a failure caused the change. */
      readonly message?: string;
    }
  | ({
      readonly kind: 'maintenance_failed';
      readonly characterId: string;
    } & MaintenanceFailure);

export type GatewayEventListener = (event: GatewayEvent) => void;

export type Unsubscribe = () => void;

export type CharacterRuntimeHealth = {
  readonly characterId: string;
  readonly state: CharacterRuntimeState;
  readonly openConversationIds: readonly string[];
  /** Why the runtime is failed, when it is. */
  readonly failure?: string;
  readonly maintenance?: MaintenanceFailure;
};

/** One installed character, as health reports it. */
export type CharacterSummary = {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly state: CharacterRuntimeState | 'not_started';
  /** Boot or activation problem, when one exists. */
  readonly diagnostic?: string;
  /** The latest background failure, when one has happened since boot. */
  readonly maintenance?: MaintenanceFailure;
};

/** The daemon's whole state in one read: the roster and what it could not load. */
export type GatewayHealth = {
  readonly protocolVersion: typeof gatewayProtocolVersion;
  readonly homeRoot: string;
  /** Problems loading the global config document. */
  readonly config: {readonly diagnostics: readonly RuntimeConfigDiagnostic[]};
  /** Installed packages discovery could not publish; they are not in the roster. */
  readonly packages: {
    readonly diagnostics: readonly CharacterPackageDiagnostic[];
  };
  readonly characters: readonly CharacterSummary[];
};

/**
 * One enabled character behind the gateway: its plugin host, model adapter,
 * open conversations, and FIFO turn queue. Constructed and held by the
 * registry; clients hold the Gateway façade and never this.
 */
export type CharacterRuntime = {
  readonly characterId: string;
  start(): Promise<void>;
  /** Waits for the in-flight turn, runs session end, releases everything. */
  stop(): Promise<void>;
  /** Fresh start after a fatal turn; the registry calls it once per failure. */
  reactivate(): Promise<void>;
  deliver(message: GatewayMessage): Promise<TurnOutcome>;
  pendingConfirmations(): readonly PendingConfirmation[];
  answerConfirmation(
    id: string,
    decision: GatewayConfirmationDecision,
  ): ConfirmationAnswerStatus;
  health(): CharacterRuntimeHealth;
  events(listener: GatewayEventListener): Unsubscribe;
};

/**
 * The one object a client holds. Every verb answers a client-reachable
 * condition with an outcome; a throw is a bug. The client verbs serialize
 * over HTTP unchanged; startCharacter and stop are lifecycle, owned by
 * whoever runs the process.
 */
export type Gateway = {
  health(): GatewayHealth;
  openDirectConversation(characterId: string): Promise<OpenOutcome>;
  deliver(message: GatewayMessage): Promise<TurnOutcome>;
  /** What is parked right now; a client that missed the event reads this. */
  pendingConfirmations(): readonly PendingConfirmation[];
  answerConfirmation(
    id: string,
    decision: GatewayConfirmationDecision,
  ): AnswerOutcome;
  events(listener: GatewayEventListener): Unsubscribe;
  startCharacter(characterId: string): Promise<StartOutcome>;
  stop(): Promise<void>;
};
