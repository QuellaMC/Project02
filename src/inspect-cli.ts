import { pathToFileURL } from 'node:url';

import {
  createFileRuntimeLogStore,
  createLocalRuntimeSessionStore,
  createLocalRuntimeStorageLayout,
  isTerminalRawEventLogRecord,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId,
  type ConversationLogRecord,
  type LocalRuntimeSessionMetadata,
  type RawEventLogRecord,
  type RoleModelCommitValidationResult,
  type RoleModelDecisionResult,
  type RuntimeTraceEntry,
  type RuntimeTurnStatus
} from './index.ts';
import {
  formatLocalRuntimeTerminalError,
  isLocalRuntimeTerminalError
} from './terminal-errors.ts';

type InspectCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
};

type InspectCliArgs =
  | {
      readonly mode: 'sessions';
      readonly storeRoot?: string;
    }
  | {
      readonly mode: 'session';
      readonly storeRoot?: string;
      readonly sessionId: string;
    };

type InspectSessionListOutput = {
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
};

type InspectSessionOutput = {
  readonly session: LocalRuntimeSessionMetadata;
  readonly counts: {
    readonly traceEntries: number;
    readonly rawEvents: number;
    readonly conversationMessages: number;
  };
  readonly turns: readonly InspectTurnEvidence[];
};

type InspectTurnEvidence = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly string[];
  readonly visibleMessages: readonly InspectVisibleMessage[];
  readonly roleModelEvidence?: InspectRoleModelEvidence;
  readonly reason?: string;
};

type InspectVisibleMessage = {
  readonly id: string;
  readonly role: ConversationLogRecord['role'];
  readonly speakerName: string;
  readonly text: string;
};

type InspectRoleModelEvidence = {
  readonly input?: {
    readonly sessionId: string;
    readonly allowedActions: readonly string[];
    readonly outputContractVersion: string;
    readonly currentUserMessage: string;
    readonly recentVisibleMessages: readonly InspectVisibleMessage[];
    readonly runtimeNotes: readonly string[];
  };
  readonly output?: {
    readonly rawOutputText: string;
  };
  readonly parsedDecision?: InspectParsedRoleModelDecision;
  readonly commitValidation?: InspectRoleModelCommitValidation;
};

type InspectParsedRoleModelDecision =
  | {
      readonly status: 'accepted';
      readonly action: {
        readonly type: 'visible_reply';
        readonly text: string;
      };
    }
  | {
      readonly status: 'rejected';
      readonly rejectionReason: string;
      readonly rejectionDetails?: string;
    };

type InspectRoleModelCommitValidation =
  | {
      readonly status: 'accepted';
      readonly acceptedVisibleReplyText: string;
    }
  | {
      readonly status: 'rejected';
      readonly rejectionReason: string;
      readonly rejectionDetails?: string;
    };

class InspectCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectCliUsageError';
  }
}

export async function runInspectCliFromArgs(
  args: readonly string[],
  options: InspectCliOptions
): Promise<number> {
  try {
    const parsedArgs = parseInspectCliArgs(args);

    validateInspectCliArgs(parsedArgs);

    if (parsedArgs.mode === 'sessions') {
      await writeSessionList(parsedArgs, options.stdout);
      return 0;
    }

    await writeSessionEvidence(parsedArgs, options.stdout);
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof InspectCliUsageError ||
      isLocalRuntimeTerminalError(error)
    ) {
      options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }
}

