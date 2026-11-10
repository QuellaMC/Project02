/**
 * Telegram, the one connector, drawn by hand: its switch, each
 * character's bot, the accounts paired and the requests waiting, what it
 * shows of other chats, and the home's own bot; and a bot's page, its
 * token to add or how health says it stands.
 */
import type {JsonValue, PairingRequest} from '@project02/wire/contract';
import {
  Cell,
  Face,
  Group,
  Label,
  LinkCell,
  PageHeader,
  PersonFace,
  Problems,
  SubHeader,
  Switch,
  Tile,
} from './settings-controls.tsx';
import {FieldRow, problemsAt, type Ctx} from './settings-fields.tsx';
import {SectionProblems} from './settings-pages.tsx';
import {
  botStored,
  botWords,
  telegramNotRunning,
  telegramOn,
} from './settings-model.ts';
import {
  characterTarget,
  fieldAt,
  home,
  sectionOf,
  targetKey,
  viewOf,
  type Row,
} from './settings.ts';
import {characterName, type SettingsPage} from './store.ts';

function telegramRow(name: string, target: Row['target'] = home): Row {
  return {
    target,
    place: {kind: 'field', namespace: 'connectors', id: 'telegram', name},
  };
}

const switchRow: Row = {
  target: home,
  place: {kind: 'switch', namespace: 'connectors', id: 'telegram'},
};

export function TelegramPage({ctx}: {readonly ctx: Ctx}) {
  const {state, settings, session} = ctx;
  const view = viewOf(settings, home);
  const read = settings.views.get(targetKey(home));
  const on = telegramOn(settings);
  const running =
    state.health?.connectors.find(connector => connector.id === 'telegram')
      ?.connected !== false;

  return (
    <>
      <PageHeader
        art={<Tile icon="plane" tint="blue" size="page" />}
        title="Telegram"
        subtitle="Talk to your characters in Telegram."
      />
      {read?.status === 'refused' ? (
        <p className="page-problem">{read.message}</p>
      ) : null}
      <SectionProblems
        ctx={ctx}
        target={home}
        namespace="connectors"
        id="telegram"
      />
      {view === undefined ? null : (
        <Group
          footer={
            !on
              ? 'Turn on to add bots and pair your account.'
              : running
                ? undefined
                : telegramNotRunning
          }
        >
          <Cell kind="switch" problems={problemsAt(ctx, switchRow)}>
            <Label name="Telegram" />
            <Switch
              on={on}
              label="Telegram"
              onToggle={() => {
                void session.choose(switchRow, !on);
              }}
            />
          </Cell>
        </Group>
      )}
      {view === undefined || !on ? null : (
        <>
          <Bots ctx={ctx} />
          <Paired ctx={ctx} />
          <Group>
            <Mirror ctx={ctx} />
            <LinkCell
              {...botValue(ctx, home)}
              tall
              onClick={() => {
                session.goTo({kind: 'bot', target: home, from: 'telegram'});
              }}
            >
              <Label
                name="App Bot"
                detail="Optional. Sends you approvals and pairing requests."
              />
            </LinkCell>
          </Group>
        </>
      )}
    </>
  );
}

function botValue(
  ctx: Ctx,
  target: Row['target'],
): {readonly value: string; readonly tone: 'link' | 'plain' | 'problem'} {
  const words = botWords(
    ctx.state.health,
    target,
    botStored(ctx.settings, target),
  );

  return {value: words.value, tone: words.tone};
}

function Bots({ctx}: {readonly ctx: Ctx}) {
  return (
    <Group title="Bots" footer="Each character answers as her own bot.">
      {(ctx.state.health?.characters ?? []).map(character => {
        const target = characterTarget(character.id);

        return (
          <LinkCell
            key={character.id}
            {...botValue(ctx, target)}
            onClick={() => {
              ctx.session.goTo({kind: 'bot', target, from: 'telegram'});
            }}
          >
            <Face id={character.id} name={character.displayName} size="row" />
            <Label name={character.displayName} />
          </LinkCell>
        );
      })}
    </Group>
  );
}

