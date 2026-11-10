/**
 * A field of a view as a row of the window, by the control its shape
 * takes, and a section's layout as its cards: what is typed or clicked
 * goes to the session, and what the daemon said of the field shows at it.
 */
import type {ReactNode} from 'react';

import type {ConfigTarget} from '@project02/wire/contract';
import type {Session} from './session.ts';
import {
  Cell,
  Group,
  KeyBox,
  Label,
  Pills,
  Problems,
  Segmented,
  SelectBox,
  Switch,
  TextBox,
  type Option,
} from './settings-controls.tsx';
import {
  cardsShown,
  choiceWords,
  controlOf,
  keyPlaceholder,
  labelOf,
  placeholderOf,
  valueNow,
  type Findings,
  type ShownCard,
} from './settings-model.ts';
import {
  ownText,
  rowKey,
  type Field,
  type Row,
  type Section,
} from './settings.ts';
import type {Settings, WebState} from './store.ts';

/** What every part of the window needs. */
export type Ctx = {
  readonly state: WebState;
  readonly settings: Settings;
  readonly session: Session;
  readonly findings: Findings;
};

/** A row's key as an element id. */
function domId(row: Row): string {
  return rowKey(row).replaceAll(/[^A-Za-z0-9_-]/gu, '-');
}

/** Everything said at a row: the daemon's answer to its last change, and the findings of the views. */
export function problemsAt(ctx: Ctx, row: Row): readonly string[] {
  const key = rowKey(row);
  const answer = ctx.settings.problems.get(key);

  return [
    ...(answer === undefined ? [] : [answer]),
    ...(ctx.findings.rows.get(key) ?? []),
  ];
}

/** The change whose check a row shows, when its last change landed. */
function checkAt(ctx: Ctx, row: Row): number | undefined {
  const {saved} = ctx.settings;

  return saved?.key === rowKey(row) ? saved.ticket : undefined;
}

function optionsOf(field: Field): readonly Option[] {
  return (field.allowedValues ?? []).map(value => ({
    value,
    label: choiceWords(field, value),
  }));
}

/**
 * One field as a row, by its control: a box with its label, a switch, or a
 * segmented choice. `leading` goes before the label; `placeholder` says
 * what an empty box shows when the field's own hint is not the right one.
 */
export function FieldRow({
  ctx,
  row,
  field,
  leading,
  placeholder,
  detail,
}: {
  readonly ctx: Ctx;
  readonly row: Row;
  readonly field: Field;
  readonly leading?: ReactNode;
  readonly placeholder?: string;
  readonly detail?: string;
}) {
  const {settings, session} = ctx;
  const id = domId(row);
  const label = labelOf(field);
  const problems = problemsAt(ctx, row);
  const edit = settings.edits.get(rowKey(row));

  switch (controlOf(field)) {
    case 'switch': {
      const on = valueNow(settings, row, field) === 'true';

      return (
        <Cell
          kind={detail === undefined ? 'switch' : 'tall'}
          problems={problems}
        >
          <Label name={label} {...(detail === undefined ? {} : {detail})} />
          <Switch
            on={on}
            label={label}
            onToggle={() => {
              void session.choose(row, !on);
            }}
          />
        </Cell>
      );
    }
    case 'segmented':
    case 'pills':
      return (
        <Cell kind="field" problems={problems}>
          <span id={id} className="field-label field-label-short">
            {label}
          </span>
          <Segmented
            labelledBy={id}
            value={valueNow(settings, row, field)}
            options={optionsOf(field)}
            onChoose={value => {
              void session.choose(row, value);
            }}
          />
        </Cell>
      );
    case 'key':
      return (
        <Cell kind="field" problems={problems}>
          <label htmlFor={id} className="field-label">
            {leading}
            <span>{label}</span>
          </label>
          <KeyBox
            id={id}
            text={edit ?? ''}
            stored={field.authored.configured}
            placeholder={focused => keyPlaceholder(field, focused)}
            {...checkProp(checkAt(ctx, row))}
            remove={{
              label: `Remove ${label}`,
              onClick: () => {
                void session.choose(row, undefined);
              },
            }}
            onChange={text => {
              session.edit(row, text);
            }}
            onCommit={() => {
              void session.save(row);
            }}
          />
        </Cell>
      );
    case 'text':
      return (
        <Cell kind="field" problems={problems}>
          <label htmlFor={id} className="field-label">
            {leading}
            <span>{label}</span>
          </label>
          <TextBox
            id={id}
            value={edit ?? ownText(field)}
            placeholder={placeholder ?? placeholderOf(field, row.target)}
            numeric={field.valueType === 'number'}
            {...checkProp(checkAt(ctx, row))}
            onChange={text => {
              session.edit(row, text);
            }}
            onCommit={() => {
              void session.save(row);
            }}
          />
        </Cell>
      );
  }
}

