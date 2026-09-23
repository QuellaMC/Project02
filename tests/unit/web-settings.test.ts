import {describe, expect, it} from 'vitest';

import {
  changeEnded,
  changeSent,
  configViewRead,
  fieldEdited,
  hostFieldKey,
  operationFor,
  pluginFieldKey,
  pluginKey,
  readableName,
  rowAt,
  settingsClosed,
  settingsOpened,
  setupNeeded,
  valueText,
} from '../../src/frontends/web/settings.ts';
import {
  initialState,
  installSnapshot,
  threadOpened,
  type WebState,
} from '../../src/frontends/web/store.ts';
import type {
  ConfigTarget,
  ConfigView,
  RuntimePluginConfigFieldInspectShape,
} from '../../src/gateway/api/index.ts';

const home: ConfigTarget = {scope: 'global'};
const mira: ConfigTarget = {scope: 'character', characterId: 'mira'};

function field(
  name: string,
  shape: Partial<RuntimePluginConfigFieldInspectShape> = {},
): RuntimePluginConfigFieldInspectShape {
  return {
    name,
    description: `${name}.`,
    required: false,
    secret: false,
    valueType: 'string',
    agentMutable: false,
    reloadRequired: true,
    authored: {configured: false},
    effectiveSource: 'default',
    effective: {name, secret: false, source: 'missing', resolved: true},
    ...shape,
  };
}

type OkView = Extract<ConfigView, {status: 'ok'}>;

/** Mira's view: the host fields, and demo-config with a secret and a structure. */
function view(fingerprint = 'f1'): OkView {
  return {
    status: 'ok',
    fingerprint,
    diagnostics: [],
    project02: [
      field('userDisplayName', {defaultValueSummary: 'You'}),
      field('roleModelProvider', {
        valueType: 'enum',
        allowedValues: ['local', 'nvidia'],
        defaultValueSummary: 'local',
      }),
      field('nvidiaApiKey', {secret: true, valueType: 'secret'}),
      field('contextWindowTokens', {valueType: 'number'}),
      field('enabled', {valueType: 'boolean', defaultValueSummary: 'true'}),
    ],
    plugins: [
      {
        pluginId: 'demo-config',
        displayName: 'Demo Config',
        version: '1.0.0',
        enabled: true,
        enabledSource: 'global',
        activation: {enabled: true, status: 'active', reasons: []},
        fields: [
          field('tone', {allowedValues: ['neutral', 'warm']}),
          field('apiKey', {secret: true}),
          field('settings', {valueType: 'object'}),
          field('endpoints', {valueType: 'array'}),
        ],
        diagnostics: [],
        fingerprint,
      },
    ],
  };
}

/** A live tab with Mira's thread open and her settings screen in front of it. */
function opened(target: ConfigTarget = mira): WebState {
  const live = installSnapshot(initialState, {
    protocolVersion: 4,
    health: {
      protocolVersion: 4,
      homeRoot: '/home/person/.project02',
      config: {diagnostics: []},
      packages: {diagnostics: []},
      characters: [
        {id: 'mira', displayName: 'Mira', enabled: true, state: 'ready'},
      ],
    },
    confirmations: [],
  });

  return settingsOpened(
    threadOpened(live, {
      status: 'opened',
      conversationId: 'conv-1',
      characterId: 'mira',
      userParticipantId: 'local-user',
    }),
    target,
  );
}

const tone = pluginFieldKey('demo-config', 'tone');
const secret = pluginFieldKey('demo-config', 'apiKey');

