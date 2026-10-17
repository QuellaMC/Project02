import {listProject02Characters, type Project02Home} from '../app/index.ts';
import {
  builtInConnectors,
  type RuntimeConfigSectionDeclaration,
  type RuntimeConfigValue,
} from '../runtime/config/index.ts';
import {
  isJsonBoundaryObject,
  ownJsonRecordValue,
} from '../shared/json-boundary.ts';
import type {
  ConnectorConfigEntry,
  ConnectorConfigView,
} from './api/contract.ts';
import {resolveScope, sectionViewOf, type ScopeResolution} from './config.ts';
import type {AllowlistReading} from './pairing.ts';

/**
 * What a connector runs on, for the home and for each installed character
 * that is switched on, each entry resolved as its settings screen is and
 * carrying every declared field that resolves for its target, the home's
 * own fields included, so a character's bot reads the home's allowlist
 * whatever the home's switch says. Its secrets go out in the clear, as no
 * other read's do, because a connector is the owner's own program, running
 * under the home's bearer token on loopback, and a token is what it exists
 * to use.
 */
export function readConnectorConfig(
  home: Project02Home,
  connectorId: string,
): ConnectorConfigView {
  const declaration = builtInConnectors.find(
    connector => connector.id === connectorId,
  );

  if (declaration === undefined) {
    return refusedRead(
      'unknown_connector',
      `Unknown connector "${connectorId}". Connectors: ` +
        `${builtInConnectors.map(connector => connector.id).join(', ')}.`,
    );
  }

  const homeScope = resolveScope(home, {scope: 'global'});

  if ('status' in homeScope) {
    return refusedRead('config_unloadable', homeScope.message);
  }

  return Object.freeze({
    status: 'ok' as const,
    connectorId,
    home: entryOf(homeScope, declaration),
    characters: Object.freeze(
      listProject02Characters(home)
        .characters.filter(character => character.enabled)
        .flatMap(character => {
          const scope = resolveScope(home, {
            scope: 'character',
            characterId: character.id,
          });

          // One whose own document does not load cannot boot either, and
          // health already says why.
          return 'status' in scope
            ? []
            : [
                Object.freeze({
                  characterId: character.id,
                  ...entryOf(scope, declaration),
                }),
              ];
        }),
    ),
  });
}

function entryOf(
  scope: ScopeResolution,
  declaration: RuntimeConfigSectionDeclaration,
): ConnectorConfigEntry {
  const section = sectionViewOf(scope, 'connectors', declaration);
  const resolved = ownJsonRecordValue(
    scope.sectionResolution.sectionConfigs.connectors,
    declaration.id,
  );

  return Object.freeze({
    activation: section.activation,
    values: Object.freeze(
      Object.fromEntries(
        section.activation.status === 'active'
          ? declaration.config.fields.flatMap(
              ({name}): [string, RuntimeConfigValue][] => {
                const field = ownJsonRecordValue(resolved, name);

                return field?.resolved === true && field.value !== undefined
                  ? [[name, field.value]]
                  : [];
              },
            )
          : [],
      ),
    ),
  });
}

/** A connector's allowlist field as the home's document holds it; anything but an object holds no one. */
export function readConnectorAllowlist(
  home: Project02Home,
  connectorId: string,
  field: string,
): AllowlistReading {
  const scope = resolveScope(home, {scope: 'global'});

  if ('status' in scope) {
    return Object.freeze({status: 'refused' as const, message: scope.message});
  }

  const value = ownJsonRecordValue(
    ownJsonRecordValue(
      scope.sectionResolution.sectionConfigs.connectors,
      connectorId,
    ),
    field,
  )?.value;

  return Object.freeze({
    status: 'ok' as const,
    fingerprint: scope.fingerprint,
    accounts: value !== undefined && isJsonBoundaryObject(value) ? value : {},
  });
}

type RefusedRead = Extract<ConnectorConfigView, {status: 'refused'}>;

function refusedRead(
  reason: RefusedRead['reason'],
  message: string,
): RefusedRead {
  return Object.freeze({status: 'refused' as const, reason, message});
}
