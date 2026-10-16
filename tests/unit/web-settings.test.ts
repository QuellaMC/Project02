import {describe, expect, it} from 'vitest';

import {
  changeEnded,
  changeSent,
  configViewRead,
  fieldEdited,
  hostFieldKey,
  operationFor,
  readableName,
  rowAt,
  sectionFieldKey,
  sectionKey,
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
  RuntimeConfigFieldInspectShape,
} from '../../src/gateway/api/index.ts';

const home: ConfigTarget = {scope: 'global'};
const mira: ConfigTarget = {scope: 'character', characterId: 'mira'};

function field(
  name: string,
  shape: Partial<RuntimeConfigFieldInspectShape> = {},
): RuntimeConfigFieldInspectShape {
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

/** A field whose manifest declares no valueType. */
function untyped(
  shape: RuntimeConfigFieldInspectShape,
): RuntimeConfigFieldInspectShape {
  const {valueType, ...rest} = shape;

  void valueType;

  return rest;
}

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
    sections: [
      {
        namespace: 'plugins',
        id: 'demo-config',
        displayName: 'Demo Config',
        version: '1.0.0',
        enabled: true,
        enabledSource: 'global',
        activation: {enabled: true, status: 'active', reasons: []},
        fields: [
          field('tone', {allowedValues: ['neutral', 'warm']}),
          untyped(field('apiKey', {secret: true})),
          field('settings', {valueType: 'object'}),
          field('endpoints', {valueType: 'array'}),
          untyped(field('mode', {allowedValues: ['true', 'off']})),
          untyped(
            field('note', {
              effective: {
                name: 'note',
                secret: false,
                source: 'config',
                resolved: true,
                value: 'true',
              },
            }),
          ),
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
    protocolVersion: 6,
    health: {
      protocolVersion: 6,
      homeRoot: '/home/person/.project02',
      config: {diagnostics: []},
      packages: {diagnostics: []},
      characters: [
        {id: 'mira', displayName: 'Mira', enabled: true, state: 'ready'},
      ],
    },
    confirmations: [],
    turns: [],
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

const tone = sectionFieldKey('plugins', 'demo-config', 'tone');
const secret = sectionFieldKey('plugins', 'demo-config', 'apiKey');

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

    state = changeEnded(changeSent(state, 1, tone), 1, {
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
    const sent = changeSent(state, 1, secret);

    expect(sent.settings?.saving).toEqual({ticket: 1, key: secret});
    expect(sent.settings?.edits.has(secret)).toBe(false);
    expect(sent.settings?.edits.get(tone)).toBe('warm');
    expect(changeSent(state, 1, tone).settings?.saving).toEqual({
      ticket: 1,
      key: tone,
      text: 'warm',
    });
  });

  it('keeps a newer word typed while the save was on its way, and knows a change by its ticket: a screen opened since, or a later change, is not answered by it', () => {
    const sent = changeSent(
      fieldEdited(configViewRead(opened(), mira, view()), tone, 'warm'),
      1,
      tone,
    );
    const retyped = fieldEdited(sent, tone, 'neutral');
    const landed = changeEnded(retyped, 1, {
      status: 'applied',
      fingerprint: 'f2',
    });

    expect(landed.settings?.edits.get(tone)).toBe('neutral');
    expect(landed.settings?.saved).toBeUndefined();
    expect(landed.settings?.saving).toBeUndefined();
    // The answer's fingerprint is the view's at once: a save made before
    // the re-read lands does not conflict with this one.
    expect(
      landed.settings?.view?.status === 'ok' &&
        landed.settings.view.fingerprint,
    ).toBe('f2');

    // Left for the home and came back: a fresh screen, waiting on nothing.
    const back = settingsOpened(settingsOpened(sent, home), mira);

    expect(changeEnded(back, 1, {status: 'applied', fingerprint: 'f2'})).toBe(
      back,
    );

    // A later change on the same row: the first one's end is not its end.
    const again = changeSent(fieldEdited(back, tone, 'playful'), 2, tone);

    expect(changeEnded(again, 1, {status: 'applied', fingerprint: 'f2'})).toBe(
      again,
    );
    expect(
      changeEnded(again, 2, {status: 'applied', fingerprint: 'f3'}).settings
        ?.saved,
    ).toBe(tone);
  });

  it('lets a flip of a switch go when it did not land, so the switch shows what the daemon has', () => {
    const enabled = hostFieldKey('enabled');
    const flipped = changeSent(
      fieldEdited(configViewRead(opened(), mira, view()), enabled, 'false'),
      1,
      enabled,
    );

    expect(flipped.settings?.edits.get(enabled)).toBe('false');

    const conflicted = changeEnded(flipped, 1, {
      status: 'refused',
      reason: 'conflict',
      message: 'moved',
    });

    expect(conflicted.settings?.edits.has(enabled)).toBe(false);

    const invalid = changeEnded(flipped, 1, {
      status: 'refused',
      reason: 'invalid',
      message: 'no',
    });

    expect(invalid.settings?.edits.has(enabled)).toBe(false);
    expect(invalid.settings?.problems.get(enabled)).toBe('no');
  });

  it('keeps what is typed when the screen already open is opened again', () => {
    const typed = fieldEdited(
      configViewRead(opened(), mira, view()),
      tone,
      'warm',
    );

    expect(settingsOpened(typed, mira)).toBe(typed);
    expect(settingsOpened(typed, home).settings?.edits.size).toBe(0);
  });

  it('ends a change by its outcome: applied clears the row, invalid stays at it, conflict and failure are said, a gone character closes the screen', () => {
    const typed = changeSent(
      fieldEdited(configViewRead(opened(), mira, view()), tone, 'warm'),
      1,
      tone,
    );

    const applied = changeEnded(typed, 1, {
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

    const invalid = changeEnded(typed, 1, {
      status: 'refused',
      reason: 'invalid',
      message: 'Plugin config field "tone" must be one of: neutral, warm.',
    });

    expect(invalid.settings?.problems.get(tone)).toContain('must be one of');
    expect(invalid.settings?.edits.get(tone)).toBe('warm');
    expect(invalid.notices).toEqual([]);

    const conflict = changeEnded(typed, 1, {
      status: 'refused',
      reason: 'conflict',
      message: 'Runtime config changed before the mutation could be committed.',
    });

    expect(conflict.notices).toEqual([
      'Someone else saved first. This is what is there now; make your change again.',
    ]);
    expect(conflict.settings?.edits.get(tone)).toBe('warm');

    const failed = changeEnded(typed, 1, {
      status: 'failed',
      message: 'Could not write runtime config file.',
    });

    expect(failed.notices).toEqual(['Could not write runtime config file.']);

    const gone = changeEnded(typed, 1, {
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
        {kind: 'set', path: 'project02.userDisplayName', value: '  Sam '},
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
      // A secret of no declared kind is still a credential, not a number.
      [
        secret,
        '123',
        {
          kind: 'section_field_set',
          namespace: 'plugins',
          id: 'demo-config',
          field: 'apiKey',
          value: '123',
        },
      ],
      [
        tone,
        'warm',
        {
          kind: 'section_field_set',
          namespace: 'plugins',
          id: 'demo-config',
          field: 'tone',
          value: 'warm',
        },
      ],
      [
        tone,
        undefined,
        {
          kind: 'section_field_unset',
          namespace: 'plugins',
          id: 'demo-config',
          field: 'tone',
        },
      ],
      [
        sectionFieldKey('plugins', 'demo-config', 'settings'),
        '{"from": "page"}',
        {
          kind: 'section_field_set',
          namespace: 'plugins',
          id: 'demo-config',
          field: 'settings',
          value: {from: 'page'},
        },
      ],
      [
        sectionFieldKey('plugins', 'demo-config', 'endpoints'),
        'not json',
        {
          kind: 'section_field_set',
          namespace: 'plugins',
          id: 'demo-config',
          field: 'endpoints',
          value: 'not json',
        },
      ],
      [
        sectionKey('plugins', 'demo-config'),
        'true',
        {
          kind: 'section_enabled',
          namespace: 'plugins',
          id: 'demo-config',
          enabled: true,
        },
      ],
      [
        sectionKey('plugins', 'demo-config'),
        undefined,
        {kind: 'section_enabled', namespace: 'plugins', id: 'demo-config'},
      ],
      ['plugins/nobody/tone', 'warm', undefined],
      [
        sectionFieldKey('plugins', 'demo-config', 'mode'),
        'true',
        {
          kind: 'section_field_set',
          namespace: 'plugins',
          id: 'demo-config',
          field: 'mode',
          value: 'true',
        },
      ],
    ];

    for (const [key, text, operation] of cases) {
      expect(operationFor(current, key, text), key).toEqual(operation);
    }

    expect(rowAt(current, sectionKey('plugins', 'demo-config'))).toEqual({
      kind: 'section_enabled',
      namespace: 'plugins',
      id: 'demo-config',
    });
    // Two rows never share a key, whatever the names: a slash is in no id.
    expect(sectionKey('plugins', 'a.b')).not.toBe(
      sectionFieldKey('plugins', 'a', 'b'),
    );
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

  it('reads a field name as words, and shows a value so that it saves back as it was', () => {
    const current = view();
    const typed = (name: string) =>
      current.sections[0]?.fields.find(field => field.name === name);
    const note = typed('note');
    const tone = typed('tone');
    const settings = typed('settings');

    if (note === undefined || tone === undefined || settings === undefined) {
      throw new Error('Expected the demo fields.');
    }

    expect(readableName('userDisplayName')).toBe('User display name');
    expect(readableName('nvidiaApiKey')).toBe('Nvidia api key');
    expect(readableName('tone')).toBe('Tone');
    expect(valueText(tone, undefined)).toBe('');
    expect(valueText(tone, 'warm')).toBe('warm');
    expect(valueText(settings, {from: 'home'})).toBe('{"from":"home"}');
    expect(valueText(field('tokens', {valueType: 'number'}), 4096)).toBe(
      '4096',
    );
    // A field of no declared kind shows a string with its quotes, so the
    // text shown is the text that saves it back as a string.
    expect(valueText(note, 'true')).toBe('"true"');
    expect(
      operationFor(
        current,
        sectionFieldKey('plugins', 'demo-config', 'note'),
        valueText(note, 'true'),
      ),
    ).toMatchObject({value: 'true'});
  });
});
