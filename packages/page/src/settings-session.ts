/**
 * The settings verbs a page calls, over the tab's one client: every view
 * and every outcome passes through the settings rules, and the page reads
 * the store. Browser-only like session.ts; the browser suite is its cover.
 */
import type {
  ConfigChangeOutcome,
  ConfigTarget,
  ConfigView,
  JsonValue,
} from '@project02/wire/contract';
import type {GatewayClient} from '@project02/wire/client';
import {
  advancedSet,
  changeEnded,
  changeSent,
  characterTarget,
  clickedText,
  conflictMet,
  editLetGo,
  editToSend,
  fieldAt,
  fieldEdited,
  home,
  operationFor,
  rowKey,
  settingsClosed,
  settingsOpened,
  targetKey,
  viewOf,
  viewsRead,
  welcomeOpened,
  welcomeStepped,
  type Row,
} from './settings.ts';
import {
  noticeSpent,
  noticed,
  type SettingsPage,
  type WebState,
} from './store.ts';

export type SettingsVerbs = {
  readonly openSettings: (page: SettingsPage) => Promise<void>;
  /** Another page of the window that is open. */
  readonly goTo: (page: SettingsPage) => void;
  readonly closeSettings: () => void;
  readonly edit: (row: Row, text: string) => void;
  /** Sends what is typed in a box, when it changed. */
  readonly save: (row: Row) => Promise<void>;
  /** A switch, a choice or a select: the value goes at the click; none unsets it. */
  readonly choose: (row: Row, value: JsonValue | undefined) => Promise<void>;
  /**
   * A change worked out from what the row holds when its turn comes, for a
   * value that is a list of things: two asked for together each start
   * from what the one before left, so neither undoes the other.
   */
  readonly amend: (
    row: Row,
    next: (held: JsonValue | undefined) => JsonValue | undefined,
  ) => Promise<void>;
  readonly setAdvanced: (on: boolean) => void;
  /** The welcome's Continue: what its step holds is saved, and the next step opens once it landed. */
  readonly welcomeNext: () => Promise<void>;
  readonly welcomeBack: () => void;
  /** Start Chatting: the welcome gives way to the chat. */
  readonly finishWelcome: () => void;
};

/** An address that can never work has no settings to change. */
export const noSettingsVerbs: SettingsVerbs = {
  openSettings: () => Promise.resolve(),
  goTo: () => undefined,
  closeSettings: () => undefined,
  edit: () => undefined,
  save: () => Promise.resolve(),
  choose: () => Promise.resolve(),
  amend: () => Promise.resolve(),
  setAdvanced: () => undefined,
  welcomeNext: () => Promise.resolve(),
  welcomeBack: () => undefined,
  finishWelcome: () => undefined,
};

const advancedKey = 'project02.advanced';

/** The window's Advanced switch as this browser remembers it; off when it keeps nothing. */
export function rememberedAdvanced(): boolean {
  try {
    return localStorage.getItem(advancedKey) === 'true';
  } catch {
    return false;
  }
}

function remember(advanced: boolean): void {
  try {
    localStorage.setItem(advancedKey, String(advanced));
  } catch {
    // A browser that keeps nothing forgets the switch with the tab.
  }
}

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The name row and the key row the welcome's steps save. */
const nameRow: Row = {
  target: home,
  place: {kind: 'host', name: 'userDisplayName'},
};
const keyRow: Row = {target: home, place: {kind: 'host', name: 'nvidiaApiKey'}};

/** A read of every view, numbered as it began. */
type Read = {
  readonly mine: number;
  readonly views: ReadonlyMap<string, ConfigView>;
};

/** What the settings verbs need of the tab: its client and its one value. */
type Tab = {
  readonly client: GatewayClient;
  readonly getState: () => WebState;
  readonly apply: (reduce: (state: WebState) => WebState) => void;
};

/** The welcome's steps: Continue saves what its step holds, as a box is saved, and the next step opens once it landed. */
function welcomeVerbs(
  {getState, apply}: Tab,
  save: SettingsVerbs['save'],
): Pick<SettingsVerbs, 'welcomeNext' | 'welcomeBack'> {
  return {
    async welcomeNext() {
      const screen = getState().settings?.screen;

      if (screen?.kind !== 'welcome' || screen.step === 3) {
        return;
      }

      const row = screen.step === 1 ? nameRow : keyRow;

      await save(row);

      // A step whose box the daemon refused stays, saying why at it.
      if (getState().settings?.problems.has(rowKey(row)) === true) {
        return;
      }

      apply(current => welcomeStepped(current, screen.step === 1 ? 2 : 3));
    },
    welcomeBack() {
      const screen = getState().settings?.screen;

      if (screen?.kind === 'welcome' && screen.step > 1) {
        apply(current => welcomeStepped(current, screen.step === 3 ? 2 : 1));
      }
    },
  };
}

