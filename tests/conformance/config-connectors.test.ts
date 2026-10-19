import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {changeConfig, saveConfig, wireOf} from './harness/wire.ts';

type Section = {
  readonly namespace: string;
  readonly id: string;
};

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
const mira = {scope: 'character', characterId: 'mira'} as const;

function telegramOf(view: unknown): Section | undefined {
  return (view as {readonly sections: readonly Section[]}).sections.find(
    section => section.namespace === 'connectors' && section.id === 'telegram',
  );
}

function overlayPath(home: string, characterId: string): string {
  return join(home, 'character-data', characterId, 'config.json');
}

function telegram(field: string, value: unknown): object {
  return {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field,
    value,
  };
}

it("config.connector-section-view: the home's view and a character's show the Telegram section on by default, its tokens only as [redacted], mirror and pairedUsers at their defaults, and the allowlist only on the home's screen", async () => {
  const home = createHome({
    'config.json': configJson({
      connectors: {telegram: {config: {managementBotToken: '123456:home'}}},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: '987654:mira'}}},
        }),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const homeView = await wire.configView({scope: 'global'});
  const miraView = await wire.configView(mira);
  const onByDefault = {
    enabled: true,
    enabledSource: 'default',
    activation: {status: 'active'},
  };

  expect(telegramOf(homeView)).toMatchObject({
    ...onByDefault,
    fields: [
      {
        name: 'managementBotToken',
        authored: {configured: true, value: '[redacted]'},
      },
      {name: 'mirror', effective: {source: 'default', value: true}},
      {name: 'pairedUsers', effective: {source: 'default', value: {}}},
    ],
  });
  expect(telegramOf(miraView)).toMatchObject({
    ...onByDefault,
    fields: [
      {name: 'botToken', authored: {configured: true, value: '[redacted]'}},
      {name: 'mirror', effective: {source: 'default', value: true}},
    ],
  });
  expect(JSON.stringify([homeView, miraView])).not.toMatch(
    /123456:home|987654:mira/u,
  );
});

it('config.connector-change-no-reload: a connector setting is saved into the document of the screen it was saved on and reloads no character, the stream saying only health_changed, and a write to a connector this version lacks is refused invalid', async () => {
  const home = createHome();
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');

  const events = await openEvents(daemon);

  await saveConfig(wire, {scope: 'global'}, telegram('mirror', false));
  await saveConfig(wire, mira, telegram('botToken', '987654:mira'));
  expect(
    JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')),
  ).toMatchObject({connectors: {telegram: {config: {mirror: false}}}});
  expect(
    JSON.parse(readFileSync(overlayPath(home, 'mira'), 'utf8')),
  ).toMatchObject({
    connectors: {telegram: {config: {botToken: '987654:mira'}}},
  });
  expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain(
    '987654:mira',
  );

  expect(
    await changeConfig(
      wire,
      {scope: 'global'},
      {
        kind: 'section_field_set',
        namespace: 'connectors',
        id: 'discord',
        field: 'botToken',
        value: '555555:discord',
      },
    ),
  ).toMatchObject({status: 'refused', reason: 'invalid'});
  // Passes never overlap: a reload either connector save began would be
  // on the stream before the one this change causes.
  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.contextWindowTokens',
    value: 4096,
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  expect(
    events.frames
      .filter(frame => frame.event !== undefined)
      .map(frame => frame.event),
  ).toEqual([
    'ready',
    'health_changed',
    'health_changed',
    'health_changed',
    'state_changed',
    'state_changed',
  ]);
});

it('config.connector-section-error-isolated: a connector value of the wrong type written by hand blocks the connector alone, runtime_config_value_type_invalid at its path, and leaves the characters and the plugins as they were', async () => {
  const home = createHome({
    'config.json': configJson({
      connectors: {telegram: {config: {mirror: 'yes'}}},
    }),
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const blocked = {
    activation: {status: 'blocked'},
    diagnostics: [
      {
        code: 'runtime_config_value_type_invalid',
        path: 'connectors.telegram.config.mirror',
      },
    ],
  };

  expect(await wire.start('mira')).toMatchObject({
    character: {state: 'ready'},
  });

  for (const target of [{scope: 'global'}, mira] as const) {
    const view = (await wire.configView(target)) as {
      readonly sections: readonly (Section & {
        readonly activation: {readonly status: string};
      })[];
    };

    expect(telegramOf(view), target.scope).toMatchObject(blocked);
    expect(
      view.sections
        .filter(section => section.activation.status === 'blocked')
        .map(section => `${section.namespace}.${section.id}`),
      target.scope,
    ).toEqual(['connectors.telegram']);
  }

  const withoutValues = {
    activation: expect.objectContaining({status: 'blocked'}) as unknown,
    values: {},
  };

  expect(await wire.connectorConfig('telegram')).toEqual({
    status: 'ok',
    connectorId: 'telegram',
    home: withoutValues,
    characters: [{characterId: 'mira', ...withoutValues}],
  });
});

it("config.connector-config-read: a connector's read hands the home's entry and one for each character switched on, secrets in the clear, each with her own values over the home's, never a botToken from the home's document, each entry by its own switch, and none with values while off", async () => {
  const character = (id: string) => ({
    'project02.character.json': characterJson(id, id),
  });
  const home = createHome({
    'config.json': configJson({
      connectors: {
        telegram: {
          enabled: false,
          config: {
            managementBotToken: '123456:home',
            mirror: false,
            botToken: '111111:home',
          },
        },
      },
    }),
    characters: {
      nova: character('nova'),
      vega: character('vega'),
      zeta: character('zeta'),
    },
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {
            telegram: {
              enabled: true,
              config: {botToken: '987654:mira', mirror: true},
            },
          },
        }),
      },
      nova: {
        'config.json': configJson({connectors: {telegram: {enabled: true}}}),
      },
      zeta: {'config.json': configJson({project02: {enabled: false}})},
    },
  });
  const wire = wireOf(await startDaemon(home));
  const active = expect.objectContaining({status: 'active'}) as unknown;
  const disabled = expect.objectContaining({status: 'disabled'}) as unknown;

  expect(await wire.connectorConfig('telegram')).toEqual({
    status: 'ok',
    connectorId: 'telegram',
    home: {activation: disabled, values: {}},
    characters: [
      {
        characterId: 'mira',
        activation: active,
        values: {
          botToken: '987654:mira',
          managementBotToken: '123456:home',
          mirror: true,
          pairedUsers: {},
        },
      },
      {
        characterId: 'nova',
        activation: active,
        values: {
          managementBotToken: '123456:home',
          mirror: false,
          pairedUsers: {},
        },
      },
      {characterId: 'vega', activation: disabled, values: {}},
    ],
  });
});

it("config.connector-config-refusals: a connector's read is refused unknown_connector for a connector this version lacks, and config_unloadable while the home's document cannot be loaded", async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));

  expect(await wire.connectorConfig('discord')).toMatchObject({
    status: 'refused',
    reason: 'unknown_connector',
  });
  writeFileSync(join(home, 'config.json'), '{not json');
  expect(await wire.connectorConfig('telegram')).toMatchObject({
    status: 'refused',
    reason: 'config_unloadable',
  });
});
