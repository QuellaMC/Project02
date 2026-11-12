/**
 * The window's pages of the home: the person, the AI model and each
 * service it can be, a plugin's account, an account her apps use,
 * Advanced, and what the app knows of one plugin. Each draws the home's
 * view; a view the daemon refuses takes the page's place with the
 * daemon's sentence.
 */
import type {ReactNode} from 'react';

import type {
  ConfigTarget,
  ModelService,
  RuntimeConfigSectionNamespace,
} from '@project02/wire/contract';
import {accountKeyRow, herApp} from './her-apps.ts';
import {
  BackButton,
  Cell,
  Face,
  Group,
  Label,
  LinkCell,
  PageHeader,
  PersonFace,
  SubHeader,
  Switch,
  Tile,
} from './settings-controls.tsx';
import {
  FieldRow,
  LayoutCards,
  ServiceRow,
  problemsAt,
  type Ctx,
} from './settings-fields.tsx';
import {
  accessLines,
  artOf,
  keyOf,
  nameInEffect,
  sectionsListed,
  serviceArt,
  serviceChoice,
  servicesListed,
  switchedOn,
  usedBy,
  type ListedService,
} from './settings-model.ts';
import {
  characterTarget,
  fieldAt,
  home,
  hostRow,
  sectionKey,
  sectionOf,
  targetKey,
  viewOf,
  type Field,
  type OkView,
  type Row,
} from './settings.ts';
import type {SettingsPage} from './store.ts';

/** The home's view, or the daemon's sentence in place of a page it cannot be read for. */
function HomeView({
  ctx,
  children,
}: {
  readonly ctx: Ctx;
  readonly children: (view: OkView) => ReactNode;
}) {
  const view = ctx.settings.views.get(targetKey(home));

  if (view?.status === 'refused') {
    return <p className="page-problem">{view.message}</p>;
  }

  return view === undefined ? null : <>{children(view)}</>;
}

/** What is wrong with a section as a whole, said on its page. */
export function SectionProblems({
  ctx,
  target,
  namespace,
  id,
}: {
  readonly ctx: Ctx;
  readonly target: ConfigTarget;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly id: string;
}) {
  const said = ctx.findings.sections.get(
    `${targetKey(target)}/${sectionKey(namespace, id)}`,
  );

  return (
    <>
      {(said ?? []).map(problem => (
        <p className="page-problem" key={problem}>
          {problem}
        </p>
      ))}
    </>
  );
}

/**
 * The home's field of this name, while the page shows it: one of what
 * most people never need shows while the Advanced switch is on, and
 * whenever it holds a value of its own or something is said at it, since
 * a value in effect is never hidden.
 */
function advancedField(
  ctx: Ctx,
  view: OkView,
  name: string,
): Field | undefined {
  const field = fieldAt(view, hostRow(home, name).place);

  return field !== undefined &&
    (ctx.state.advanced ||
      field.authored.configured ||
      problemsAt(ctx, hostRow(home, name)).length > 0)
    ? field
    : undefined;
}

export function YouPage({ctx}: {readonly ctx: Ctx}) {
  const name = nameInEffect(ctx.settings);

  return (
    <>
      <PageHeader
        art={<PersonFace name={name} size="page" />}
        title={name}
        subtitle="You"
      />
      <HomeView ctx={ctx}>
        {view => {
          const row = hostRow(home, 'userDisplayName');
          const field = fieldAt(view, row.place);

          return field === undefined ? null : (
            <Group footer="Your characters call you this.">
              <FieldRow ctx={ctx} row={row} field={field} />
            </Group>
          );
        }}
      </HomeView>
    </>
  );
}

export function ModelPage({ctx}: {readonly ctx: Ctx}) {
  return (
    <>
      <PageHeader
        art={<Tile icon="sparkle" tint="indigo" size="page" />}
        title="AI Model"
        subtitle="What your characters think with."
      />
      <HomeView ctx={ctx}>
        {view => <ServiceGroups ctx={ctx} view={view} />}
      </HomeView>
    </>
  );
}

/**
 * Once a service is connected, what every character thinks with and the
 * services connected; the services that can be added; and under Advanced
 * the context size, which is every service's.
 */
