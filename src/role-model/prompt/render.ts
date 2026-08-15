import type {VisibleMessage} from '../../core/index.ts';
import type {
  RuntimePluginContextBudget,
  RuntimePluginContextItem,
  RuntimePluginCuratedContextSection,
  RuntimePluginSourceReference,
} from '../../plugins/api/index.ts';
import {runtimePluginListToolName} from '../../plugins/api/index.ts';
import type {RoleModelInputEnvelope} from '../api/contracts.ts';
import {visibleReplyModelToolName} from '../api/model-tools.ts';
import {
  freezeRoleModelChatMessage,
  type RoleModelAssistantChatMessage,
  type RoleModelChatCompletionTool,
  type RoleModelChatMessage,
  type RoleModelProviderCapabilities,
  type RoleModelSystemChatMessage,
  type RoleModelUserChatMessage,
} from '../api/chat-wire.ts';
import {
  curatedContextHeader,
  recalledMemoryFenceTag,
  recalledMemoryPreamble,
  runtimeContextHeader,
  systemProtocolTail,
  toolProtocolText,
  untrustedPluginContextFenceTag,
  untrustedPluginContextPreamble,
} from './prompt-text.ts';
import {modelToolDefinitionToChatTool} from './tool-wire.ts';

type RoleModelPromptFrameKind =
  | 'system_protocol'
  | 'developer_protocol'
  | 'curated_context'
  | 'model_only_runtime_context'
  | 'visible_transcript'
  | 'current_user_message'
  | 'recalled_memory'
  | 'untrusted_plugin_context'
  | 'native_assistant_message'
  | 'native_tool_result_message';

type RoleModelPromptSuffixFrameKind = Extract<
  RoleModelPromptFrameKind,
  'recalled_memory' | 'untrusted_plugin_context'
>;

/**
 * A frame either travels as its own wire message or rides the current user
 * message as a fenced suffix; suffix frames carry no message of their own,
 * so the unmerged sequence cannot reach a provider by accident.
 */
type RoleModelPromptFrame =
  | {
      readonly placement: 'own_message';
      readonly kind: Exclude<
        RoleModelPromptFrameKind,
        RoleModelPromptSuffixFrameKind
      >;
      readonly role: RoleModelChatMessage['role'];
      readonly content: string | null;
      readonly modelOnly: boolean;
      readonly message: RoleModelChatMessage;
    }
  | {
      readonly placement: 'current_user_message_suffix';
      readonly kind: RoleModelPromptSuffixFrameKind;
      readonly role: 'user';
      readonly content: string;
      readonly modelOnly: true;
    };

type RoleModelPromptFragmentSlot =
  | 'developer_context'
  | 'curated_context'
  | 'recalled_memory'
  | 'untrusted_context';

type RoleModelPromptFragmentKind =
  'runtime_note' | 'curated_context_section' | 'plugin_context_item';

type RoleModelPromptFragment = {
  readonly id: string;
  readonly pluginId?: string;
  readonly kind: RoleModelPromptFragmentKind;
  readonly slot: RoleModelPromptFragmentSlot;
  readonly text: string;
  readonly budget?: RuntimePluginContextBudget;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
  readonly redactionLabels: readonly string[];
};

export type RoleModelTurnContext = {
  readonly frames: readonly RoleModelPromptFrame[];
  readonly promptFragments: readonly RoleModelPromptFragment[];
  readonly messages: readonly RoleModelChatMessage[];
  readonly tools: readonly RoleModelChatCompletionTool[];
};

type RenderRoleModelTurnContextOptions = {
  readonly additionalMessages?: readonly RoleModelChatMessage[];
  readonly capabilities?: RoleModelProviderCapabilities;
  readonly personaSections?: readonly string[];
  readonly userDisplayName?: string;
};

type Addressee = {
  readonly userDisplayName?: string;
};

export const defaultRoleModelProviderCapabilities = Object.freeze({
  supportsNativeTools: true,
  supportsDeveloperOrSystemContext: true,
  preferredModelContextRole: 'system',
  supportsStrictToolSchema: true,
  supportsReasoning: false,
  reasoningParameterStyle: 'none',
  requiresReasoningBlockRoundTrip: false,
  supportsToolChoice: true,
  supportsParallelToolCalls: true,
} satisfies RoleModelProviderCapabilities);

const promptFenceTags = Object.freeze([
  recalledMemoryFenceTag,
  untrustedPluginContextFenceTag,
]);

