/**
 * The translator in the settings window, for a character who speaks
 * another language than the person: whether anything of it shows, her
 * language and the person's as their menus offer them, her words and
 * phrases as her Translation Notes page shows them, and what does the
 * translating, as AI Model offers it. She never sees any of it. Nothing
 * here touches the DOM.
 */
import type {CharacterSummary} from '@project02/wire/contract';
import {
  servicesOffered,
  suggestedChoices,
  valueNow,
  type Option,
  type ServiceChoice,
} from './settings-model.ts';
import {
  characterTarget,
  fieldAt,
  home,
  hostRow,
  rowKey,
  viewOf,
  type Field,
  type Row,
} from './settings.ts';
import type {Settings} from './store.ts';

/** Whether a character of the home speaks another language: until one does, nothing of the translator shows. */
export function translated(characters: readonly CharacterSummary[]): boolean {
  return characters.some(character => character.language !== undefined);
}

/**
 * A language under its own name as the browser knows it, such as 日本語
 * for `ja`; its tag where the browser knows no name for it.
 */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], {type: 'language'}).of(tag) ?? tag;
  } catch {
    // A tag the browser cannot read names no language it knows.
    return tag;
  }
}

/** The language the person reads, the home's: Automatic while none is chosen. */
export const yourLanguageRow: Row = hostRow(home, 'userLanguage');

/**
 * The language she speaks, hers alone: the one her package brought or the
 * person chose her.
 */
export function herLanguageRow(characterId: string): Row {
  return hostRow(characterTarget(characterId), 'language');
}

/** What her menu says while she has no language of her own: she answers in the one the person writes. */
export const anyLanguage = 'Any Language';

/**
 * The language of `row`, hers or the person's, as its menu offers it once
 * the view it is in is read: the language chosen, none while none is, and
 * the languages its field suggests under the names it gives them, then
 * the one it holds when it suggests no such, under that language's own
 * name.
 */
export function languageAt(
  settings: Settings,
  row: Row,
):
  | {
      readonly field: Field;
      readonly value?: string;
      readonly options: readonly Option[];
    }
  | undefined {
  const view = viewOf(settings, row.target);
  const field = view === undefined ? undefined : fieldAt(view, row.place);

  if (field === undefined) {
    return undefined;
  }

  const value = valueNow(settings, row, field);

  return {
    field,
    ...(value === undefined ? {} : {value}),
    options: suggestedChoices(field, value, languageName),
  };
}

/** One of her words and how the person reads it, or what it means. */
export type Note = {readonly hers: string; readonly shown: string};

/** The most words and phrases she can have: at as many, Add a Note is not offered. */
export const mostNotes = 100;

/** The most characters either box of a note holds, one line each. */
export const noteLimit = 200;

/** The most characters how she sounds holds. */
export const toneLimit = 1000;

/** Her words and phrases, hers alone. */
export function wordsRow(characterId: string): Row {
  return hostRow(characterTarget(characterId), 'translationWords');
}

/** How she sounds, hers alone. */
export function toneRow(characterId: string): Row {
  return hostRow(characterTarget(characterId), 'translationTone');
}

/**
 * Her words and phrases as her Translation Notes page shows them: what is
 * typed there and not yet saved, a note with a box still empty among
 * them, else what her settings hold.
 */
export function notesShown(
  settings: Settings,
  characterId: string,
): readonly Note[] {
  const typed = settings.edits.get(rowKey(wordsRow(characterId)));

  return typed === undefined
    ? notesHeld(settings, characterId)
    : notesOf(JSON.parse(typed) as unknown);
}

/** Her words and phrases as her settings hold them, which her package brought unless the person changed them. */
export function notesHeld(
  settings: Settings,
  characterId: string,
): readonly Note[] {
  const row = wordsRow(characterId);
  const view = viewOf(settings, row.target);

  return notesOf(
    view === undefined ? undefined : fieldAt(view, row.place)?.effective.value,
  );
}

