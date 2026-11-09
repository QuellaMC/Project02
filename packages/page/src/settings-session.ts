/**
 * The settings verbs a page calls, over the tab's one client: every view
 * and every outcome passes through the settings rules, and the page reads
 * the store. Browser-only like session.ts; the browser suite is its cover.
 */
import type {
  ConfigChangeOutcome,
  ConfigTarget,
  ConfigView,
} from '@project02/wire/contract';
import type {GatewayClient} from '@project02/wire/client';
import {
  changeEnded,
  changeSent,
  configViewRead,
  fieldEdited,
  operationFor,
  sameTarget,
  settingsClosed,
  settingsOpened,
  setupNeeded,
} from './settings.ts';
import {noticeSpent, noticed, type WebState} from './store.ts';

export type SettingsVerbs = {
  readonly openSettings: (target: ConfigTarget) => Promise<void>;
  readonly closeSettings: () => void;
  readonly editSetting: (key: string, text: string) => void;
  /** Sends what is typed in the row as one change. */
  readonly saveSetting: (key: string) => Promise<void>;
  /** Unsets the row, so it inherits again. */
  readonly resetSetting: (key: string) => Promise<void>;
};

/** An address that can never work has no settings to change. */
export const noSettingsVerbs: SettingsVerbs = {
  openSettings: () => Promise.resolve(),
  closeSettings: () => undefined,
  editSetting: () => undefined,
  saveSetting: () => Promise.resolve(),
  resetSetting: () => Promise.resolve(),
};

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSettingsVerbs(tab: {
  readonly client: GatewayClient;
  readonly getState: () => WebState;
  readonly apply: (reduce: (state: WebState) => WebState) => void;
}): {
  readonly verbs: SettingsVerbs;
  /** Config moved, on this tab or another surface: a screen open reads its view again, with what is typed kept. */
  readonly changed: () => Promise<void>;
  /** Every `ready`: a screen open re-reads its view; the first one judges the setup frame, once per tab. */
  readonly ready: () => Promise<void>;
} {
  const {client, getState, apply} = tab;
  /** Reads of the screen, numbered as they begin, and the newest whose view has landed. */
  let reads = 0;
  let landed = 0;
  /** Each change has a ticket of its own; its end is known by it. */
  let changes = 0;
  let setupJudged = false;
  /** Whether the settings screen open is the one on the target. */
  const isOpen = (target: ConfigTarget): boolean => {
    const open = getState().settings;

    return open !== undefined && sameTarget(open.target, target);
  };
  /**
   * Reads the screen's view and lands it in one step with `alongside`.
   * Views land in the order their reads began: one that settles after a
   * later read's view has landed brings only `alongside`. Whether
   * `alongside` landed: a read that fails brings nothing, and is said
   * unless a later one is on its way or its screen was left.
   */
  const readView = async (
    target: ConfigTarget,
    alongside: (state: WebState) => WebState = state => state,
  ): Promise<boolean> => {
    const mine = (reads += 1);
    let view: ConfigView;

    try {
      view = await client.configView(target);
    } catch (error: unknown) {
      if (mine === reads && isOpen(target)) {
        apply(current => noticed(current, problem(error)));
      }

      return false;
    }

    const lands = mine > landed;

    if (lands) {
      landed = mine;
    }

    apply(current =>
      lands
        ? configViewRead(alongside(current), target, view)
        : alongside(current),
    );

    return true;
  };
  /**
   * One change, bound to the fingerprint the view handed out. Applied or
   * met with a conflict, the view is read again — a write can move more
   * than its field, and a conflict means the screen was stale — and the
   * answer lands with that view, so a row goes from what was typed to
   * what is saved, never back through the value from before. A read that
   * fails is said, and the answer lands alone: the next change on the
   * stream reads the screen again.
   */
  const change = async (
    key: string,
    text: string | undefined,
  ): Promise<void> => {
    const page = getState().settings;

    if (page?.view?.status !== 'ok') {
      return;
    }

    const operation = operationFor(page.view, key, text);

    if (operation === undefined) {
      return;
    }

    const ticket = (changes += 1);

    apply(current => changeSent(noticeSpent(current), ticket, key));

    let outcome: ConfigChangeOutcome;

    try {
      outcome = await client.applyConfigChange({
        target: page.target,
        expectedFingerprint: page.view.fingerprint,
        operation,
      });
    } catch (error: unknown) {
      outcome = {status: 'failed', message: problem(error)};
    }

    const ended = (current: WebState): WebState =>
      changeEnded(current, ticket, outcome);

    // The screen the change came from is read again, if it is still the
    // one open — at once, on the answer in hand, whether or not the frame
    // that follows reaches this tab's stream. The roster needs no read:
    // what the change did to it comes on the stream, to every tab.
    const moved =
      outcome.status === 'applied' ||
      (outcome.status === 'refused' && outcome.reason === 'conflict');

    if (
      !moved ||
      !isOpen(page.target) ||
      !(await readView(page.target, ended))
    ) {
      apply(ended);
    }
  };

  const changed = async (): Promise<void> => {
    const page = getState().settings;

    if (page !== undefined) {
      await readView(page.target);
    }
  };

  return {
    verbs: {
      async openSettings(target) {
        apply(current => settingsOpened(noticeSpent(current), target));
        await readView(target);
      },
      closeSettings() {
        apply(current => settingsClosed(noticeSpent(current)));
      },
      editSetting(key, text) {
        apply(current => fieldEdited(current, key, text));
      },
      saveSetting(key) {
        return change(key, getState().settings?.edits.get(key));
      },
      resetSetting(key) {
        return change(key, undefined);
      },
    },
    changed,
    async ready() {
      if (getState().settings !== undefined) {
        await changed();

        return;
      }

      // Judged once, on a view that was read: a reconnect must not bounce
      // a person who left the frame, and a read that failed is no
      // judgement, so the next ready tries again.
      if (setupJudged) {
        return;
      }

      const target: ConfigTarget = {scope: 'global'};
      const view = await client.configView(target).catch(() => undefined);

      if (view === undefined) {
        return;
      }

      setupJudged = true;

      // Not over a screen the person opened while the view was on its way.
      if (setupNeeded(view) && getState().settings === undefined) {
        apply(current =>
          configViewRead(settingsOpened(current, target, true), target, view),
        );
      }
    },
  };
}