function parseInspectCliArgs(args: readonly string[]): InspectCliArgs {
  let storeRoot: string | undefined;
  let sessionsMode = false;
  let sessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      continue;
    }

    if (arg === '--store') {
      if (storeRoot !== undefined) {
        throw new InspectCliUsageError('--store can only be provided once.');
      }

      storeRoot = readFlagValue(args, index, '--store');
      index += 1;
      continue;
    }

    if (arg === '--sessions') {
      if (sessionsMode) {
        throw new InspectCliUsageError('--sessions can only be provided once.');
      }

      sessionsMode = true;
      continue;
    }

    if (arg === '--session') {
      if (sessionId !== undefined) {
        throw new InspectCliUsageError('--session can only be provided once.');
      }

      sessionId = readFlagValue(args, index, '--session');
      index += 1;
      continue;
    }

    throw new InspectCliUsageError(`Unknown inspect option: ${arg}.`);
  }

  if (sessionsMode && sessionId !== undefined) {
    throw new InspectCliUsageError('Use either --sessions or --session, not both.');
  }

  if (sessionsMode) {
    return {
      mode: 'sessions',
      ...(storeRoot === undefined ? {} : { storeRoot })
    } satisfies InspectCliArgs;
  }

  if (sessionId === undefined) {
    throw new InspectCliUsageError('Use --sessions or --session <session-id>.');
  }

  return {
    mode: 'session',
    sessionId,
    ...(storeRoot === undefined ? {} : { storeRoot })
  } satisfies InspectCliArgs;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new InspectCliUsageError(`${flag} requires a value.`);
  }

  return value;
}

function validateInspectCliArgs(args: InspectCliArgs): void {
  if (args.storeRoot !== undefined) {
    createLocalRuntimeStorageLayout({ storeRoot: args.storeRoot });
  }

  if (args.mode === 'session') {
    normalizeLocalRuntimeSessionId(args.sessionId);
  }
}

async function writeSessionList(
  args: InspectCliArgs & { readonly mode: 'sessions' },
  stdout: NodeJS.WritableStream
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore(storageOptions(args));
  const sessions = await sessionStore.listSessions();

  writeJson(stdout, {
    sessions
  } satisfies InspectSessionListOutput);
}

async function writeSessionEvidence(
  args: InspectCliArgs & { readonly mode: 'session' },
  stdout: NodeJS.WritableStream
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore(storageOptions(args));
  const session = await sessionStore.readSession(args.sessionId);
  const logStore = createFileRuntimeLogStore({
    ...storageOptions(args),
    sessionId: session.sessionId
  });
  const traceEntries = logStore.traceEntries();
  const rawEvents = logStore.rawEvents();
  const conversationMessages = logStore.conversationMessages();

  writeJson(stdout, {
    session,
    counts: {
      traceEntries: traceEntries.length,
      rawEvents: rawEvents.length,
      conversationMessages: conversationMessages.length
    },
    turns: createTurnEvidence({
      conversationMessages,
      rawEvents,
      traceEntries
    })
  } satisfies InspectSessionOutput);
}

function createTurnEvidence(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): readonly InspectTurnEvidence[] {
  return Object.freeze(
    options.rawEvents
      .filter(isTerminalTurnRawEvent)
      .map((rawEvent) =>
        createTurnEvidenceEntry({
          conversationMessages: options.conversationMessages,
          rawEvent,
          traceEntries: options.traceEntries
        })
      )
  );
}

function createTurnEvidenceEntry(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvent: RawEventLogRecord;
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): InspectTurnEvidence {
  const visibleMessageIds = options.rawEvent.visibleMessageIds ?? [];

  return Object.freeze({
    eventId: options.rawEvent.eventId,
    traceId: options.rawEvent.traceId,
    status: terminalTurnStatus(options.rawEvent),
    steps: Object.freeze(
      options.traceEntries
        .filter(
          (entry) =>
            entry.eventId === options.rawEvent.eventId &&
            entry.traceId === options.rawEvent.traceId
        )
        .map((entry) => entry.step)
    ),
    visibleMessages: Object.freeze(
      visibleMessageIds.flatMap((messageId) =>
        visibleMessagesForId(options.conversationMessages, messageId)
      )
    ),
    ...roleModelEvidenceForRawEvent(options.rawEvent),
    ...(options.rawEvent.reason === undefined
      ? {}
      : { reason: options.rawEvent.reason })
  } satisfies InspectTurnEvidence);
}