describe('web settings', () => {
  it('opens on a target with the thread kept behind it, and closes back to the chat letting edits go', () => {
    const state = fieldEdited(opened(), tone, 'warm');

    expect(state.settings).toMatchObject({target: mira, setup: false});
    expect(state.thread?.conversationId).toBe('conv-1');

    const closed = settingsClosed(state);

    expect(closed.settings).toBeUndefined();
    expect(closed.thread?.conversationId).toBe('conv-1');
    expect(settingsClosed(closed)).toBe(closed);
  });

  it('replaces the view and keeps what is typed and what was refused; a view for another target drops', () => {
    let state = fieldEdited(
      configViewRead(opened(), mira, view()),
      tone,
      'warm',
    );

    state = changeEnded(changeSent(state, tone), tone, {
      status: 'refused',
      reason: 'invalid',
      message: 'not warm enough',
    });

    const reread = configViewRead(state, mira, view('f2'));

    expect(
      reread.settings?.view?.status === 'ok' &&
        reread.settings.view.fingerprint,
    ).toBe('f2');
    expect(reread.settings?.edits.get(tone)).toBe('warm');
    expect(reread.settings?.problems.get(tone)).toBe('not warm enough');
    expect(configViewRead(reread, home, view('f3'))).toBe(reread);
  });

  it('marks a change on its way and drops a secret the moment it is sent', () => {
    const state = fieldEdited(
      fieldEdited(configViewRead(opened(), mira, view()), tone, 'warm'),
      secret,
      'sk-live',
    );
    const sent = changeSent(state, secret);

    expect(sent.settings?.saving).toBe(secret);
    expect(sent.settings?.edits.has(secret)).toBe(false);
    expect(sent.settings?.edits.get(tone)).toBe('warm');
    expect(changeSent(state, tone).settings?.edits.get(tone)).toBe('warm');
  });

  it('ends a change by its outcome: applied clears the row, invalid stays at it, conflict and failure are said, a gone character closes the screen', () => {
    const typed = changeSent(
      fieldEdited(configViewRead(opened(), mira, view()), tone, 'warm'),
      tone,
    );

    const applied = changeEnded(typed, tone, {
      status: 'applied',
      fingerprint: 'f2',
    });

    expect(applied.settings).toMatchObject({saved: tone});
    expect(applied.settings?.saving).toBeUndefined();
    expect(applied.settings?.edits.has(tone)).toBe(false);
    // The next edit is a new change, not the saved one.
    expect(
      fieldEdited(applied, tone, 'neutral').settings?.saved,
    ).toBeUndefined();

    const invalid = changeEnded(typed, tone, {
      status: 'refused',
      reason: 'invalid',
      message: 'Plugin config field "tone" must be one of: neutral, warm.',
    });

    expect(invalid.settings?.problems.get(tone)).toContain('must be one of');
    expect(invalid.settings?.edits.get(tone)).toBe('warm');
    expect(invalid.notices).toEqual([]);

    const conflict = changeEnded(typed, tone, {
      status: 'refused',
      reason: 'conflict',
      message: 'Runtime config changed before the mutation could be committed.',
    });

    expect(conflict.notices).toEqual([
      'Someone else saved first. This is what is there now; make your change again.',
    ]);
    expect(conflict.settings?.edits.get(tone)).toBe('warm');

    const failed = changeEnded(typed, tone, {
      status: 'failed',
      message: 'Could not write runtime config file.',
    });

    expect(failed.notices).toEqual(['Could not write runtime config file.']);

    const gone = changeEnded(typed, tone, {
      status: 'refused',
      reason: 'unknown_character',
      message: 'Character "mira" was not found.',
    });

    expect(gone.settings).toBeUndefined();
    expect(gone.notices).toEqual(['Character "mira" was not found.']);
  });

  it('builds one operation from the row it names, typed by the field, and a reset from no text', () => {
    const current = view();
    const cases: readonly [string, string | undefined, unknown][] = [
      [
        hostFieldKey('userDisplayName'),
        '  Sam ',
        {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'},
      ],
      [
        hostFieldKey('userDisplayName'),
        undefined,
        {kind: 'unset', path: 'project02.userDisplayName'},
      ],
      [
        hostFieldKey('contextWindowTokens'),
        '4096',
        {kind: 'set', path: 'project02.contextWindowTokens', value: 4096},
      ],
      [
        hostFieldKey('contextWindowTokens'),
        'lots',
        {kind: 'set', path: 'project02.contextWindowTokens', value: 'lots'},
      ],
      [
        hostFieldKey('enabled'),
        'false',
        {kind: 'set', path: 'project02.enabled', value: false},
      ],
      [
        hostFieldKey('nvidiaApiKey'),
        'nvapi-1',
        {kind: 'set', path: 'project02.nvidiaApiKey', value: 'nvapi-1'},
      ],
      [
        tone,
        'warm',
        {
          kind: 'plugin_field_set',
          pluginId: 'demo-config',
          field: 'tone',
          value: 'warm',
        },
      ],
      [
        tone,
        undefined,
        {kind: 'plugin_field_unset', pluginId: 'demo-config', field: 'tone'},
      ],
      [
        pluginFieldKey('demo-config', 'settings'),
        '{"from": "page"}',
        {
          kind: 'plugin_field_set',
          pluginId: 'demo-config',
          field: 'settings',
          value: {from: 'page'},
        },
      ],
      [
        pluginFieldKey('demo-config', 'endpoints'),
        'not json',
        {
          kind: 'plugin_field_set',
          pluginId: 'demo-config',
          field: 'endpoints',
          value: 'not json',
        },
      ],
      [
        pluginKey('demo-config'),
        'true',
        {kind: 'plugin_enabled', pluginId: 'demo-config', enabled: true},
      ],
      [
        pluginKey('demo-config'),
        undefined,
        {kind: 'plugin_enabled', pluginId: 'demo-config'},
      ],
      ['plugins.nobody.tone', 'warm', undefined],
    ];

    for (const [key, text, operation] of cases) {
      expect(operationFor(current, key, text), key).toEqual(operation);
    }

    expect(rowAt(current, pluginKey('demo-config'))).toEqual({
      kind: 'plugin_enabled',
      pluginId: 'demo-config',
    });
    expect(
      operationFor(
        {status: 'refused', reason: 'config_unloadable', message: 'no'},
        tone,
        'warm',
      ),
    ).toBeUndefined();
  });

  it('judges the first run by the home provider alone: unauthored and nothing in effect', () => {
    const fresh = view();

    expect(setupNeeded(fresh)).toBe(true);

    const chosen: OkView = {
      ...fresh,
      project02: fresh.project02.map(host =>
        host.name === 'roleModelProvider'
          ? {
              ...host,
              authored: {configured: true, value: 'local'},
              effectiveSource: 'global',
              effective: {...host.effective, source: 'config', value: 'local'},
            }
          : host,
      ),
    };

    expect(setupNeeded(chosen)).toBe(false);
    expect(
      setupNeeded({
        status: 'refused',
        reason: 'config_unloadable',
        message: 'no',
      }),
    ).toBe(false);
  });

  it('reads a field name as words and a value as a box shows it', () => {
    expect(readableName('userDisplayName')).toBe('User display name');
    expect(readableName('nvidiaApiKey')).toBe('Nvidia api key');
    expect(readableName('tone')).toBe('Tone');
    expect(valueText(undefined)).toBe('');
    expect(valueText('warm')).toBe('warm');
    expect(valueText({from: 'home'})).toBe('{"from":"home"}');
    expect(valueText(4096)).toBe('4096');
  });
});
