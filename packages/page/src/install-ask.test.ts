import {describe, expect, it} from 'vitest';

import type {JsonValue} from '@project02/wire/contract';
import {installAskOf, installSentence} from './install-ask.ts';

const reminders = {
  id: 'reminders',
  name: 'Reminders',
  summary: 'Things to do, on a day and time',
  icon: 'list',
  tint: 'orange',
  version: '1.1.0',
  wakes: true,
};

/** The preview of her ask to install Reminders, as her phone prepares it, with `changes` made to it. */
function preview(
  changes: Readonly<Record<string, JsonValue>> = {},
): Readonly<Record<string, JsonValue>> {
  return {
    kind: 'phone_app_install',
    app: reminders,
    source: 'catalog',
    ...changes,
  };
}

/** The card's sentence for the ask `changes` make of Reminders'. */
function sentenceOf(changes?: Readonly<Record<string, JsonValue>>): string {
  const ask = installAskOf(preview(changes));

  if (ask === undefined) {
    throw new Error('The preview reads as no ask.');
  }

  return installSentence(ask);
}

describe('her ask to install an app', () => {
  it('reads the app she asks for, and says in a sentence where it comes from and what it does, waking her or not, and that it is an update from the version on her phone when it replaces one', () => {
    expect(installAskOf(preview())).toEqual({
      app: {id: 'reminders', name: 'Reminders', wakes: true},
    });
    expect(sentenceOf()).toBe(
      'From the App Store, reviewed by Project02. It keeps its own data and can wake her up.',
    );
    expect(sentenceOf({app: {...reminders, wakes: false}})).toBe(
      'From the App Store, reviewed by Project02. It keeps its own data.',
    );
    expect(sentenceOf({replaces: '1.0.0'})).toBe(
      'From the App Store, reviewed by Project02. It keeps its own data and can wake her up. It is an update from version 1.0.0.',
    );
  });

  it('reads none from the preview of anything else, of an app from anywhere but the App Store, or of an app it cannot read', () => {
    for (const unread of [
      {fieldName: 'tone', value: 'warm'},
      preview({source: 'file'}),
      preview({app: 'reminders'}),
      preview({app: ['reminders']}),
      preview({app: {id: 'reminders', name: 'Reminders'}}),
      preview({replaces: 1}),
    ]) {
      expect(installAskOf(unread)).toBeUndefined();
    }
  });
});