export function createSettingsVerbs(tab: Tab): {
  readonly verbs: SettingsVerbs;
  /** Config moved, on this tab or another surface: what is open reads its views again, with what is typed kept. */
  readonly changed: () => Promise<void>;
  /** Every `ready`: what is open reads again; the first one judges the welcome, once per tab. */
  readonly ready: () => Promise<void>;
} {
  const {client, getState, apply} = tab;
  /** Reads, numbered as they begin, and the newest whose views have landed. */
  let reads = 0;
  let landed = 0;
  /** Each change has a ticket of its own; its end is known by it. */
  let changes = 0;
  /** Changes go one at a time, each against the views the one before it left. */
  let queue: Promise<void> = Promise.resolve();
  let welcomeJudged = false;

  const queued = (work: () => Promise<void>): Promise<void> =>
    (queue = queue.then(work, work));

  /** Every view: the home's and each character's in the roster now. */
  const read = async (): Promise<Read | undefined> => {
    const mine = (reads += 1);
    const targets: readonly ConfigTarget[] = [
      home,
      ...(getState().health?.characters ?? []).map(character =>
        characterTarget(character.id),
      ),
    ];

    try {
      const views = await Promise.all(
        targets.map(target => client.configView(target)),
      );

      return {
        mine,
        views: new Map(
          targets.map((target, at) => [targetKey(target), views[at]]),
        ) as ReadonlyMap<string, ConfigView>,
      };
    } catch (error: unknown) {
      if (mine === reads && getState().settings !== undefined) {
        apply(current => noticed(current, problem(error)));
      }

      return undefined;
    }
  };
  /**
   * Lands a read's views in one step with `alongside`. Views land in the
   * order their reads began: a read that settles after a later one's
   * views landed brings only `alongside`.
   */
  const land = (
    found: Read,
    alongside: (state: WebState) => WebState = state => state,
  ): void => {
    const lands = found.mine > landed;

    if (lands) {
      landed = found.mine;
    }

    apply(current =>
      lands ? viewsRead(alongside(current), found.views) : alongside(current),
    );
  };
  /** Whether `alongside` landed: a read that fails brings nothing, and is said. */
  const refresh = async (
    alongside?: (state: WebState) => WebState,
  ): Promise<boolean> => {
    const found = await read();

    if (found !== undefined) {
      land(found, alongside);
    }

    return found !== undefined;
  };
  const send = async (
    target: ConfigTarget,
    fingerprint: string,
    row: Row,
    value: JsonValue | undefined,
  ): Promise<ConfigChangeOutcome> => {
    try {
      return await client.applyConfigChange({
        target,
        expectedFingerprint: fingerprint,
        operation: operationFor(row.place, value),
      });
    } catch (error: unknown) {
      return {status: 'failed', message: problem(error)};
    }
  };
  /**
   * One change, bound to the fingerprint its view handed out. Someone
   * else saving first reads every view again, and the change goes once
   * more while its row holds what it held. Applied, the answer lands with
   * views read after it, so a row goes from what was clicked or typed to
   * what is saved, never back through the value from before.
   */
  const change = async (
    row: Row,
    value: JsonValue | undefined,
  ): Promise<void> => {
    const settings = getState().settings;
    const view =
      settings === undefined ? undefined : viewOf(settings, row.target);

    if (view === undefined) {
      return;
    }

    const ticket = (changes += 1);

    apply(current => changeSent(noticeSpent(current), ticket, row));

    let outcome = await send(row.target, view.fingerprint, row, value);

    if (outcome.status === 'refused' && outcome.reason === 'conflict') {
      const found = await read();
      const now = found?.views.get(targetKey(row.target));

      if (found === undefined) {
        apply(current => changeEnded(current, ticket, outcome));

        return;
      }

      let met: ReturnType<typeof conflictMet> = {
        state: getState(),
        again: false,
      };

      land(found, current => {
        met = conflictMet(current, ticket, now);

        return met.state;
      });

      if (!met.again || now?.status !== 'ok') {
        return;
      }

      outcome = await send(row.target, now.fingerprint, row, value);
    }

    const ended = (current: WebState): WebState =>
      changeEnded(current, ticket, outcome);
    const moved =
      outcome.status === 'applied' ||
      (outcome.status === 'refused' && outcome.reason === 'conflict');

    if (!moved || !(await refresh(ended))) {
      apply(ended);
    }
  };
  /** A box's edit, sent when its turn comes and it still differs from what the box held. */
  const save = (row: Row): Promise<void> =>
    queued(async () => {
      const settings = getState().settings;
      const sent =
        settings === undefined ? undefined : editToSend(settings, row);

      if (sent === undefined) {
        apply(current => editLetGo(current, row));

        return;
      }

      await change(row, sent.value);
    });

  /**
   * Back to the chat, from the window or the welcome, once the saves
   * already asked for have gone: a box left by the very click that
   * closes is saved, not let go with what is typed.
   */
  const close = (): void => {
    const closed = () => {
      apply(current => settingsClosed(noticeSpent(current)));
    };

    void queue.then(closed, closed);
  };

  return {
    verbs: {
      async openSettings(page) {
        apply(current => settingsOpened(noticeSpent(current), page));
        await refresh();
      },
      goTo(page) {
        apply(current => settingsOpened(noticeSpent(current), page));
      },
      closeSettings: close,
      edit(row, text) {
        apply(current => fieldEdited(current, row, text));
      },
      save,
      choose(row, value) {
        apply(current => fieldEdited(current, row, clickedText(value)));

        return queued(() => change(row, value));
      },
      amend(row, next) {
        return queued(async () => {
          const settings = getState().settings;
          const view =
            settings === undefined ? undefined : viewOf(settings, row.target);
          const field =
            view === undefined ? undefined : fieldAt(view, row.place);

          if (field !== undefined) {
            await change(row, next(field.effective.value));
          }
        });
      },
      setAdvanced(on) {
        remember(on);
        apply(current => advancedSet(current, on));
      },
      ...welcomeVerbs(tab, save),
      finishWelcome: close,
    },
    async changed() {
      if (getState().settings !== undefined) {
        await refresh();
      }
    },
    async ready() {
      if (getState().settings !== undefined) {
        await refresh();

        return;
      }

      // Judged once, on a view that was read: a reconnect must not bring
      // back a welcome the person left, and a read that failed is no
      // judgement, so the next ready tries again.
      if (welcomeJudged) {
        return;
      }

      const view = await client.configView(home).catch(() => undefined);

      if (view === undefined) {
        return;
      }

      welcomeJudged = true;
      apply(current => welcomeOpened(current, view));
    },
  };
}