export function renderRoleModelTurnContext(
  inputEnvelope: RoleModelInputEnvelope,
  options: RenderRoleModelTurnContextOptions = {},
): RoleModelTurnContext {
  const capabilities =
    options.capabilities ?? defaultRoleModelProviderCapabilities;
  const promptFragments = createRoleModelPromptFragments(inputEnvelope);
  const frames = createRoleModelPromptFrames(inputEnvelope, {
    additionalMessages: options.additionalMessages ?? [],
    capabilities,
    promptFragments,
    ...(options.personaSections === undefined
      ? {}
      : {personaSections: options.personaSections}),
    ...(options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName}),
  });

  return Object.freeze({
    frames,
    promptFragments,
    messages: wireMessagesForPromptFrames(frames),
    tools: Object.freeze(
      inputEnvelope.toolDefinitions.map(definition =>
        modelToolDefinitionToChatTool(definition, {
          strict: capabilities.supportsStrictToolSchema,
        }),
      ),
    ),
  } satisfies RoleModelTurnContext);
}

function createRoleModelPromptFrames(
  inputEnvelope: RoleModelInputEnvelope,
  options: {
    readonly additionalMessages: readonly RoleModelChatMessage[];
    readonly capabilities: RoleModelProviderCapabilities;
    readonly promptFragments: readonly RoleModelPromptFragment[];
    readonly personaSections?: readonly string[];
    readonly userDisplayName?: string;
  },
): readonly RoleModelPromptFrame[] {
  const addressee: Addressee =
    options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName};
  const modelOnlyRole = modelOnlyContextRole(options.capabilities);
  const frames: RoleModelPromptFrame[] = [
    ownFrame(
      'system_protocol',
      createSystemMessage(inputEnvelope, options.personaSections, addressee),
      true,
    ),
    ownFrame(
      'developer_protocol',
      Object.freeze({
        role: modelOnlyRole,
        content: toolProtocolText({
          ...addressee,
          ...(inputEnvelope.toolDefinitions.some(
            definition => definition.name === runtimePluginListToolName,
          )
            ? {inventoryToolName: runtimePluginListToolName}
            : {}),
          visibleReplyAvailable: inputEnvelope.allowedTools.includes(
            visibleReplyModelToolName,
          ),
          supportsParallelToolCalls:
            options.capabilities.supportsParallelToolCalls,
        }),
      }),
      true,
    ),
  ];

  // Before the runtime-context frame: runtime notes change per turn, while
  // the curated snapshot stays byte-stable, keeping the prompt prefix
  // cacheable across turns.
  const curatedContent = renderCuratedContext(
    options.promptFragments,
    addressee,
  );
  if (curatedContent !== undefined) {
    frames.push(
      ownFrame(
        'curated_context',
        Object.freeze({role: modelOnlyRole, content: curatedContent}),
        true,
      ),
    );
  }

  const runtimeContent = renderRuntimeContext(
    options.promptFragments,
    addressee,
  );
  if (runtimeContent !== undefined) {
    frames.push(
      ownFrame(
        'model_only_runtime_context',
        Object.freeze({role: modelOnlyRole, content: runtimeContent}),
        true,
      ),
    );
  }

  frames.push(
    ...inputEnvelope.decisionContext.recentVisibleMessages.map(message =>
      ownFrame(
        'visible_transcript',
        visibleMessageToChatMessage(message),
        false,
      ),
    ),
    ownFrame(
      'current_user_message',
      Object.freeze({
        role: 'user',
        content: inputEnvelope.event.payload.currentUserMessage,
      } satisfies RoleModelUserChatMessage),
      false,
    ),
  );

  const recalledMemory = renderRecalledMemory(
    options.promptFragments,
    addressee,
  );
  if (recalledMemory !== undefined) {
    frames.push(suffixFrame('recalled_memory', recalledMemory));
  }

  const untrustedContext = renderUntrustedPluginContext(
    options.promptFragments,
    addressee,
  );
  if (untrustedContext !== undefined) {
    frames.push(suffixFrame('untrusted_plugin_context', untrustedContext));
  }

  frames.push(
    ...options.additionalMessages.map(message =>
      ownFrame(
        message.role === 'tool'
          ? 'native_tool_result_message'
          : 'native_assistant_message',
        freezeRoleModelChatMessage(message),
        true,
      ),
    ),
  );

  return Object.freeze(frames);
}

