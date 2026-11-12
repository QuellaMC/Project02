/**
 * Her ask to install an app of the App Store, as the confirmation that asks
 * the person says it in its preview: the app, whether it can wake her, and
 * the version of it on her phone that it updates. The chat's card says it
 * in a sentence, and her phone's window lays it over that app in the store
 * until it is settled. A preview the page cannot read as one is none, and
 * its confirmation is drawn as any other.
 */
import type {JsonValue} from '@project02/wire/contract';

/** What the preview of her ask to install an app says it is. */
const installKind = 'phone_app_install';

export type InstallAsk = {
  /** The app, by its id in the App Store and its name, and whether it says it wakes her. */
  readonly app: {
    readonly id: string;
    readonly name: string;
    readonly wakes: boolean;
  };
  /** The version of it on her phone that installing it updates, when there is one. */
  readonly replaces?: string;
};

/** Her ask, when `preview` is one of an app of the App Store that the page can read. */
export function installAskOf(
  preview: Readonly<Record<string, JsonValue>>,
): InstallAsk | undefined {
  const {kind, app, source, replaces} = preview;

  if (
    kind !== installKind ||
    source !== 'catalog' ||
    !isFields(app) ||
    (replaces !== undefined && typeof replaces !== 'string')
  ) {
    return undefined;
  }

  const {id, name, wakes} = app;

  return typeof id === 'string' &&
    typeof name === 'string' &&
    typeof wakes === 'boolean'
    ? {app: {id, name, wakes}, ...(replaces === undefined ? {} : {replaces})}
    : undefined;
}

/**
 * The card's one sentence: where the app comes from, what it does, and,
 * when it replaces a version on her phone, that it is an update from it.
 */
export function installSentence(ask: InstallAsk): string {
  const does = ask.app.wakes
    ? 'It keeps its own data and can wake her up.'
    : 'It keeps its own data.';
  const update =
    ask.replaces === undefined
      ? ''
      : ` It is an update from version ${ask.replaces}.`;

  return `From the App Store, reviewed by Project02. ${does}${update}`;
}

function isFields(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