function ServiceGroups({
  ctx,
  view,
}: {
  readonly ctx: Ctx;
  readonly view: OkView;
}) {
  const {connected, others} = servicesListed(ctx.settings);
  const context = advancedField(ctx, view, 'contextWindowTokens');

  return (
    <>
      {connected.length === 0 ? null : (
        <>
          <ThinksWith ctx={ctx} view={view} />
          <Group title="Connected">
            {connected.map(listed => (
              <ServiceLink key={listed.service.id} ctx={ctx} listed={listed} />
            ))}
          </Group>
        </>
      )}
      {others.services.length === 0 ? null : (
        <Group title={others.title} footer={others.footer}>
          {others.services.map(listed => (
            <ServiceLink key={listed.service.id} ctx={ctx} listed={listed} />
          ))}
        </Group>
      )}
      {context === undefined ? null : (
        <Group title="Advanced">
          <FieldRow
            ctx={ctx}
            row={hostRow(home, context.name)}
            field={context}
          />
        </Group>
      )}
    </>
  );
}

/**
 * What every character thinks with: the service, chosen among those
 * connected, and its model, each saved at the choice; under them, while
 * the settings give a character no model, what is missing.
 */
function ThinksWith({ctx, view}: {readonly ctx: Ctx; readonly view: OkView}) {
  const row = hostRow(home, 'roleModelProvider');
  const field = fieldAt(view, row.place);
  const {chosen, options, model} = serviceChoice(ctx.settings, home);

  return field === undefined ? null : (
    <Group
      title="Characters Think With"
      footer={
        view.model.ready
          ? 'Every character uses this, unless her own page says otherwise.'
          : view.model.message
      }
    >
      <ServiceRow
        ctx={ctx}
        row={row}
        field={field}
        value={chosen?.id}
        options={options}
        none="Choose a Service"
        onChoose={value => {
          void ctx.session.choose(row, value);
        }}
      />
      {model === undefined ? null : (
        <FieldRow ctx={ctx} row={hostRow(home, model.name)} field={model} />
      )}
    </Group>
  );
}

/** A service's row: its tile, its name and the line under it, and In Use on the one every character thinks with; it opens the service's page. */
function ServiceLink({
  ctx,
  listed,
}: {
  readonly ctx: Ctx;
  readonly listed: ListedService;
}) {
  const {service, art} = listed;

  return (
    <LinkCell
      tall
      {...(listed.inUse ? {value: 'In Use'} : {})}
      onClick={() => {
        ctx.session.goTo({kind: 'service', serviceId: service.id});
      }}
    >
      <Tile icon={art.icon} tint={art.tint} />
      <Label name={service.name} detail={listed.line} strong />
    </LinkCell>
  );
}

/**
 * A service a character can think with, from AI Model: its tile, its name
 * and what it is; its key, pasted and never shown back, with where a key
 * comes from; under Advanced its other fields but its model, which AI
 * Model chooses; and Remove Key once a key is saved.
 */
export function ServicePage({
  ctx,
  serviceId,
}: {
  readonly ctx: Ctx;
  readonly serviceId: string;
}) {
  const service = viewOf(ctx.settings, home)?.services.find(
    listed => listed.id === serviceId,
  );
  const art = serviceArt(serviceId);

  return (
    <>
      <div className="sub-header">
        <BackButton
          label="AI Model"
          onClick={() => {
            ctx.session.goTo({kind: 'model'});
          }}
        />
        {service === undefined ? null : (
          <PageHeader
            art={<Tile icon={art.icon} tint={art.tint} size="page" />}
            title={service.name}
            subtitle={`${service.summary}.`}
          />
        )}
      </div>
      <HomeView ctx={ctx}>
        {view =>
          service === undefined ? null : (
            <ServiceCards ctx={ctx} view={view} service={service} />
          )
        }
      </HomeView>
    </>
  );
}

