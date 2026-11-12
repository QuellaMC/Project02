import {describe, expect, it} from 'vitest';

import type {
  JsonValue,
  PairingRequest,
  PendingConfirmation,
  RuntimeConfigFieldInspectShape,
} from '@project02/wire/contract';
import {
  confirmationWords,
  installAskOf,
  pairingWords,
  settingAskOf,
  timeLeft,
} from './ask-words.ts';
import type {OkView} from './settings.ts';

const reminders = {
  id: 'reminders',
  name: 'Reminders',
  summary: 'Things to do, on a day and time',
  icon: 'list',
  tint: 'orange',
  version: '1.1.0',
  wakes: true,
};

/** Her ask, as the confirmation that asks the person carries it, with `shape` made to it. */
function pending(
  preview: Readonly<Record<string, JsonValue>>,
  shape: Partial<PendingConfirmation> = {},
): PendingConfirmation {
  return {
    characterId: 'mira',
    id: 'c1',
    request: {
      pluginId: 'phone',
      toolName: 'phone.install',
      summary: 'Install "reminders" 1.1.0 from the App Store.',
      preview,
    },
    deadlineAt: 0,
    ...shape,
  };
}

/** The preview of her ask to install Reminders, as her phone prepares it, with `changes` made to it. */
function install(
  changes: Readonly<Record<string, JsonValue>> = {},
): Readonly<Record<string, JsonValue>> {
  return {
    kind: 'phone_app_install',
    app: reminders,
    source: 'catalog',
    ...changes,
  };
}