function ownFrame(
  kind: Exclude<RoleModelPromptFrameKind, RoleModelPromptSuffixFrameKind>,
  message: RoleModelChatMessage,
  modelOnly: boolean,
): RoleModelPromptFrame {
  return Object.freeze({
    placement: 'own_message',
    kind,
    role: message.role,
    content: message.content,
    modelOnly,
    message,
  });
}

function suffixFrame(
  kind: RoleModelPromptSuffixFrameKind,
  content: string,
): RoleModelPromptFrame {
  return Object.freeze({
    placement: 'current_user_message_suffix',
    kind,
    role: 'user',
    content,
    modelOnly: true,
  });
}

/** Suffix frames ride the current user message; every other frame is one message. */
function wireMessagesForPromptFrames(
  frames: readonly RoleModelPromptFrame[],
): readonly RoleModelChatMessage[] {
  const messages: RoleModelChatMessage[] = [];

  for (const frame of frames) {
    if (frame.placement === 'own_message') {
      messages.push(frame.message);
      continue;
    }

    const current = messages.pop();

    if (current?.role !== 'user' || typeof current.content !== 'string') {
      throw new TypeError(
        `Prompt frame ${frame.kind} must follow the current user message.`,
      );
    }

    messages.push(
      Object.freeze({
        role: 'user',
        content: `${current.content}\n\n${frame.content}`,
      } satisfies RoleModelUserChatMessage),
    );
  }

  return Object.freeze(messages);
}

function createSystemMessage(
  inputEnvelope: RoleModelInputEnvelope,
  personaSections: readonly string[] | undefined,
  addressee: Addressee,
): RoleModelSystemChatMessage {
  const characterName =
    inputEnvelope.decisionContext.characterSnapshot.displayName;
  // Runtime-owned protocol text always follows; packages cannot override it.
  const personaText =
    personaSections === undefined || personaSections.length === 0
      ? `You are ${characterName}.`
      : personaSections.join('\n\n');

  return Object.freeze({
    role: 'system',
    content: `${personaText}\n\n${systemProtocolTail({...addressee, characterName})}`,
  } satisfies RoleModelSystemChatMessage);
}

function visibleMessageToChatMessage(
  message: VisibleMessage,
): RoleModelUserChatMessage | RoleModelAssistantChatMessage {
  if (message.role === 'user') {
    return Object.freeze({
      role: 'user',
      content: message.text,
    } satisfies RoleModelUserChatMessage);
  }

  return Object.freeze({
    role: 'assistant',
    content: message.text,
  } satisfies RoleModelAssistantChatMessage);
}

const curatedContextSectionMarker = '--';

function renderCuratedContext(
  promptFragments: readonly RoleModelPromptFragment[],
  addressee: Addressee,
): string | undefined {
  const sections = promptFragments.filter(
    fragment => fragment.kind === 'curated_context_section',
  );

  if (sections.length === 0) {
    return undefined;
  }

  return [
    curatedContextHeader(addressee),
    ...sections.map(fragment => fragment.text),
  ].join('\n');
}

function renderCuratedContextSectionBlock(
  section: RuntimePluginCuratedContextSection,
): string {
  const usedChars = section.usedChars ?? section.text.length;
  const capacity =
    section.capChars === undefined
      ? ''
      : ` [${String(Math.round((usedChars / section.capChars) * 100))}% - ${String(
          usedChars,
        )}/${String(section.capChars)} chars]`;
  const body = section.text
    .split('\n')
    .map(line =>
      line.startsWith(curatedContextSectionMarker) ? ` ${line}` : line,
    )
    .join('\n');

  return `${curatedContextSectionMarker} ${section.title}${capacity} ${curatedContextSectionMarker}\n${body}`;
}

function renderRuntimeContext(
  promptFragments: readonly RoleModelPromptFragment[],
  addressee: Addressee,
): string | undefined {
  const notes = promptFragments.filter(
    fragment => fragment.kind === 'runtime_note',
  );

  if (notes.length === 0) {
    return undefined;
  }

  return [
    runtimeContextHeader(addressee),
    ...bulletLines(notes.map(fragment => fragment.text)),
  ].join('\n');
}