function ServiceCards({
  ctx,
  view,
  service,
}: {
  readonly ctx: Ctx;
  readonly view: OkView;
  readonly service: ModelService;
}) {
  const key = keyOf(view, service);
  const others = service.fields.flatMap(name => {
    const field =
      name === key?.name || name === service.model
        ? undefined
        : advancedField(ctx, view, name);

    return field === undefined ? [] : [field];
  });

  return (
    <>
      {key === undefined ? null : (
        <Group
          footer={`Paste a key and press Return; it is never shown again. ${service.keyFrom ?? ''}`}
        >
          <FieldRow ctx={ctx} row={hostRow(home, key.name)} field={key} />
        </Group>
      )}
      {others.length === 0 ? null : (
        <Group title="Advanced">
          {others.map(field => (
            <FieldRow
              key={field.name}
              ctx={ctx}
              row={hostRow(home, field.name)}
              field={field}
            />
          ))}
        </Group>
      )}
      {key?.authored.configured === true ? (
        <button
          type="button"
          className="button-danger"
          onClick={() => {
            void ctx.session.choose(hostRow(home, key.name), undefined);
          }}
        >
          Remove Key
        </button>
      ) : null}
    </>
  );
}

/**
 * A plugin's account, set up once for everyone: its cards from the home's
 * view, then, once it is set up, each character's own switch; until then,
 * what is missing.
 */
export function ConnectionPage({
  ctx,
  pluginId,
}: {
  readonly ctx: Ctx;
  readonly pluginId: string;
}) {
  const homeView = viewOf(ctx.settings, home);
  const section =
    homeView === undefined
      ? undefined
      : sectionOf(homeView, 'plugins', pluginId);
  const art = section === undefined ? undefined : artOf(section);

  return (
    <>
      {section === undefined || art === undefined ? null : (
        <PageHeader
          art={<Tile icon={art.icon} tint={art.tint} size="page" />}
          title={section.displayName}
          {...(section.page === undefined
            ? {}
            : {subtitle: section.page.summary})}
        />
      )}
      <HomeView ctx={ctx}>
        {() =>
          section === undefined ? null : (
            <>
              <SectionProblems
                ctx={ctx}
                target={home}
                namespace="plugins"
                id={pluginId}
              />
              <LayoutCards ctx={ctx} target={home} section={section} />
              {section.setup.ready ? (
                <CharacterSwitches ctx={ctx} pluginId={pluginId} />
              ) : section.setup.message === undefined ? null : (
                <p className="page-note">{section.setup.message}</p>
              )}
            </>
          )
        }
      </HomeView>
    </>
  );
}

/**
 * An account of the person's that her apps use, set up once for everyone,
 * as health says it: its tile, its name, the one field of its key, pasted
 * and never shown back, and where a key comes from. Opened from an app of
 * hers, its Back returns to that app.
 */
export function AccountPage({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: Extract<SettingsPage, {kind: 'account'}>;
}) {
  const {state, settings, session} = ctx;
  const account = state.health?.accounts.find(
    known => known.id === page.accountId,
  );

  if (account === undefined) {
    return null;
  }

  const {from} = page;
  const row = accountKeyRow(account.id);
  const header = (
    <PageHeader
      art={<Tile icon="key" tint="graphite" size="page" />}
      title={account.name}
      subtitle="An account her apps can use."
    />
  );

  return (
    <>
      {from === undefined ? (
        header
      ) : (
        <div className="sub-header">
          <BackButton
            label={
              herApp(settings, from.characterId, from.appId)?.name ?? from.appId
            }
            onClick={() => {
              session.goTo({kind: 'app', ...from});
            }}
          />
          {header}
        </div>
      )}
      <HomeView ctx={ctx}>
        {view => {
          const field = fieldAt(view, row.place);

          return field === undefined ? null : (
            <Group footer={account.keyFrom}>
              <FieldRow ctx={ctx} row={row} field={field} />
            </Group>
          );
        }}
      </HomeView>
    </>
  );
}

