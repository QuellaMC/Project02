import { ContractValidationError } from './errors.ts';

export type ValueRecord = Record<string, unknown>;

export function asRecord(value: unknown, fieldName: string): ValueRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractValidationError(`${fieldName} must be a mapping.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(`${fieldName} must be a mapping.`);
  }
  return value as ValueRecord;
}

export function getOwnField(value: ValueRecord, fieldName: string): unknown {
  if (!Object.hasOwn(value, fieldName)) {
    return undefined;
  }
  return value[fieldName];
}

export function rejectExtraKeys(
  value: ValueRecord,
  allowedKeys: readonly string[],
  sourceName: string
): void {
  const allowed = new Set(allowedKeys);
  const extraKeys = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (extraKeys.length > 0) {
    throw new ContractValidationError(
      `${sourceName} contains extra field(s): ${extraKeys.join(', ')}.`
    );
  }
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractValidationError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

export function requireOptionalString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new ContractValidationError(`${fieldName} must be a string.`);
  }
  return value;
}

export function requireLiteral<const Expected extends string>(
  value: unknown,
  expected: Expected,
  fieldName: string
): Expected {
  if (value !== expected) {
    throw new ContractValidationError(`${fieldName} must be ${JSON.stringify(expected)}.`);
  }
  return expected;
}

export function requireOneOf<const Values extends readonly string[]>(
  value: unknown,
  allowedValues: Values,
  fieldName: string
): Values[number] {
  const normalized = requireString(value, fieldName);
  if (!allowedValues.includes(normalized)) {
    throw new ContractValidationError(
      `${fieldName} must be one of: ${[...allowedValues].sort().join(', ')}.`
    );
  }
  return normalized;
}

export function validateRemainingSeconds(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ContractValidationError(`${fieldName} must be a non-negative number.`);
  }
  return value;
}

export function validateIso8601Timestamp(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  const stripped = value.trim();
  if (
    value !== stripped ||
    stripped.length === 0 ||
    !hasDatetimeComponent(stripped) ||
    !isValidIsoDatetime(stripped)
  ) {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  return value;
}

export function parseIso8601TimestampToUtcMicroseconds(
  value: string,
  fieldName: string
): bigint {
  const timestamp = validateIso8601Timestamp(value, fieldName);
  const parts = splitDatetime(timestamp);
  if (parts === null) {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  const dateOrdinal = parseIsoDateOrdinal(parts.date, fieldName);
  const timeParts = parseIsoTimeParts(parts.time, fieldName);
  return (
    BigInt(dateOrdinal - ordinalOfDate(1970, 1, 1)) * 86_400_000_000n +
    BigInt(timeParts.clockMicroseconds) -
    BigInt(timeParts.offsetMicroseconds)
  );
}

export function requireMatchingIdentity(
  value: unknown,
  expected: string,
  fieldName: string
): void {
  if (value !== expected) {
    throw new ContractValidationError(
      `${fieldName} must match source_event.${fieldName}.`,
      'identity_mismatch'
    );
  }
}

function hasDatetimeComponent(value: string): boolean {
  return splitDatetime(value) !== null;
}

function isValidIsoDatetime(value: string): boolean {
  const parts = splitDatetime(value);
  if (parts === null) {
    return false;
  }
  const dateIsValid = isValidIsoDate(parts.date);
  const timeIsValid = isValidIsoTime(parts.time);
  return dateIsValid && timeIsValid;
}

function splitDatetime(value: string): { date: string; time: string } | null {
  const separatorIndex = firstSeparatorIndex(value);
  if (separatorIndex >= 0) {
    return {
      date: value.slice(0, separatorIndex),
      time: value.slice(separatorIndex + 1)
    };
  }
  return null;
}

function firstSeparatorIndex(value: string): number {
  const upperT = value.indexOf('T');
  const lowerT = value.indexOf('t');
  const space = value.length > 10 && /\s/.test(value[10] ?? '') ? 10 : -1;
  return (
    [upperT, lowerT, space]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1
  );
}

function isValidIsoDate(value: string): boolean {
  const calendar =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(value)?.groups ??
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})$/.exec(value)?.groups;
  if (calendar !== undefined) {
    const year = parseDecimal(calendar['year']);
    const month = parseDecimal(calendar['month']);
    const day = parseDecimal(calendar['day']);
    return (
      isValidIsoYear(year) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month)
    );
  }

  const week =
    /^(?<year>\d{4})-W(?<week>\d{2})(?:-(?<weekday>\d))?$/.exec(value)?.groups ??
    /^(?<year>\d{4})W(?<week>\d{2})(?<weekday>\d)?$/.exec(value)?.groups;
  if (week === undefined) {
    return false;
  }
  const year = parseDecimal(week['year']);
  const weekNumber = parseDecimal(week['week']);
  const weekday = week['weekday'] === undefined ? 1 : parseDecimal(week['weekday']);
  return (
    isValidIsoYear(year) &&
    weekday >= 1 &&
    weekday <= 7 &&
    weekNumber >= 1 &&
    weekNumber <= isoWeeksInYear(year) &&
    isSupportedIsoWeekDate(year, weekNumber, weekday)
  );
}

function parseIsoDateOrdinal(value: string, fieldName: string): number {
  const calendar =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(value)?.groups ??
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})$/.exec(value)?.groups;
  if (calendar !== undefined) {
    const year = parseDecimal(calendar['year']);
    const month = parseDecimal(calendar['month']);
    const day = parseDecimal(calendar['day']);
    if (
      isValidIsoYear(year) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month)
    ) {
      return ordinalOfDate(year, month, day);
    }
  }

  const week =
    /^(?<year>\d{4})-W(?<week>\d{2})(?:-(?<weekday>\d))?$/.exec(value)?.groups ??
    /^(?<year>\d{4})W(?<week>\d{2})(?<weekday>\d)?$/.exec(value)?.groups;
  if (week !== undefined) {
    const year = parseDecimal(week['year']);
    const weekNumber = parseDecimal(week['week']);
    const weekday = week['weekday'] === undefined ? 1 : parseDecimal(week['weekday']);
    if (
      isValidIsoYear(year) &&
      weekday >= 1 &&
      weekday <= 7 &&
      weekNumber >= 1 &&
      weekNumber <= isoWeeksInYear(year) &&
      isSupportedIsoWeekDate(year, weekNumber, weekday)
    ) {
      const jan4Ordinal = ordinalOfDate(year, 1, 4);
      const weekOneMonday = jan4Ordinal - (isoWeekday(year, 1, 4) - 1);
      return weekOneMonday + (weekNumber - 1) * 7 + (weekday - 1);
    }
  }

  throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
}

function isValidIsoTime(value: string): boolean {
  const parts = splitTimeAndOffset(value);
  if (parts === null || !isValidClock(parts.clock)) {
    return false;
  }
  return parts.offset === undefined || isValidTimezoneOffset(parts.offset);
}

function splitTimeAndOffset(value: string): { clock: string; offset?: string } | null {
  if (value.endsWith('Z')) {
    const clock = value.slice(0, -1);
    if (clock.includes('Z') || clock.length === 0) {
      return null;
    }
    return { clock, offset: 'Z' };
  }
  if (value.includes('Z')) {
    return null;
  }

  const plusIndex = value.indexOf('+');
  const minusIndex = value.indexOf('-');
  const offsetIndex =
    plusIndex < 0 ? minusIndex : minusIndex < 0 ? plusIndex : Math.min(plusIndex, minusIndex);
  if (offsetIndex < 0) {
    return { clock: value };
  }
  if (offsetIndex === 0) {
    return null;
  }
  return {
    clock: value.slice(0, offsetIndex),
    offset: value.slice(offsetIndex)
  };
}

function parseIsoTimeParts(
  value: string,
  fieldName: string
): { clockMicroseconds: number; offsetMicroseconds: number } {
  const parts = splitTimeAndOffset(value);
  if (parts === null || !isValidClock(parts.clock)) {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  return {
    clockMicroseconds: parseClockMicroseconds(parts.clock, fieldName),
    offsetMicroseconds:
      parts.offset === undefined ? 0 : parseTimezoneOffsetMicroseconds(parts.offset, fieldName)
  };
}

function parseClockMicroseconds(value: string, fieldName: string): number {
  const parts = splitTrailingFraction(value);
  const clock = parts.main;
  let hour: number;
  let minute: number;
  let second: number;

  if (clock.includes(':')) {
    const clockParts = clock.split(':');
    if (
      clockParts.length < 1 ||
      clockParts.length > 3 ||
      clockParts.some((part) => !/^\d{2}$/.test(part))
    ) {
      throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
    }
    hour = parseDecimal(clockParts[0]);
    minute = clockParts[1] === undefined ? 0 : parseDecimal(clockParts[1]);
    second = clockParts[2] === undefined ? 0 : parseDecimal(clockParts[2]);
  } else {
    if (!/^\d{2}(?:\d{2})?(?:\d{2})?$/.test(clock)) {
      throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
    }
    hour = parseDecimal(clock.slice(0, 2));
    minute = clock.length >= 4 ? parseDecimal(clock.slice(2, 4)) : 0;
    second = clock.length === 6 ? parseDecimal(clock.slice(4, 6)) : 0;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  return ((hour * 60 + minute) * 60 + second) * 1_000_000 + parts.microseconds;
}

function parseTimezoneOffsetMicroseconds(value: string, fieldName: string): number {
  if (value === 'Z') {
    return 0;
  }
  const sign = value[0];
  if (sign !== '+' && sign !== '-') {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  const parts = splitTrailingFraction(value.slice(1));
  const body = parts.main;
  let hour: number;
  let minute: number;
  let second: number;

  if (body.includes(':')) {
    const offsetParts = body.split(':');
    if (
      offsetParts.length < 1 ||
      offsetParts.length > 3 ||
      offsetParts.some((part) => !/^\d{2}$/.test(part))
    ) {
      throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
    }
    hour = parseDecimal(offsetParts[0]);
    minute = offsetParts[1] === undefined ? 0 : parseDecimal(offsetParts[1]);
    second = offsetParts[2] === undefined ? 0 : parseDecimal(offsetParts[2]);
  } else {
    if (!/^\d{2}(?:\d{2})?(?:\d{2})?$/.test(body)) {
      throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
    }
    hour = parseDecimal(body.slice(0, 2));
    minute = body.length >= 4 ? parseDecimal(body.slice(2, 4)) : 0;
    second = body.length === 6 ? parseDecimal(body.slice(4, 6)) : 0;
  }

  const totalMicroseconds = ((hour * 60 + minute) * 60 + second) * 1_000_000 + parts.microseconds;
  if (totalMicroseconds >= 86_400_000_000) {
    throw new ContractValidationError(`${fieldName} must be an ISO-8601 timestamp string.`);
  }
  return sign === '-' ? -totalMicroseconds : totalMicroseconds;
}

function splitTrailingFraction(value: string): { main: string; microseconds: number } {
  const match = /^(?<main>.*?)[.,](?<fraction>\d+)$/.exec(value);
  if (match?.groups === undefined) {
    return { main: value, microseconds: 0 };
  }
  const fraction = (match.groups['fraction'] ?? '').slice(0, 6).padEnd(6, '0');
  return {
    main: match.groups['main'] ?? '',
    microseconds: parseDecimal(fraction)
  };
}

function isValidClock(value: string): boolean {
  const clock = stripFraction(value);
  let hour: number;
  let minute: number;
  let second: number;

  if (clock.includes(':')) {
    const parts = clock.split(':');
    if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d{2}$/.test(part))) {
      return false;
    }
    hour = parseDecimal(parts[0]);
    minute = parts[1] === undefined ? 0 : parseDecimal(parts[1]);
    second = parts[2] === undefined ? 0 : parseDecimal(parts[2]);
  } else {
    if (!/^\d{2}(?:\d{2})?(?:\d{2})?$/.test(clock)) {
      return false;
    }
    hour = parseDecimal(clock.slice(0, 2));
    minute = clock.length >= 4 ? parseDecimal(clock.slice(2, 4)) : 0;
    second = clock.length === 6 ? parseDecimal(clock.slice(4, 6)) : 0;
  }
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function isValidTimezoneOffset(value: string): boolean {
  if (value === 'Z') {
    return true;
  }
  const sign = value[0];
  if (sign !== '+' && sign !== '-') {
    return false;
  }
  const body = stripFraction(value.slice(1));
  let hour: number;
  let minute: number;
  let second: number;

  if (body.includes(':')) {
    const parts = body.split(':');
    if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d{2}$/.test(part))) {
      return false;
    }
    hour = parseDecimal(parts[0]);
    minute = parts[1] === undefined ? 0 : parseDecimal(parts[1]);
    second = parts[2] === undefined ? 0 : parseDecimal(parts[2]);
  } else {
    if (!/^\d{2}(?:\d{2})?(?:\d{2})?$/.test(body)) {
      return false;
    }
    hour = parseDecimal(body.slice(0, 2));
    minute = body.length >= 4 ? parseDecimal(body.slice(2, 4)) : 0;
    second = body.length === 6 ? parseDecimal(body.slice(4, 6)) : 0;
  }

  const totalSeconds = hour * 3600 + minute * 60 + second;
  return totalSeconds < 24 * 3600;
}

function stripFraction(value: string): string {
  return value.replace(/[.,]\d+$/, '');
}

function parseDecimal(value: string | undefined): number {
  if (value === undefined) {
    return Number.NaN;
  }
  return Number.parseInt(value, 10);
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ] ?? 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidIsoYear(year: number): boolean {
  return year >= 1 && year <= 9999;
}

function isoWeeksInYear(year: number): number {
  const jan1Weekday = isoWeekday(year, 1, 1);
  return jan1Weekday === 4 || (jan1Weekday === 3 && isLeapYear(year)) ? 53 : 52;
}

function isSupportedIsoWeekDate(year: number, week: number, weekday: number): boolean {
  const jan4Ordinal = ordinalOfDate(year, 1, 4);
  const weekOneMonday = jan4Ordinal - (isoWeekday(year, 1, 4) - 1);
  const resolvedOrdinal = weekOneMonday + (week - 1) * 7 + (weekday - 1);
  return resolvedOrdinal >= 1 && resolvedOrdinal <= ordinalOfDate(9999, 12, 31);
}

function isoWeekday(year: number, month: number, day: number): number {
  return ((ordinalOfDate(year, month, day) - 1) % 7) + 1;
}

function ordinalOfDate(year: number, month: number, day: number): number {
  let ordinal = daysBeforeYear(year) + day;
  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) {
    ordinal += daysInMonth(year, currentMonth);
  }
  return ordinal;
}

function daysBeforeYear(year: number): number {
  const previousYear = year - 1;
  return (
    previousYear * 365 +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400)
  );
}
