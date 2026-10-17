import type {CharacterPackageDiagnostic} from '../../characters/index.ts';
import type {RuntimePluginToolConfirmationRequest} from '../../plugins/index.ts';
import type {
  RuntimeConfigDiagnostic,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionActivationShape,
  RuntimeConfigSectionInspectShape,
  RuntimeConfigSectionNamespace,
  RuntimeConfigValue,
} from '../../runtime/config/index.ts';
import type {
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageRejectionReason,
} from '../../runtime/index.ts';
import type {LocalRuntimeStorageContractError} from '../../runtime/storage/index.ts';

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

/** Why a parked confirmation ended without an answer. */
export type ConfirmationCancelReason = 'expired' | 'stopped';

/** How a confirmation ended: with an answer, or cancelled and why. */
export type ConfirmationSettlement =
  | {readonly decision: GatewayConfirmationDecision}
  | {readonly decision: 'cancelled'; readonly reason: ConfirmationCancelReason};

/**
 * `reloading` is a pause, not an outage: the character is assembling
 * afresh from the config on disk between turns, and a delivery sent
 * meanwhile waits for it and lands on the same conversation.
 */
export type CharacterRuntimeState =
  'starting' | 'ready' | 'reloading' | 'stopping' | 'stopped' | 'failed';

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
  /** The conversation's record could not be read; the message says why. */
  | 'conversation_unreadable'
  | 'conversation_busy'
  | 'sender_not_supported'
  | 'character_unavailable'
  | 'invalid_message'
  | 'duplicate_submission';

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
      /** Whether the line was committed before the turn ended; see `turnCommittedTheLine`. */
      readonly committed: boolean;
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
      /** Whether the line was committed before the turn ended; see `turnCommittedTheLine`. */
      readonly committed: boolean;
    };

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

export type HistoryPage = {
  /** A cursor the previous page returned; absent means the newest page. */
  readonly before?: string;
  /** 1 to 500, default 100. A string is fine, so a query needs no second parser. */
  readonly limit?: string | number;
};

export type HistoryMessage = {
  readonly messageId: string;
  readonly role: 'user' | 'character';
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
  readonly committedAt: string;
  readonly source?: string;
  readonly clientMessageId?: string;
};

/**
 * One page of the conversation, chronological within the page; pages are
 * read backward through `earlier`. The character's segments are the
 * daemon's business and never appear here.
 */
export type HistoryOutcome =
  | {
      readonly status: 'ok';
      readonly conversationId: string;
      readonly characterId: string;
      readonly messages: readonly HistoryMessage[];
      /** Present while older messages exist. */
      readonly earlier?: string;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'unknown_conversation' | 'invalid_page';
      readonly message: string;
    }
  | StorageFailure;

/** The one shape every transport refusal takes; a verb's outcome never uses it. */
export type GatewayErrorBody = {
  readonly error: {readonly code: string; readonly message: string};
};

/** What one reconcile pass set in motion; the outcomes arrive as states. */
export type ReconcilePlan = {
  readonly starting: readonly string[];
  readonly stopping: readonly string[];
  readonly reloading: readonly string[];
};

/** Which document a config verb reads or writes: the home's, or one character's. */
export type ConfigTarget =
  | {readonly scope: 'global'}
  | {readonly scope: 'character'; readonly characterId: string};

/**
 * What a settings page renders: the fingerprint a write must present, the
 * documents' diagnostics, and the host fields and every section the target
 * may set, in one field shape. An unauthored field carries its declared
 * default as its effective value, marked `default`, and reads `missing`
 * when it has none. A document that does not load is refused with the
 * reason, never rendered as blank fields.
 */
export type ConfigView =
  | {
      readonly status: 'ok';
      readonly fingerprint: string;
      readonly diagnostics: readonly RuntimeConfigDiagnostic[];
      readonly project02: readonly RuntimeConfigFieldInspectShape[];
      readonly sections: readonly RuntimeConfigSectionInspectShape[];
    }
  | {
      readonly status: 'refused';
      readonly reason: 'unknown_character' | 'config_unloadable';
      readonly message: string;
    };

/**
 * One change to one document, bound to the fingerprint the view handed
 * out: a concurrent edit is a conflict. The fingerprint hashes a secret's
 * presence, never its value, so two pages replacing the same secret at once
 * both succeed and the later value stands. A secret is sent as its value
 * and kept with the scope's config, redacted on every read but
 * `connectorConfig`.
 */
export type ConfigChange = {
  readonly target: ConfigTarget;
  readonly expectedFingerprint: string;
  readonly operation:
    | {
        readonly kind: 'set';
        readonly path: string;
        readonly value: RuntimeConfigValue;
      }
    | {readonly kind: 'unset'; readonly path: string}
    | {
        readonly kind: 'section_enabled';
        readonly namespace: RuntimeConfigSectionNamespace;
        readonly id: string;
        /** Absent clears this scope's value instead of deciding it. */
        readonly enabled?: boolean;
      }
    | {
        readonly kind: 'section_field_set';
        readonly namespace: RuntimeConfigSectionNamespace;
        readonly id: string;
        readonly field: string;
        readonly value: RuntimeConfigValue;
      }
    | {
        readonly kind: 'section_field_unset';
        readonly namespace: RuntimeConfigSectionNamespace;
        readonly id: string;
        readonly field: string;
      };
};