/** The preview of her ask to change her reply style's `fieldName`, from what her settings hold to what she asks for. */
function change(
  fieldName: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> {
  const held = (value: JsonValue | undefined) =>
    value === undefined ? {configured: false} : {configured: true, value};

  return {
    kind: 'runtime_plugin_config_change',
    targetPluginId: 'reply-style',
    fieldName,
    operation: after === undefined ? 'unset' : 'set',
    expectedFingerprint: 'f1',
    before: held(before),
    after: held(after),
  };
}

function field(
  name: string,
  shape: Partial<RuntimeConfigFieldInspectShape>,
): RuntimeConfigFieldInspectShape {
  return {
    name,
    description: `${name}.`,
    secret: false,
    valueType: 'string',
    agentMutable: true,
    authored: {configured: false},
    effectiveSource: 'default',
    effective: {name, secret: false, source: 'missing', resolved: true},
    ...shape,
  };
}

/** Her settings as her settings page reads them: her reply style, its tone a choice and its sign-off her own words. */
const hers: OkView = {
  status: 'ok',
  fingerprint: 'f1',
  diagnostics: [],
  model: {ready: true},
  project02: [],
  sections: [
    {
      namespace: 'plugins',
      id: 'reply-style',
      displayName: 'Reply Style',
      version: '1.0.0',
      page: {
        summary: 'How she writes',
        icon: 'bubble',
        tint: 'mint',
        placement: 'mind_body',
        order: 5,
      },
      enabled: true,
      enabledSource: 'default',
      activation: {enabled: true, status: 'active', reasons: []},
      setup: {ready: true},
      fields: [
        field('tone', {
          label: 'Tone',
          allowedValues: ['neutral', 'warm', 'playful'],
          choices: {neutral: 'Neutral', warm: 'Warm', playful: 'Playful'},
        }),
        field('signoff', {label: 'Sign-Off'}),
      ],
      layout: [],
      diagnostics: [],
    },
  ],
};

const alex: PairingRequest = {
  connectorId: 'telegram',
  code: '482913',
  subject: {id: '381940562', label: 'Alex'},
  source: 'telegram:mira_bot',
  requestedAt: '2026-11-12T09:00:00.000Z',
  expiresAt: 0,
};

describe('what the card that asks says', () => {
  it("her ask to install an app: on the app's own tile, who asks, from the App Store, and whether it can wake her; to update one, the version it replaces, and that what it kept stays; and where it was asked when that was not a page", () => {
    expect(confirmationWords(pending(install()), 'Mira')).toEqual({
      tile: {icon: 'list', tint: 'orange'},
      asker: {id: 'mira', name: 'Mira'},
      title: 'Mira wants to install Reminders',
      sentence:
        'From the App Store. It keeps its own data and can wake her up.',
    });
    expect(
      confirmationWords(
        pending(install({app: {...reminders, wakes: false}})),
        'Mira',
      ).sentence,
    ).toBe('From the App Store. It keeps its own data.');
    expect(
      confirmationWords(
        pending(install({replaces: '1.0.0'}), {
          turn: {
            conversationId: 'dm',
            source: 'telegram:mira_bot',
            clientMessageId: '1.2.3',
          },
        }),
        'Mira',
      ),
    ).toMatchObject({
      title: 'Mira wants to update Reminders',
      sentence:
        'From the App Store. Version 1.1.0 replaces 1.0.0, and what it kept stays.',
      where: 'In Telegram',
    });
    expect(
      confirmationWords(
        pending(install(), {
          turn: {conversationId: 'dm', source: 'web', clientMessageId: 'l1'},
        }),
        'Mira',
      ).where,
    ).toBeUndefined();
  });

  it("her ask to change one of her settings: on the tile of the feature it belongs to, by the feature's name and in the words her settings page shows for the field and each value, not set for none; until her settings are read, in the preview's own", () => {
    const said = (preview: Readonly<Record<string, JsonValue>>) =>
      confirmationWords(pending(preview), 'Mira', hers);

    expect(said(change('tone', undefined, 'warm'))).toMatchObject({
      tile: {icon: 'bubble', tint: 'mint'},
      asker: {id: 'mira', name: 'Mira'},
      title: 'Mira wants to change her Reply Style',
      sentence: 'Tone: not set → Warm.',
    });
    expect(said(change('tone', 'playful', 'warm')).sentence).toBe(
      'Tone: Playful → Warm.',
    );
    expect(said(change('tone', 'warm', undefined)).sentence).toBe(
      'Tone: Warm → not set.',
    );
    expect(said(change('signoff', undefined, 'Love, Mira.')).sentence).toBe(
      'Sign-Off: not set → Love, Mira.',
    );
    expect(
      confirmationWords(pending(change('tone', 'playful', 'warm')), 'Mira'),
    ).toMatchObject({
      tile: {icon: 'grid', tint: 'gray'},
      title: 'Mira wants to change her reply-style',
      sentence: 'tone: playful → warm.',
    });
  });

  it('someone new on a connector: on its tile, who wants to pair on which, where they wrote and the code, and no picture, since nobody of the home asks', () => {
    expect(pairingWords(alex)).toEqual({
      tile: {icon: 'plane', tint: 'blue'},
      title: 'Alex wants to pair on Telegram',
      sentence: 'Wrote to @mira_bot. Code 482913.',
    });
  });

  it('a preview the page cannot read: on a plain tile, the tool she wants to use, what it says it does, and what it would do behind Details', () => {
    const preview = {fieldName: 'tone', value: 'warm'};

    expect(
      confirmationWords(
        pending(preview, {
          request: {
            pluginId: 'runtime.plugin',
            toolName: 'runtime.plugin.config.update',
            summary: 'Change a setting of a plugin.',
            preview,
          },
        }),
        'Mira',
      ),
    ).toEqual({
      tile: {icon: 'grid', tint: 'gray'},
      asker: {id: 'mira', name: 'Mira'},
      title: 'Mira wants to use runtime.plugin.config.update',
      sentence: 'Change a setting of a plugin.',
      details: JSON.stringify(preview, null, 2),
    });
  });

  it('reads no ask of an app or of a setting from the preview of anything else, of an app from anywhere but the App Store, or of either it cannot read', () => {
    for (const unread of [
      {fieldName: 'tone', value: 'warm'},
      install({source: 'file'}),
      install({app: 'reminders'}),
      install({app: {id: 'reminders', name: 'Reminders'}}),
      install({replaces: 1}),
    ]) {
      expect(installAskOf(unread)).toBeUndefined();
    }

    for (const unread of [
      install(),
      {...change('tone', undefined, 'warm'), fieldName: 1},
      {...change('tone', undefined, 'warm'), after: {configured: true}},
      {...change('tone', undefined, 'warm'), before: 'warm'},
    ]) {
      expect(settingAskOf(unread)).toBeUndefined();
    }
  });
});

describe('the time an ask has left', () => {
  it('counts minutes and seconds, and hours too past an hour; a second begun is a second left, and once the time is up it reads 0:00', () => {
    const second = 1000;
    const now = 1_000_000;

    expect(timeLeft(now + 5 * 60 * second, now)).toBe('5:00');
    expect(timeLeft(now + 292 * second, now)).toBe('4:52');
    expect(timeLeft(now + 299.4 * second, now)).toBe('5:00');
    expect(timeLeft(now + 58 * 60 * second + 12 * second, now)).toBe('58:12');
    expect(timeLeft(now + 3723 * second, now)).toBe('1:02:03');
    expect(timeLeft(now + 400, now)).toBe('0:01');
    expect(timeLeft(now, now)).toBe('0:00');
    expect(timeLeft(now - second, now)).toBe('0:00');
  });
});
