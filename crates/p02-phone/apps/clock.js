// The Clock: alarms, timers, a stopwatch and the time in other places.
//
// It keeps, in phone.storage: `alarms`, `timers`, `stopwatch` and `cities`;
// `recents`, the lengths of the last timers started, newest first; and
// `issued`, how many ids of each kind it has given, so that none is given
// twice. An alarm that is on, and a timer that is running, has one ring,
// under its own id.

export const manifest = {
  format: 'project02.app.v1',
  id: 'clock',
  name: 'Clock',
  summary: 'Alarms, timers, and the time anywhere',
  version: '1.0.0',
  icon: 'clock',
  tint: 'graphite',
  wakes: true,
  views: [
    {id: 'world', title: 'World Clock', icon: 'globe'},
    {id: 'alarms', title: 'Alarms', icon: 'alarm'},
    {id: 'stopwatch', title: 'Stopwatch', icon: 'stopwatch'},
    {id: 'timers', title: 'Timers', icon: 'timer'},
  ],
  opensOn: 'alarms',
  actions: [
    {
      name: 'set_alarm',
      description:
        'Set an alarm for a time of day, ringing once or on the days you give.',
      did: 'Set an alarm',
      view: 'alarms',
      input: {
        type: 'object',
        properties: {
          hour: {
            type: 'integer',
            minimum: 0,
            maximum: 23,
            description: 'On a 24-hour clock.',
          },
          minute: {type: 'integer', minimum: 0, maximum: 59},
          label: {
            type: 'string',
            maxLength: 60,
            description: 'What it is for, shown under its time.',
          },
          days: {
            type: 'array',
            items: {type: 'integer', minimum: 1, maximum: 7},
            uniqueItems: true,
            description:
              'The days it rings on, 1 (Monday) to 7 (Sunday); without them it rings once.',
          },
        },
        required: ['hour', 'minute'],
        additionalProperties: false,
      },
    },
    {
      name: 'change_alarm',
      description:
        "Change an alarm's time, label or days, or switch it on or off.",
      did: 'Changed an alarm',
      view: 'alarms',
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The alarm's id, as the Alarms view shows it.",
          },
          hour: {
            type: 'integer',
            minimum: 0,
            maximum: 23,
            description: 'On a 24-hour clock.',
          },
          minute: {type: 'integer', minimum: 0, maximum: 59},
          label: {
            type: 'string',
            maxLength: 60,
            description: 'What it is for; empty to take its label away.',
          },
          days: {
            type: 'array',
            items: {type: 'integer', minimum: 1, maximum: 7},
            uniqueItems: true,
            description:
              'The days it rings on, 1 (Monday) to 7 (Sunday); empty to make it ring once.',
          },
          on: {type: 'boolean', description: 'Whether it is switched on.'},
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_alarm',
      description: 'Delete an alarm.',
      did: 'Deleted an alarm',
      view: 'alarms',
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The alarm's id, as the Alarms view shows it.",
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'start_timer',
      description:
        'Start a timer counting down from the hours, minutes and seconds you give.',
      did: 'Started a timer',
      view: 'timers',
      input: {
        type: 'object',
        properties: {
          hours: {type: 'integer', minimum: 0},
          minutes: {type: 'integer', minimum: 0},
          seconds: {type: 'integer', minimum: 0},
          label: {
            type: 'string',
            maxLength: 60,
            description: 'What it is for.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'cancel_timer',
      description: 'Cancel a running timer.',
      did: 'Cancelled a timer',
      view: 'timers',
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The timer's id, as the Timers view shows it.",
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'start_stopwatch',
      description: 'Start the stopwatch, going on from the time it shows.',
      did: 'Started the stopwatch',
      view: 'stopwatch',
      input: {type: 'object', properties: {}, additionalProperties: false},
    },
    {
      name: 'stop_stopwatch',
      description: 'Stop the stopwatch, keeping its time.',
      did: 'Stopped the stopwatch',
      view: 'stopwatch',
      input: {type: 'object', properties: {}, additionalProperties: false},
    },
    {
      name: 'lap_stopwatch',
      description: 'Mark a lap on the running stopwatch.',
      did: 'Marked a lap',
      view: 'stopwatch',
      input: {type: 'object', properties: {}, additionalProperties: false},
    },
    {
      name: 'reset_stopwatch',
      description:
        'Stop the stopwatch and set it back to zero, clearing its laps.',
      did: 'Reset the stopwatch',
      view: 'stopwatch',
      input: {type: 'object', properties: {}, additionalProperties: false},
    },
    {
      name: 'add_city',
      description:
        'Add a city to your world clock, under the name you give it.',
      did: 'Added a city',
      view: 'world',
      input: {
        type: 'object',
        properties: {
          city: {type: 'string', minLength: 1, maxLength: 40},
          zone: {
            type: 'string',
            description: 'Its IANA time zone, such as Asia/Tokyo.',
          },
        },
        required: ['city', 'zone'],
        additionalProperties: false,
      },
    },
    {
      name: 'remove_city',
      description: 'Remove a city from your world clock.',
      did: 'Removed a city',
      view: 'world',
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The city's id, as the World Clock view shows it.",
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ],
};

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const REPEATS = {
  '': 'never',
  '1,2,3,4,5': 'weekdays',
  '6,7': 'weekends',
  '1,2,3,4,5,6,7': 'every day',
};
const RECENTS = 5;
const DAY = 24 * 60 * 60 * 1000;

export function screen(view) {
  const views = {
    world: worldClock,
    alarms: alarmList,
    stopwatch: stopwatchReadout,
    timers: timerReadouts,
  };

  return {items: views[view]()};
}

// A ring of the Clock's was told to her: an alarm that repeats sets its next
// ring, one that rings once switches itself off, and a timer is over.
export function rang({id}) {
  const alarm = items('alarms').find(kept => kept.id === id);

  if (alarm === undefined) {
    drop('timers', id);
  } else if (alarm.days.length === 0) {
    keep('alarms', {...alarm, on: false});
  } else {
    setRing(alarm);
  }
}

export function set_alarm({hour, minute, label, days = []}) {
  const alarm = {
    id: issue('a'),
    hour,
    minute,
    label: label || undefined,
    days: inOrder(days),
    on: true,
  };

  keep('alarms', alarm);
  setRing(alarm);
  return alarmAnswer(alarm);
}

export function change_alarm({id, hour, minute, label, days, on}) {
  const alarm = found('alarms', id, 'alarm');
  const changed = {
    ...alarm,
    hour: hour ?? alarm.hour,
    minute: minute ?? alarm.minute,
    label: label === undefined ? alarm.label : label || undefined,
    days: days === undefined ? alarm.days : inOrder(days),
    on: on ?? alarm.on,
  };

  keep('alarms', changed);
  setRing(changed);
  return alarmAnswer(changed);
}

export function delete_alarm({id}) {
  const alarm = found('alarms', id, 'alarm');

  drop('alarms', id);
  phone.rings.cancel(id);
  return {...aboutAlarm(alarm), deleted: true};
}

export function start_timer({hours = 0, minutes = 0, seconds = 0, label}) {
  const length = ((hours * 60 + minutes) * 60 + seconds) * 1000;

  if (length === 0) {
    throw new Error(
      'A timer needs a length: give it hours, minutes or seconds.',
    );
  }

  const timer = {
    id: issue('t'),
    label: label || undefined,
    length,
    ends: phone.time.now() + length,
  };
  const recents = items('recents').filter(kept => kept !== length);

  keep('timers', timer);
  phone.storage.set('recents', [length, ...recents].slice(0, RECENTS));
  phone.rings.set({
    id: timer.id,
    at: timer.ends,
    title: 'Timer',
    body: timerName(timer),
  });
  return {...aboutTimer(timer), ends: clockTime(phone.time.local(timer.ends))};
}

export function cancel_timer({id}) {
  const timer = found('timers', id, 'timer');

  drop('timers', id);
  phone.rings.cancel(id);
  return {...aboutTimer(timer), cancelled: true};
}

export function start_stopwatch() {
  const watch = stopwatch();

  if (watch.started !== undefined) {
    throw new Error('The stopwatch is already running.');
  }

  phone.storage.set('stopwatch', {...watch, started: phone.time.now()});
  return {running: true, time: stopwatchTime(watch.elapsed)};
}

export function stop_stopwatch() {
  const watch = running();
  const elapsed = timeOn(watch);

  phone.storage.set('stopwatch', {elapsed, laps: watch.laps});
  return {running: false, time: stopwatchTime(elapsed)};
}

export function lap_stopwatch() {
  const watch = running();
  const elapsed = timeOn(watch);
  const lap = elapsed - watch.laps.reduce((sum, kept) => sum + kept, 0);

  phone.storage.set('stopwatch', {...watch, laps: [...watch.laps, lap]});
  return {
    running: true,
    time: stopwatchTime(elapsed),
    lap: watch.laps.length + 1,
    length: stopwatchTime(lap),
  };
}

export function reset_stopwatch() {
  phone.storage.remove('stopwatch');
  return {running: false, time: stopwatchTime(0)};
}

export function add_city({city, zone}) {
  const added = {id: issue('c'), city, zone: clockIn(zone).zone};

  keep('cities', added);
  return {...added, ...cityClock(added, phone.time.local())};
}

export function remove_city({id}) {
  const city = found('cities', id, 'city');

  drop('cities', id);
  return {...city, removed: true};
}

function alarmList() {
  const rows = items('alarms')
    .toSorted((one, other) => minuteOfDay(one) - minuteOfDay(other))
    .map(alarm => ({
      id: alarm.id,
      time: clockTime(alarm),
      subtitle: subtitle(alarm),
      switch: alarm.on,
    }));

  return rows.length > 0 ? [{kind: 'list', rows}] : nothing('No Alarms');
}

function worldClock() {
  const here = phone.time.local();
  const rows = items('cities').map(city => {
    const {time, offset} = cityClock(city, here);

    return {id: city.id, caption: offset, title: city.city, time};
  });

  return rows.length > 0 ? [{kind: 'list', rows}] : nothing('No World Clocks');
}

function stopwatchReadout() {
  const watch = stopwatch();
  const runs = watch.started !== undefined;
  const readout = {
    kind: 'readout',
    text: stopwatchTime(timeOn(watch)),
    caption: runs ? 'Running' : 'Not running',
    live: runs
      ? {counts: 'up', from: watch.started - watch.elapsed}
      : undefined,
  };
  const laps = watch.laps.map((lap, index) => ({
    title: `Lap ${index + 1}`,
    value: stopwatchTime(lap),
  }));

  return laps.length > 0
    ? [readout, {kind: 'list', header: 'Laps', rows: laps.reverse()}]
    : [readout];
}

function timerReadouts() {
  const now = phone.time.now();
  const readouts = items('timers')
    .toSorted((one, other) => one.ends - other.ends)
    .map(timer => ({
      kind: 'readout',
      id: timer.id,
      label: timerName(timer),
      text: timerTime(Math.max(timer.ends - now, 0)),
      caption: `Ends ${clockTime(phone.time.local(timer.ends))}`,
      live: {counts: 'down', to: timer.ends, of: timer.length},
    }));
  const recents = items('recents').map(length => ({
    time: timerTime(length),
    subtitle: inWords(length),
  }));
  const shown =
    recents.length > 0
      ? [...readouts, {kind: 'list', header: 'Recents', rows: recents}]
      : readouts;

  return shown.length > 0 ? shown : nothing('No Timers');
}

// What a view with nothing in it shows.
function nothing(text) {
  return [{kind: 'text', text}];
}

// Sets the ring of an alarm that is on for its next time, and takes away
// the ring of one that is off.
function setRing(alarm) {
  if (!alarm.on) {
    phone.rings.cancel(alarm.id);
    return;
  }

  phone.rings.set({
    id: alarm.id,
    at: phone.time.next({
      hour: alarm.hour,
      minute: alarm.minute,
      weekdays: alarm.days.length > 0 ? alarm.days : undefined,
    }),
    title: 'Alarm',
    body: alarm.label,
  });
}

function aboutAlarm(alarm) {
  return {
    id: alarm.id,
    time: clockTime(alarm),
    label: alarm.label,
    repeats: repeats(alarm),
  };
}

function alarmAnswer(alarm) {
  const ring = ringOf(alarm);

  return {
    ...aboutAlarm(alarm),
    on: alarm.on,
    rings: ring === undefined ? undefined : when(ring.at),
  };
}

// Under an alarm's time: its label, then when it rings.
function subtitle(alarm) {
  const label = alarm.label ?? 'Alarm';
  const ring = ringOf(alarm);

  if (alarm.days.length > 0) {
    return `${label}, ${repeats(alarm)}`;
  }
  return ring === undefined ? label : `${label}, ${when(ring.at)}`;
}

// Days of the week, 1 (Monday) to 7 (Sunday), in the week's order.
function inOrder(days) {
  return days.toSorted((one, other) => one - other);
}

// The days an alarm rings on, in words: never, weekdays, every Monday, or
// Mon Wed Fri.
function repeats({days}) {
  if (days.length === 1) {
    return `every ${WEEKDAYS[days[0] - 1]}`;
  }
  return (
    REPEATS[days.join()] ??
    days.map(day => WEEKDAYS[day - 1].slice(0, 3)).join(' ')
  );
}

function ringOf(alarm) {
  return phone.rings.list().find(ring => ring.id === alarm.id);
}

// When a moment comes, from where the person is: today, tomorrow, or its
// weekday.
function when(at) {
  const then = phone.time.local(at);
  const ahead = dayNumber(then) - dayNumber(phone.time.local());
  const weekday = WEEKDAYS[then.weekday - 1];

  if (ahead === 0) {
    return 'today';
  }
  if (ahead === 1) {
    return 'tomorrow';
  }
  return ahead === 7 ? `next ${weekday}` : weekday;
}

function aboutTimer(timer) {
  return {id: timer.id, label: timer.label, length: inWords(timer.length)};
}

// What a timer is called: its label, or its length in words.
function timerName(timer) {
  return timer.label ?? inWords(timer.length);
}

// The stopwatch: the time it ran before it was last started, the moment it
// was started while it runs, and the lengths of its laps, oldest first.
function stopwatch() {
  return phone.storage.get('stopwatch') ?? {elapsed: 0, laps: []};
}

function running() {
  const watch = stopwatch();

  if (watch.started === undefined) {
    throw new Error('The stopwatch is not running.');
  }
  return watch;
}

// The time on the stopwatch now.
function timeOn(watch) {
  return watch.started === undefined
    ? watch.elapsed
    : watch.elapsed + phone.time.now() - watch.started;
}

// A city's clock beside the person's own, `here`: the time there, and its
// offset, the day there and the hours between, Tomorrow, +17HRS.
function cityClock(city, here) {
  const there = phone.time.local(phone.time.now(), city.zone);
  const ahead = dayNumber(there) - dayNumber(here);
  const day = ahead > 0 ? 'Tomorrow' : ahead < 0 ? 'Yesterday' : 'Today';
  const minutes = there.offsetMinutes - here.offsetMinutes;
  const apart = Math.abs(minutes);
  const hours =
    apart % 60 === 0
      ? `${apart / 60}`
      : `${Math.floor(apart / 60)}:${pad(apart % 60)}`;

  return {
    time: clockTime(there),
    offset: `${day}, ${minutes < 0 ? '-' : '+'}${hours}HRS`,
  };
}

// What a clock in `zone` reads now, or a refusal when the phone knows no
// such zone.
function clockIn(zone) {
  try {
    return phone.time.local(phone.time.now(), zone);
  } catch {
    throw new Error(
      `The phone knows no time zone "${zone}": give an IANA name, such as "Asia/Tokyo".`,
    );
  }
}

// A list the Clock keeps under `key`, empty before it keeps one.
function items(key) {
  return phone.storage.get(key) ?? [];
}

// The item of the list under `key` with `id`, or a refusal naming the
// `kind` of thing that is not there.
function found(key, id, kind) {
  const item = items(key).find(kept => kept.id === id);

  if (item === undefined) {
    throw new Error(`There is no ${kind} with the id "${id}".`);
  }
  return item;
}

// Keeps `item` in the list under `key`, in place of the one with its id, or
// after the rest when it is new.
function keep(key, item) {
  const kept = items(key);
  const index = kept.findIndex(other => other.id === item.id);
  const changed = index === -1 ? [...kept, item] : kept.with(index, item);

  phone.storage.set(key, changed);
}

function drop(key, id) {
  const left = items(key).filter(item => item.id !== id);

  phone.storage.set(key, left);
}

// A new id of `kind`, a letter: a1, a2, then t1 for another kind.
function issue(kind) {
  const issued = phone.storage.get('issued') ?? {};
  const count = (issued[kind] ?? 0) + 1;

  phone.storage.set('issued', {...issued, [kind]: count});
  return `${kind}${count}`;
}

function minuteOfDay({hour, minute}) {
  return hour * 60 + minute;
}

// The days since the epoch of a clock's reading, to count the days between
// two.
function dayNumber({year, month, day}) {
  return Date.UTC(year, month - 1, day) / DAY;
}

// A time of day as a clock shows it: 7:00 AM.
function clockTime({hour, minute}) {
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

// A length of time as a timer shows it, 5:00 or 1:30:00, part of a second
// shown as a whole one, as a timer counting down shows it.
function timerTime(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}

// A length of time in words: 5 min, 1 hr 30 min.
function inWords(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  const parts = [
    [Math.floor(seconds / 3600), 'hr'],
    [Math.floor(seconds / 60) % 60, 'min'],
    [seconds % 60, 'sec'],
  ];

  return parts
    .filter(([count]) => count > 0)
    .map(([count, unit]) => `${count} ${unit}`)
    .join(' ');
}

// A stopwatch's time in minutes, seconds and hundredths, 00:12.34, with its
// hours ahead once it has them.
function stopwatchTime(milliseconds) {
  const hundredths = Math.floor(milliseconds / 10);
  const hours = Math.floor(hundredths / 360000);
  const minutes = Math.floor(hundredths / 6000) % 60;
  const seconds = Math.floor(hundredths / 100) % 60;
  const time = `${pad(minutes)}:${pad(seconds)}.${pad(hundredths % 100)}`;

  return hours > 0 ? `${hours}:${time}` : time;
}

function pad(number) {
  return String(number).padStart(2, '0');
}