function roleModelEvidenceForRawEvent(
  rawEvent: RawEventLogRecord
): { readonly roleModelEvidence?: InspectRoleModelEvidence } {
  if (
    rawEvent.roleModelIOSnapshot === undefined &&
    rawEvent.parsedRoleModelDecisionSnapshot === undefined &&
    rawEvent.commitValidation === undefined
  ) {
    return {};
  }

  const inputEnvelope = rawEvent.roleModelIOSnapshot?.inputEnvelope;
  const parsedDecision = rawEvent.parsedRoleModelDecisionSnapshot?.result;
  const commitValidation = rawEvent.commitValidation?.result;

  return {
    roleModelEvidence: Object.freeze({
      ...(inputEnvelope === undefined
        ? {}
        : {
            input: Object.freeze({
              sessionId: inputEnvelope.decisionContext.sessionId,
              allowedActions: Object.freeze([...inputEnvelope.allowedActions]),
              outputContractVersion: inputEnvelope.outputContract.version,
              currentUserMessage:
                inputEnvelope.event.payload.currentUserMessage,
              recentVisibleMessages: Object.freeze(
                inputEnvelope.decisionContext.recentVisibleMessages.map(
                  visibleMessageFromSnapshot
                )
              ),
              runtimeNotes: Object.freeze([
                ...inputEnvelope.decisionContext.runtimeNotes
              ])
            })
          }),
      ...(rawEvent.roleModelIOSnapshot === undefined
        ? {}
        : {
            output: Object.freeze({
              rawOutputText: rawEvent.roleModelIOSnapshot.rawOutputText
            })
          }),
      ...(parsedDecision === undefined
        ? {}
        : { parsedDecision: parsedRoleModelDecision(parsedDecision) }),
      ...(commitValidation === undefined
        ? {}
        : {
            commitValidation:
              roleModelCommitValidation(commitValidation)
          })
    } satisfies InspectRoleModelEvidence)
  };
}

function parsedRoleModelDecision(
  result: RoleModelDecisionResult
): InspectParsedRoleModelDecision {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      action: Object.freeze({
        type: result.decision.action.type,
        text: result.decision.action.text
      })
    } satisfies InspectParsedRoleModelDecision);
  }

  return Object.freeze({
    status: 'rejected',
    rejectionReason: result.rejection.reason,
    ...(result.rejection.details === undefined
      ? {}
      : { rejectionDetails: result.rejection.details })
  } satisfies InspectParsedRoleModelDecision);
}

function roleModelCommitValidation(
  result: RoleModelCommitValidationResult
): InspectRoleModelCommitValidation {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      acceptedVisibleReplyText: result.acceptedVisibleReplyText
    } satisfies InspectRoleModelCommitValidation);
  }

  return Object.freeze({
    status: 'rejected',
    rejectionReason: result.rejection.reason,
    ...(result.rejection.details === undefined
      ? {}
      : { rejectionDetails: result.rejection.details })
  } satisfies InspectRoleModelCommitValidation);
}

function isTerminalTurnRawEvent(record: RawEventLogRecord): boolean {
  return isTerminalRawEventLogRecord(record);
}

function terminalTurnStatus(record: RawEventLogRecord): RuntimeTurnStatus {
  if (record.status !== undefined) {
    return record.status;
  }

  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Stored terminal raw event is missing a turn status.'
  );
}

function visibleMessagesForId(
  conversationMessages: readonly ConversationLogRecord[],
  messageId: string
): readonly InspectVisibleMessage[] {
  const message = conversationMessages.find((candidate) => candidate.id === messageId);

  if (message === undefined) {
    return [];
  }

  return [
    Object.freeze({
      id: message.id,
      role: message.role,
      speakerName: message.speakerName,
      text: message.text
    } satisfies InspectVisibleMessage)
  ];
}

function visibleMessageFromSnapshot(message: {
  readonly id: string;
  readonly role: ConversationLogRecord['role'];
  readonly speakerName: string;
  readonly text: string;
}): InspectVisibleMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    speakerName: message.speakerName,
    text: message.text
  } satisfies InspectVisibleMessage);
}

function storageOptions(args: { readonly storeRoot?: string }): { readonly storeRoot?: string } {
  return args.storeRoot === undefined ? {} : { storeRoot: args.storeRoot };
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatTerminalErrorMessage(
  error: InspectCliUsageError | Parameters<typeof formatLocalRuntimeTerminalError>[0]
): string {
  if (error instanceof InspectCliUsageError) {
    return error.message;
  }

  return formatLocalRuntimeTerminalError(error);
}

function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return pathToFileURL(scriptPath).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runInspectCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });
}