/** Each character's own switch for a plugin, by her view. */
function CharacterSwitches({
  ctx,
  pluginId,
}: {
  readonly ctx: Ctx;
  readonly pluginId: string;
}) {
  const characters = (ctx.state.health?.characters ?? []).flatMap(character => {
    const target = characterTarget(character.id);
    const view = viewOf(ctx.settings, target);
    const section =
      view === undefined ? undefined : sectionOf(view, 'plugins', pluginId);

    return section === undefined ? [] : [{character, target, section}];
  });

  return characters.length === 0 ? null : (
    <Group title="Characters">
      {characters.map(({character, target, section}) => {
        const row: Row = {
          target,
          place: {kind: 'switch', namespace: 'plugins', id: pluginId},
        };
        const on = switchedOn(ctx.settings, target, section);

        return (
          <Cell
            kind="switch"
            key={character.id}
            problems={problemsAt(ctx, row)}
          >
            <Face id={character.id} name={character.displayName} size="row" />
            <Label name={character.displayName} />
            <Switch
              on={on}
              label={`${section.displayName} for ${character.displayName}`}
              onToggle={() => {
                void ctx.session.choose(row, !on);
              }}
            />
          </Cell>
        );
      })}
    </Group>
  );
}

export function AdvancedPage({ctx}: {readonly ctx: Ctx}) {
  const {state, settings, session, findings: found} = ctx;

  return (
    <>
      <PageHeader
        art={<Tile icon="sliders" tint="gray" size="page" />}
        title="Advanced"
        subtitle="Settings most people never need."
      />
      <Group footer="Adds server addresses, context size, and a character's own AI model.">
        <Cell kind="switch">
          <Label name="Show Advanced Settings" />
          <Switch
            on={state.advanced}
            label="Show Advanced Settings"
            onToggle={() => {
              session.setAdvanced(!state.advanced);
            }}
          />
        </Cell>
      </Group>
      <Group
        title="Plugins"
        footer="Everything the app has installed, with versions. Useful when something goes wrong."
      >
        {sectionsListed(settings).map(section => {
          const art = artOf(section);

          return (
            <LinkCell
              key={sectionKey(section.namespace, section.id)}
              value={section.version}
              onClick={() => {
                session.goTo({
                  kind: 'plugin',
                  namespace: section.namespace,
                  id: section.id,
                });
              }}
            >
              <Tile icon={art.icon} tint={art.tint} />
              <Label name={section.displayName} />
            </LinkCell>
          );
        })}
      </Group>
      {!state.advanced || found.notes.length === 0 ? null : (
        <Group title="Notes">
          {found.notes.map(note => (
            <Cell kind="note" key={note}>
              <span className="label">{note}</span>
            </Cell>
          ))}
        </Group>
      )}
    </>
  );
}

/** What the app knows of one plugin or connector: its version, who uses it, and what it can do. */
export function PluginPage({
  ctx,
  namespace,
  id,
}: {
  readonly ctx: Ctx;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly id: string;
}) {
  const {settings, session, state} = ctx;
  const section = sectionsListed(settings).find(
    listed => listed.namespace === namespace && listed.id === id,
  );

  if (section === undefined) {
    return null;
  }

  const users = usedBy(settings, state.health?.characters ?? [], namespace, id);
  const lines = accessLines(section);

  return (
    <>
      <SubHeader
        back="Advanced"
        onBack={() => {
          session.goTo({kind: 'advanced'});
        }}
        title={section.displayName}
        blurb={`Built in · Version ${section.version}`}
      />
      <SectionProblems ctx={ctx} target={home} namespace={namespace} id={id} />
      <Group title="Used By">
        {users.map(character => (
          <LinkCell
            key={character.id}
            onClick={() => {
              session.goTo({kind: 'character', characterId: character.id});
            }}
          >
            <Face id={character.id} name={character.displayName} size="row" />
            <Label name={character.displayName} />
          </LinkCell>
        ))}
        {users.length === 0 ? (
          <p className="panel-empty">No character uses it right now.</p>
        ) : null}
      </Group>
      {lines.length === 0 ? null : (
        <Group
          title="It Can"
          {...(section.access === undefined
            ? {}
            : {footer: 'It asked for these when it was installed.'})}
        >
          {lines.map(line => (
            <Cell kind="note" key={line}>
              <Tile icon="shield" tint="gray" size="note" />
              <span className="label">{line}</span>
            </Cell>
          ))}
        </Group>
      )}
      <p className="page-footnote">
        {namespace === 'plugins'
          ? "Built in. You can turn it off on each character's page, but not remove it."
          : 'Built in. You can turn it off on its own page, but not remove it.'}
      </p>
    </>
  );
}