/** The accounts paired, each with Remove, and every request waiting, with Approve and Decline. */
function Paired({ctx}: {readonly ctx: Ctx}) {
  const {state, settings, session} = ctx;
  const row = telegramRow('pairedUsers');
  const view = viewOf(settings, home);
  const field = view === undefined ? undefined : fieldAt(view, row.place);
  const value = field?.effective.value;
  const paired = isAccounts(value) ? Object.entries(value) : [];
  const requests = state.pairings.filter(
    request => request.connectorId === 'telegram',
  );

  return (
    <Group
      title="Paired Accounts"
      footer="To pair, message any bot, then approve the request here."
    >
      {paired.map(([id, name]) => (
        <Cell kind="person" key={id}>
          <PersonFace name={name} size="row" />
          <Label name={name} detail={id} />
          <button
            type="button"
            className="button-small button-red"
            onClick={() => {
              void session.choose(
                row,
                Object.fromEntries(paired.filter(([other]) => other !== id)),
              );
            }}
          >
            Remove
          </button>
        </Cell>
      ))}
      {paired.length === 0 ? <p className="panel-empty">No one yet</p> : null}
      {requests.map(request => (
        <Request key={request.code} ctx={ctx} request={request} />
      ))}
      <Problems problems={problemsAt(ctx, row)} />
    </Group>
  );
}

/** The paired accounts as the home holds them: each account's id and name. */
function isAccounts(
  value: JsonValue | undefined,
): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(name => typeof name === 'string')
  );
}

function Request({
  ctx,
  request,
}: {
  readonly ctx: Ctx;
  readonly request: PairingRequest;
}) {
  return (
    <Cell kind="person">
      <PersonFace name={request.subject.label} size="row" />
      <Label name={request.subject.label} detail={`Code ${request.code}`} />
      <span className="buttons">
        <button
          type="button"
          className="button-small button-blue"
          onClick={() => {
            void ctx.session.settlePairing(request.code, 'approved');
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="button-small"
          onClick={() => {
            void ctx.session.settlePairing(request.code, 'denied');
          }}
        >
          Decline
        </button>
      </span>
    </Cell>
  );
}

/** Show Other Chats: the home's switch for what the bots show of other surfaces. */
function Mirror({ctx}: {readonly ctx: Ctx}) {
  const row = telegramRow('mirror');
  const view = viewOf(ctx.settings, home);
  const field = view === undefined ? undefined : fieldAt(view, row.place);

  return field === undefined ? null : (
    <FieldRow
      ctx={ctx}
      row={row}
      field={field}
      detail="Also shows what you say in this app"
    />
  );
}

/**
 * A bot's page: with no token, the box to paste one and how to get it;
 * with one, the bot as health says it stands, what to do about a problem,
 * and Remove Bot, which unsets the token.
 */
export function BotPage({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: Extract<SettingsPage, {kind: 'bot'}>;
}) {
  const {state, settings, session} = ctx;
  const {target} = page;
  const name =
    target.scope === 'global'
      ? undefined
      : characterName(state, target.characterId);
  const row = telegramRow(
    target.scope === 'global' ? 'managementBotToken' : 'botToken',
    target,
  );
  const view = viewOf(settings, target);
  const field = view === undefined ? undefined : fieldAt(view, row.place);
  const stored = botStored(settings, target);
  const words = botWords(state.health, target, stored);
  const footer =
    name === undefined
      ? 'It sends you approvals and pairing requests.'
      : `${name} answers as this bot.`;
  const back =
    page.from === 'telegram' || name === undefined ? 'Telegram' : name;

  return (
    <>
      <SubHeader
        back={back}
        onBack={() => {
          session.goTo(
            page.from === 'telegram' || target.scope === 'global'
              ? {kind: 'telegram'}
              : {kind: 'character', characterId: target.characterId},
          );
        }}
        title={name === undefined ? 'App Bot' : `${name}'s Bot`}
      />
      {view === undefined ||
      sectionOf(view, 'connectors', 'telegram') === undefined ||
      field === undefined ? null : stored ? (
        <>
          <Group footer={[footer, words.sentence].filter(Boolean).join(' ')}>
            <Cell kind="plain">
              <Label name="Bot" />
              <span className={`value value-${words.tone}`}>{words.value}</span>
            </Cell>
          </Group>
          <button
            type="button"
            className="button-danger"
            onClick={() => {
              void session.choose(row, undefined);
            }}
          >
            Remove Bot
          </button>
          <Problems problems={problemsAt(ctx, row)} />
        </>
      ) : (
        <Group
          footer={`In Telegram, message @BotFather and send /newbot. Paste the token it gives you and press Return. ${footer}`}
        >
          <FieldRow ctx={ctx} row={row} field={field} />
        </Group>
      )}
    </>
  );
}