/**
 * `applied` means the bytes are on disk; what the change does to a
 * running character arrives as states, since a reload can wait on a turn.
 * `refused` is the change itself — moved fingerprint, unacceptable value,
 * unknown character; `failed` is a write that could not be made.
 */
export type ConfigChangeOutcome =
  | {readonly status: 'applied'; readonly fingerprint: string}
  | {
      readonly status: 'refused';
      readonly reason: 'conflict' | 'invalid' | 'unknown_character';
      readonly message: string;
    }
  | {readonly status: 'failed'; readonly message: string};

/**
 * What a connector runs on: an entry for the home, and one for each
 * installed character that is switched on, in roster order. Each entry
 * carries its section's own activation, as the settings page shows it. The
 * home's switch is a default, not a master switch, so a connector reads
 * each entry's own and never combines two. An id this version has no
 * connector for, or a home document that does not load, is refused with
 * the reason.
 */
export type ConnectorConfigView =
  | {
      readonly status: 'ok';
      readonly connectorId: string;
      readonly home: ConnectorConfigEntry;
      readonly characters: readonly (ConnectorConfigEntry & {
        readonly characterId: string;
      })[];
    }
  | {
      readonly status: 'refused';
      readonly reason: 'unknown_connector' | 'config_unloadable';
      readonly message: string;
    };

/**
 * `values` holds every declared field that resolves for the entry's target
 * with a present, valid value — the home's own fields reach every
 * character's entry — as authored or as its declared default, secrets in
 * the clear; a field that is missing, blank or of the wrong type is absent,
 * and nothing is there unless the entry is active.
 */
export type ConnectorConfigEntry = {
  readonly activation: RuntimeConfigSectionActivationShape;
  readonly values: Readonly<Record<string, RuntimeConfigValue>>;
};

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

/** The submission a turn ran for: enough for any surface to know whose it is. */
export type TurnIdentity = {
  readonly conversationId: string;
  readonly source: string;
  readonly clientMessageId: string;
};

/** A parked tool confirmation, as the stream announced it and the list shows it. */
export type PendingConfirmation = {
  readonly characterId: string;
  /** Unique across the whole gateway; answerConfirmation routes by it alone. */
  readonly id: string;
  readonly request: RuntimePluginToolConfirmationRequest;
  readonly deadlineAt: number;
  /**
   * The turn that raised it, so a surface can answer for its own turns
   * and leave the rest to the surface that sent them. Absent for a
   * request raised outside any turn.
   */
  readonly turn?: TurnIdentity;
};

/** The account a connector asks to let in: its own id for it, and the name the owner sees. */
export type PairingSubject = {
  readonly id: string;
  readonly label: string;
};

/**
 * An account waiting for the owner's answer, under a code any surface can
 * show and answer by, until `expiresAt` — then the daemon settles it as
 * expired.
 */
export type PairingRequest = {
  readonly connectorId: string;
  /** Six digits, unique among the requests waiting. */
  readonly code: string;
  readonly subject: PairingSubject;
  readonly requestedAt: string;
  readonly expiresAt: number;
};

/**
 * `paired`: the home already lets the account in, so nothing is asked. A
 * connector that does not pair, an account not named by one token and one
 * line, or a home document that does not load is refused with the reason.
 */
export type PairingRequestOutcome =
  | {readonly status: 'pending'; readonly request: PairingRequest}
  | {readonly status: 'paired'}
  | {
      readonly status: 'refused';
      readonly reason:
        'unknown_connector' | 'config_unloadable' | 'invalid_subject';
      readonly message: string;
    };

export type PairingDecision = 'approved' | 'denied';

/**
 * `expired`: the deadline had passed, so the daemon settled the request as
 * expired instead — as with a confirmation, the client is never the judge
 * of the deadline. `failed`: the approval could not be written, and the
 * request still waits.
 */
export type PairingSettleOutcome =
  | {readonly status: 'settled'; readonly decision: PairingDecision}
  | {readonly status: 'expired'}
  | {readonly status: 'unknown'}
  | {readonly status: 'failed'; readonly message: string};

/** One open draft of a running turn: the reply's text so far under that id. */
export type RunningDraft = {
  readonly draftId: string;
  readonly text: string;
};

/**
 * A turn in progress, as the stream has told it so far: the submission it
 * runs for, its character, and each open draft's text. What a surface that
 * had been listening all along would hold; `foldRunningTurns` is the one
 * way to build it.
 */
export type RunningTurn = TurnIdentity & {
  readonly characterId: string;
  readonly drafts: readonly RunningDraft[];
};

/**
 * The first frame on every event stream: the daemon's state at the moment
 * the stream started listening, so a client that connects — or comes back
 * — installs it and then reads events, with nothing to fetch and order.
 * The turns running carry their drafts, so a tab opened mid-reply shows
 * the reply as it is written.
 */
