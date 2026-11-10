/**
 * The window's pages of the home: the person, the AI model, a plugin's
 * account, Advanced, and what the app knows of one plugin. Each draws
 * the home's view; a view the daemon refuses takes the page's place with
 * the daemon's sentence.
 */
import type {ReactNode} from 'react';

import type {
  ConfigTarget,
  RuntimeConfigSectionNamespace,
} from '@project02/wire/contract';
import {
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
  nameInEffect,
  sectionsListed,
  switchedOn,
  usedBy,
  valueNow,
} from './settings-model.ts';
import {
  characterTarget,
  fieldAt,
  home,
  sectionKey,
  sectionOf,
  targetKey,
  viewOf,
  type OkView,
  type Row,
} from './settings.ts';

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

function hostRow(name: string, target: ConfigTarget = home): Row {
  return {target, place: {kind: 'host', name}};
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
          const row = hostRow('userDisplayName');
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
        {view => <ModelCards ctx={ctx} view={view} />}
      </HomeView>
    </>
  );
}

/**
 * The service; once one is chosen, its key and model; and under Advanced
 * the server address and the context size. A row that holds a value of
 * its own shows whatever the rules say: a value in effect is never hidden.
 */
function ModelCards({ctx, view}: {readonly ctx: Ctx; readonly view: OkView}) {
  const field = (name: string) => fieldAt(view, hostRow(name).place);
  const service = field('roleModelProvider');
  const shown = (name: string, when: boolean) => {
    const found = field(name);

    return found !== undefined &&
      (when ||
        found.authored.configured ||
        problemsAt(ctx, hostRow(name)).length > 0)
      ? found
      : undefined;
  };
  const chosen =
    service !== undefined &&
    valueNow(ctx.settings, hostRow('roleModelProvider'), service) !== undefined;
  const key = shown('nvidiaApiKey', chosen);
  const model = shown('nvidiaModel', chosen);
  const server = shown('nvidiaBaseUrl', ctx.state.advanced);
  const context = shown('contextWindowTokens', ctx.state.advanced);

  return (
    <>
      {service === undefined ? null : (
        <Group
          footer={chosen ? view.model.message : 'Choose a service to start.'}
        >
          <ServiceRow
            ctx={ctx}
            row={hostRow('roleModelProvider')}
            field={service}
          />
        </Group>
      )}
      {key === undefined && model === undefined ? null : (
        <Group footer="Paste a key and press Return; it is never shown again. Get one at build.nvidia.com.">
          {key === undefined ? null : (
            <FieldRow ctx={ctx} row={hostRow(key.name)} field={key} />
          )}
          {model === undefined ? null : (
            <FieldRow ctx={ctx} row={hostRow(model.name)} field={model} />
          )}
        </Group>
      )}
      {server === undefined && context === undefined ? null : (
        <Group
          title="Advanced"
          footer="A server address runs the model on a computer of your own."
        >
          {server === undefined ? null : (
            <FieldRow ctx={ctx} row={hostRow(server.name)} field={server} />
          )}
          {context === undefined ? null : (
            <FieldRow ctx={ctx} row={hostRow(context.name)} field={context} />
          )}
        </Group>
      )}
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
