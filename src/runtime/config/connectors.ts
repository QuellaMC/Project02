import type {RuntimeConfigFieldDeclaration} from '../../plugins/api/index.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {runtimeConfigSectionPath} from './path.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigDiagnostic,
  RuntimeConfigSectionDeclaration,
  RuntimeConfigSections,
} from './types.ts';

/**
 * A connector's settings, and the field pairing writes an approved account
 * into; a connector without one does not pair.
 */
export type ConnectorDeclaration = RuntimeConfigSectionDeclaration & {
  readonly pairing?: {readonly field: string};
};

const telegramConnector: ConnectorDeclaration = Object.freeze({
  id: 'telegram',
  displayName: 'Telegram',
  version: '1.0.0',
  config: Object.freeze({
    scope: 'global_with_character_overrides',
    fields: Object.freeze([
      Object.freeze({
        name: 'botToken',
        description:
          "This character's bot, as @BotFather gave it. The character " +
          'answers in Telegram as that bot.',
        scope: 'character_only',
        required: false,
        secret: true,
        valueType: 'secret',
        agentMutable: false,
        reloadRequired: false,
        redactionLabels: Object.freeze(['secret']),
      } satisfies RuntimeConfigFieldDeclaration),
      Object.freeze({
        name: 'managementBotToken',
        description:
          'Optional. A bot for the home itself: who is on, what is waiting ' +
          'for your approval, pairing.',
        scope: 'global_only',
        required: false,
        secret: true,
        valueType: 'secret',
        agentMutable: false,
        reloadRequired: false,
        redactionLabels: Object.freeze(['secret']),
      } satisfies RuntimeConfigFieldDeclaration),
      Object.freeze({
        name: 'mirror',
        description:
          'Show in this chat what you and the character said on other ' +
          'surfaces, like the web page.',
        required: false,
        secret: false,
        valueType: 'boolean',
        defaultValue: true,
        agentMutable: false,
        reloadRequired: false,
        redactionLabels: Object.freeze([]),
      } satisfies RuntimeConfigFieldDeclaration),
      Object.freeze({
        name: 'pairedUsers',
        description:
          'Accounts allowed to talk to your characters, each id with a ' +
          'name. Pairing adds one; remove a line to unpair it.',
        required: false,
        secret: false,
        valueType: 'object',
        defaultValue: Object.freeze({}),
        agentMutable: false,
        reloadRequired: false,
        redactionLabels: Object.freeze([]),
      } satisfies RuntimeConfigFieldDeclaration),
    ]),
  }),
  activation: Object.freeze({
    defaultEnabled: true,
    reasons: Object.freeze(['built_in_connector']),
  }),
  pairing: Object.freeze({field: 'pairedUsers'}),
});

/** Every connector this version has: a connector is built in, never discovered. */
export const builtInConnectors: readonly ConnectorDeclaration[] = Object.freeze(
  [telegramConnector],
);

/** The sections a daemon resolves: the plugins it discovered, and the connectors it has. */
export function createRuntimeConfigSections(
  discovered: Pick<RuntimeConfigSections, 'plugins'>,
): RuntimeConfigSections {
  return Object.freeze({
    plugins: discovered.plugins,
    connectors: builtInConnectors,
  });
}

/**
 * The catalog is complete, so a stanza it lacks names a connector this
 * version does not have; it is reported with its path and never resolved.
 */
export function unknownConnectorDiagnostics(
  config: Pick<Project02RuntimeConfig, 'connectors'>,
): readonly RuntimeConfigDiagnostic[] {
  return Object.keys(config.connectors ?? {})
    .filter(id => !builtInConnectors.some(connector => connector.id === id))
    .map(id =>
      createRuntimeConfigDiagnostic(
        'warning',
        'runtime_config_unknown_connector',
        `Runtime config references unknown connector "${id}".`,
        runtimeConfigSectionPath('connectors', id),
        {namespace: 'connectors', id},
      ),
    );
}