function renderRecalledMemory(
  promptFragments: readonly RoleModelPromptFragment[],
  addressee: Addressee,
): string | undefined {
  const memories = promptFragments.filter(
    fragment => fragment.slot === 'recalled_memory',
  );

  if (memories.length === 0) {
    return undefined;
  }

  return fenced(recalledMemoryFenceTag, [
    recalledMemoryPreamble(addressee),
    ...bulletLines(memories.map(fragment => fragment.text)),
  ]);
}

function renderUntrustedPluginContext(
  promptFragments: readonly RoleModelPromptFragment[],
  addressee: Addressee,
): string | undefined {
  const items = promptFragments.filter(
    fragment => fragment.slot === 'untrusted_context',
  );

  if (items.length === 0) {
    return undefined;
  }

  // Plugin data keeps its own shape: indentation and blank lines may be
  // meaning (code, YAML, a table), so only the outer whitespace goes.
  return fenced(untrustedPluginContextFenceTag, [
    untrustedPluginContextPreamble(addressee),
    ...items.flatMap(item => [
      `## ${item.pluginId ?? 'plugin'} · ${item.id}`,
      item.text.trim(),
    ]),
  ]);
}

function fenced(tag: string, lines: readonly string[]): string {
  return [`<${tag}>`, ...lines, `</${tag}>`].join('\n');
}

function modelOnlyContextRole(
  capabilities: RoleModelProviderCapabilities,
): 'developer' | 'system' {
  return capabilities.supportsDeveloperOrSystemContext &&
    capabilities.preferredModelContextRole === 'developer'
    ? 'developer'
    : 'system';
}

function createRoleModelPromptFragments(
  inputEnvelope: RoleModelInputEnvelope,
): readonly RoleModelPromptFragment[] {
  return Object.freeze([
    ...inputEnvelope.decisionContext.runtimeNotes.map(note =>
      Object.freeze({
        id: `runtime-note-${note.pluginId ?? 'runtime'}-${note.id}`,
        ...(note.pluginId === undefined ? {} : {pluginId: note.pluginId}),
        kind: 'runtime_note',
        slot: 'developer_context',
        text: neutralizePromptFenceTags(note.text),
        sourceReferences: Object.freeze([]),
        redactionLabels: Object.freeze([]),
      } satisfies RoleModelPromptFragment),
    ),
    ...inputEnvelope.decisionContext.curatedContextSections.map(section =>
      Object.freeze({
        id: `curated-context-${section.pluginId}-${section.id}`,
        pluginId: section.pluginId,
        kind: 'curated_context_section',
        slot: 'curated_context',
        text: renderCuratedContextSectionBlock(section),
        sourceReferences: Object.freeze([]),
        redactionLabels: Object.freeze([]),
      } satisfies RoleModelPromptFragment),
    ),
    ...inputEnvelope.decisionContext.pluginContextItems.map(item =>
      Object.freeze({
        id: item.id,
        pluginId: item.pluginId,
        kind: 'plugin_context_item',
        slot: pluginContextItemSlot(item),
        text: neutralizePromptFenceTags(item.text),
        budget: item.budget,
        sourceReferences: Object.freeze([...item.sourceReferences]),
        redactionLabels: Object.freeze([...item.redactionLabels]),
      } satisfies RoleModelPromptFragment),
    ),
  ]);
}

function pluginContextItemSlot(
  item: RuntimePluginContextItem,
): RoleModelPromptFragmentSlot {
  return item.kind === 'memory' ? 'recalled_memory' : 'untrusted_context';
}

/**
 * Text inside a fenced block can never open or close a fence: an
 * underscore-tagged lookalike stays data.
 */
function neutralizePromptFenceTags(text: string): string {
  return promptFenceTags.reduce((value, tag) => {
    const lookalike = tag.replaceAll('_', '-');

    return value
      .replaceAll(new RegExp(`<\\s*${tag}\\b`, 'giu'), `<${lookalike}`)
      .replaceAll(
        new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'giu'),
        `</${lookalike}>`,
      );
  }, text);
}

/**
 * One bullet per value; a value's own lines follow indented, blank ones
 * included, so a note or memory keeps whatever shape it was written in.
 */
function bulletLines(values: readonly string[]): readonly string[] {
  return Object.freeze(
    values.flatMap(value => {
      const [firstLine, ...remainingLines] = value.trim().split(/\r?\n/u);

      if (firstLine === undefined || firstLine.length === 0) {
        return [];
      }

      return [
        `- ${firstLine}`,
        ...remainingLines.map(line => (line.length === 0 ? '' : `  ${line}`)),
      ];
    }),
  );
}