function checkProp(check: number | undefined): {readonly check?: number} {
  return check === undefined ? {} : {check};
}

/** The service a model runs on: a select whose first entry chooses none, saved at the choice. */
export function ServiceRow({
  ctx,
  row,
  field,
}: {
  readonly ctx: Ctx;
  readonly row: Row;
  readonly field: Field;
}) {
  const id = domId(row);

  return (
    <Cell kind="field" problems={problemsAt(ctx, row)}>
      <label htmlFor={id} className="field-label">
        {labelOf(field)}
      </label>
      <SelectBox
        id={id}
        value={valueNow(ctx.settings, row, field)}
        options={optionsOf(field)}
        none="Choose a Service"
        {...checkProp(checkAt(ctx, row))}
        onChoose={value => {
          void ctx.session.choose(row, value);
        }}
      />
    </Cell>
  );
}

/** One field of a section for a target. */
export function sectionRow(
  target: ConfigTarget,
  section: Section,
  name: string,
): Row {
  return {
    target,
    place: {kind: 'field', namespace: section.namespace, id: section.id, name},
  };
}

/**
 * A section's layout as its cards, under the window's rules: a choice of
 * many words is a row of pills under its label, between the card's rows
 * before and after it; a card's title goes over its first rows and its
 * footer under its last.
 */
export function LayoutCards({
  ctx,
  target,
  section,
}: {
  readonly ctx: Ctx;
  readonly target: ConfigTarget;
  readonly section: Section;
}) {
  const row = (name: string): Row => sectionRow(target, section, name);
  const cards = cardsShown(section, {
    advanced: ctx.state.advanced,
    current: name => {
      const field = section.fields.find(candidate => candidate.name === name);

      return field === undefined
        ? undefined
        : valueNow(ctx.settings, row(name), field);
    },
    said: name => problemsAt(ctx, row(name)).length > 0,
  });

  return (
    <>
      {cards.map((card, at) => (
        <CardPieces key={at} ctx={ctx} card={card} row={row} />
      ))}
    </>
  );
}

type Piece =
  | {readonly kind: 'rows'; readonly fields: readonly Field[]}
  | {readonly kind: 'pills'; readonly field: Field};

function piecesOf(card: ShownCard): readonly Piece[] {
  const pieces: Piece[] = [];

  for (const field of card.fields) {
    const last = pieces.at(-1);

    if (controlOf(field) === 'pills') {
      pieces.push({kind: 'pills', field});
    } else if (last?.kind === 'rows') {
      pieces[pieces.length - 1] = {
        kind: 'rows',
        fields: [...last.fields, field],
      };
    } else {
      pieces.push({kind: 'rows', fields: [field]});
    }
  }

  return pieces;
}

function CardPieces({
  ctx,
  card,
  row,
}: {
  readonly ctx: Ctx;
  readonly card: ShownCard;
  readonly row: (name: string) => Row;
}) {
  const pieces = piecesOf(card);
  const firstRows = pieces.findIndex(piece => piece.kind === 'rows');

  return (
    <>
      {pieces.map((piece, at) => {
        const footer = at === pieces.length - 1 ? card.footer : undefined;

        if (piece.kind === 'pills') {
          return (
            <PillsGroup
              key={piece.field.name}
              ctx={ctx}
              row={row(piece.field.name)}
              field={piece.field}
              {...(footer === undefined ? {} : {footer})}
            />
          );
        }

        return (
          <Group
            key={piece.fields[0]?.name}
            {...(at === firstRows && card.title !== undefined
              ? {title: card.title}
              : {})}
            {...(footer === undefined ? {} : {footer})}
          >
            {piece.fields.map(field => (
              <FieldRow
                key={field.name}
                ctx={ctx}
                row={row(field.name)}
                field={field}
              />
            ))}
          </Group>
        );
      })}
    </>
  );
}

/** A choice of many words: its label over a row of pills. */
function PillsGroup({
  ctx,
  row,
  field,
  footer,
}: {
  readonly ctx: Ctx;
  readonly row: Row;
  readonly field: Field;
  readonly footer?: string;
}) {
  const id = domId(row);

  return (
    <section className="group">
      <h3 className="group-title" id={id}>
        {labelOf(field)}
      </h3>
      <Pills
        labelledBy={id}
        value={valueNow(ctx.settings, row, field)}
        options={optionsOf(field)}
        onChoose={value => {
          void ctx.session.choose(row, value);
        }}
      />
      <Problems problems={problemsAt(ctx, row)} />
      {footer === undefined ? null : <p className="group-footer">{footer}</p>}
    </section>
  );
}