export type GatewayReady = {
  readonly protocolVersion: typeof gatewayProtocolVersion;
  readonly health: GatewayHealth;
  readonly confirmations: readonly PendingConfirmation[];
  readonly pairings: readonly PairingRequest[];
  readonly turns: readonly RunningTurn[];
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
      /**
       * A turn's progress: both committed roles once durable, and the
       * reply's draft ahead of its commit — `reply_delta` and
       * `reply_withdrawn`, said before the log and marked as such by kind.
       */
      readonly kind: 'turn_progress';
      readonly characterId: string;
      readonly conversationId: string;
      readonly progress: LocalRuntimeTurnProgressEvent;
    }
  | {
      readonly kind: 'turn_completed';
      readonly characterId: string;
      readonly conversationId: string;
      /** The submission's own stamps, so a surface knows whose turn ended. */
      readonly source: string;
      readonly clientMessageId: string;
      readonly status: TurnOutcome['status'];
      /** Whether the turn put the line in the log, for a surface still holding it. */
      readonly committed: boolean;
      /** The terminal explanation every surface can show, not only the sender. */
      readonly reason?: string;
      readonly message?: string;
    }
  | ({readonly kind: 'confirmation_requested'} & PendingConfirmation)
  | ({
      readonly kind: 'confirmation_settled';
      readonly characterId: string;
      readonly id: string;
    } & ConfirmationSettlement)
  | ({readonly kind: 'pairing_requested'} & PairingRequest)
  | {
      readonly kind: 'pairing_settled';
      readonly connectorId: string;
      readonly code: string;
      readonly subject: PairingSubject;
      /** The owner's answer, or `expired` when the deadline passed without one. */
      readonly decision: PairingDecision | 'expired';
    }
  | {
      readonly kind: 'state_changed';
      readonly characterId: string;
      readonly state: CharacterRuntimeState;
      /** Present when a failure caused the change. */
      readonly message?: string;
    }
  | {
      /**
       * The daemon's whole state read again the moment a config change
       * landed, before the pass that acts on it, or a connector's process
       * came onto the stream or left it: the roster as config now says it —
       * who is on, who is installed — the connectors on the stream, and the
       * config and package problems as they stand. What the pass does to
       * each character's state follows as `state_changed`.
       */
      readonly kind: 'health_changed';
      readonly health: GatewayHealth;
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

/** Whether a process of this connector is on the event stream right now; one entry per built-in connector. */
export type ConnectorPresence = {
  readonly id: string;
  readonly connected: boolean;
};

/**
 * The daemon's whole state in one read: the roster, the connectors on its
 * stream, and what it could not load.
 */
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
  readonly connectors: readonly ConnectorPresence[];
};

/**
 * One enabled character behind the gateway: its plugin host, model adapter,
 * open conversations, and FIFO turn queue. Constructed and held by the
 * registry behind the Gateway façade; nothing of it crosses the socket.
 */
export type CharacterRuntime = {
  readonly characterId: string;
  start(): Promise<void>;
  /** Waits for the in-flight turn, runs session end, releases everything. */
  stop(): Promise<void>;
  /** Fresh start after a fatal turn; the registry calls it once per failure. */
  reactivate(): Promise<void>;
  /** Assembles afresh from the config on disk, once accepted turns have run. */
  reload(): Promise<void>;
  /** Whether the character would assemble differently now than it did. */
  assemblyDrifted(): boolean;
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
 * The façade the daemon holds, and the whole of what its socket exposes.
 * Every verb answers a client-reachable condition with an outcome; a throw
 * is a bug. Every verb but reconcile, stop and connectorPresent serializes
 * over HTTP unchanged; those three are the daemon's own: its lifecycle, and
 * the presence a connector's event stream holds while it is open.
 */
export type Gateway = {
  health(): GatewayHealth;
  /** Reads the committed log, so an offline character's thread is readable too. */
  history(conversationId: string, page?: HistoryPage): Promise<HistoryOutcome>;
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
  configView(target: ConfigTarget): ConfigView;
  /** Writes through the one control transaction; reconcile applies it behind the answer. */
  applyConfigChange(change: ConfigChange): Promise<ConfigChangeOutcome>;
  /** A connector reads it again on every `ready` and every `health_changed`. */
  connectorConfig(connectorId: string): ConnectorConfigView;
  /**
   * Asks the owner to let in an account a connector does not know: the
   * request already waiting for it, or a new one under a fresh code.
   */
  requestPairing(
    connectorId: string,
    subject: PairingSubject,
  ): PairingRequestOutcome;
  /** What waits for the owner's answer right now. */
  pendingPairings(): readonly PairingRequest[];
  /** An approval writes the account into the connector's allowlist in the home's document. */
  settlePairing(
    code: string,
    decision: PairingDecision,
  ): Promise<PairingSettleOutcome>;
  /**
   * Counts a connector's process as on the stream: its event stream
   * registers here while it is open, and the release is what the stream's
   * end calls.
   */
  connectorPresent(connectorId: string): Unsubscribe;
  /** Makes the running set match the config: at boot, and after any change. */
  reconcile(): Promise<ReconcilePlan>;
  stop(): Promise<void>;
};