/** Her notes as the page keeps them while they are typed and not saved. */
export function notesText(notes: readonly Note[]): string {
  return JSON.stringify(notes.map(({hers, shown}) => ({hers, shown})));
}

/** Each pair of words a value holds, as a note; what is no pair is none. */
function notesOf(value: unknown): readonly Note[] {
  const entries: readonly unknown[] = Array.isArray(value) ? value : [];

  return entries.flatMap(entry =>
    typeof entry === 'object' &&
    entry !== null &&
    'hers' in entry &&
    'shown' in entry &&
    typeof entry.hers === 'string' &&
    typeof entry.shown === 'string'
      ? [{hers: entry.hers, shown: entry.shown}]
      : [],
  );
}

/** The service that translates, the home's alone; none while the AI model she runs on does. */
export const translatorRow: Row = hostRow(home, 'translatorProvider');

/** The model of that service the translator asks, the home's alone. */
export const translatorModelRow: Row = hostRow(home, 'translatorModel');

/** What translates while no service is chosen for it, in words that never say she does: she never knows of it. */
export const sameAsHers = 'Same AI Model as Hers';

/**
 * What does the translating, as its page offers it: the service the home's
 * settings choose for it, none while the AI model she runs on translates;
 * the services to choose from, as a character's own menu lists them; and,
 * with one chosen, the translator's model, offered the models that
 * service's own model field suggests, in their words, and showing, while
 * it holds none, the model that service has in the home's settings.
 */
export function translatorChoice(settings: Settings): ServiceChoice {
  const view = viewOf(settings, home);
  const provider =
    view === undefined ? undefined : fieldAt(view, translatorRow.place);

  if (view === undefined || provider === undefined) {
    return {options: []};
  }

  const id = valueNow(settings, translatorRow, provider);
  const chosen = view.services.find(service => service.id === id);
  const own = fieldAt(view, translatorModelRow.place);
  const its =
    chosen === undefined
      ? undefined
      : fieldAt(view, {kind: 'host', name: chosen.model});

  return {
    ...(chosen === undefined ? {} : {chosen}),
    options: servicesOffered(view, chosen),
    ...(own === undefined || its === undefined
      ? {}
      : {model: modelOffered(own, its)}),
  };
}

/**
 * The translator's model, `own`, as its row draws it: offered the models
 * its service's own model field, `its`, suggests, in their words; and,
 * while it holds none, asking what `its` holds in effect, which the row
 * shows as that field's row does, or, holding none either, says as its
 * empty box does.
 */
function modelOffered(own: Field, its: Field): Field {
  const {suggestedValues, choices, placeholder, effective} = its;
  const offered = {
    ...own,
    ...(suggestedValues === undefined ? {} : {suggestedValues}),
    ...(choices === undefined ? {} : {choices}),
  };

  if (own.authored.configured) {
    return offered;
  }

  return {
    ...offered,
    effective,
    ...(effective.value === undefined && placeholder !== undefined
      ? {placeholder}
      : {}),
  };
}

/** What the translator's row on AI Model says: the service chosen for it, or that her own AI model translates. */
export function translatorWords(settings: Settings): string {
  return translatorChoice(settings).chosen?.name ?? sameAsHers;
}

/**
 * What choosing `value` in the translator's menu changes, each a row and
 * its value, none to unset it: another service takes away the model
 * chosen for the one before, and Same AI Model as Hers, none, takes away
 * both.
 */
export function translatorChanges(
  settings: Settings,
  value: string | undefined,
): readonly {readonly row: Row; readonly value?: string}[] {
  const view = viewOf(settings, home);
  const model =
    view === undefined ? undefined : fieldAt(view, translatorModelRow.place);
  const held =
    model !== undefined &&
    valueNow(settings, translatorModelRow, model) !== undefined;

  return [
    ...(held ? [{row: translatorModelRow}] : []),
    {row: translatorRow, ...(value === undefined ? {} : {value})},
  ];
}
