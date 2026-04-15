/**
 * Lightweight cron parser for Cloudflare Workers.
 * No Node.js dependencies — pure Date math + Intl for timezone support.
 *
 * Supports 5-field cron: minute hour day-of-month month day-of-week
 * Field syntax: * (any), N (exact), N-M (range), N/S (step), asterisk/S (step from 0), N,M (list)
 * Day-of-week: 0=Sun..6=Sat (7 also accepted as Sun). Named: MON-FRI, SUN-SAT.
 * Month: 1-12 or JAN-DEC.
 */

const INTERVAL_PATTERN = /^(\d+)(m|h)$/;
const MIN_INTERVAL_MINUTES = 1;

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

interface DateFields {
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
}

/**
 * Compute the next fire time for a cron expression.
 * Accepts either a 5-field cron string or an interval shorthand ("30m", "2h").
 *
 * @param timezone - IANA timezone (e.g., "America/New_York"). Cron fields are
 *   evaluated against wall-clock time in this timezone. The returned Date is UTC.
 *   When omitted, cron fields are evaluated against UTC.
 */
export function nextFireTime(cron: string, from?: Date, timezone?: string): Date {
  const resolved = isInterval(cron) ? intervalToCron(cron) : cron;
  const fields = parseCron(resolved);
  return computeNext(fields, from ?? new Date(), timezone);
}

/**
 * Validate a cron expression or interval shorthand.
 * Returns true if the expression is parseable.
 */
export function validateCron(cron: string): boolean {
  try {
    const resolved = isInterval(cron) ? intervalToCron(cron) : cron;
    parseCron(resolved);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert an interval shorthand ("30m", "2h") to a 5-field cron expression.
 * Throws if the interval is not valid.
 */
export function intervalToCron(interval: string): string {
  const match = interval.match(INTERVAL_PATTERN);
  if (!match) {
    throw new Error(`Invalid interval: "${interval}". Use format like "30m" or "2h".`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  if (unit === "m") {
    if (value < MIN_INTERVAL_MINUTES || value > 59) {
      throw new Error(
        `Minute interval must be between ${MIN_INTERVAL_MINUTES} and 59, got ${value}`,
      );
    }
    return `*/${value} * * * *`;
  }

  // unit === "h"
  if (value < 1 || value > 23) {
    throw new Error(`Hour interval must be between 1 and 23, got ${value}`);
  }
  return `0 */${value} * * *`;
}

/**
 * Parse a duration string (e.g., "15m", "3h", "7d") and return the expiry Date.
 * Supported units: m (minutes), h (hours), d (days).
 */
export function expiresAtFromDuration(duration: string, from?: Date): Date {
  const match = duration.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration: "${duration}". Use format like "15m", "3h", or "7d".`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  const base = from ?? new Date();

  const ms =
    unit === "m"
      ? value * 60 * 1000
      : unit === "h"
        ? value * 60 * 60 * 1000
        : value * 24 * 60 * 60 * 1000;

  return new Date(base.getTime() + ms);
}

// --- Field parsing ---

function isInterval(cron: string): boolean {
  return INTERVAL_PATTERN.test(cron);
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 7),
  };
}

const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function resolveNames(field: string, names: Record<string, number>): string {
  return field.replace(/[A-Z]{3}/gi, (m) => {
    const val = names[m.toUpperCase()];
    if (val === undefined) throw new Error(`Unknown name: ${m}`);
    return String(val);
  });
}

function parseField(field: string, min: number, max: number): Set<number> {
  const names = max === 7 ? DAY_NAMES : max === 12 ? MONTH_NAMES : {};
  const resolved = Object.keys(names).length > 0 ? resolveNames(field, names) : field;

  const values = new Set<number>();

  for (const part of resolved.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [rangeStr, stepStr] = part.split("/");
      const step = Number.parseInt(stepStr, 10);
      if (Number.isNaN(step) || step <= 0) {
        throw new Error(`Invalid step value: ${stepStr}`);
      }
      const start = rangeStr === "*" ? min : Number.parseInt(rangeStr, 10);
      if (Number.isNaN(start) || start < min || start > max) {
        throw new Error(`Value ${start} out of range ${min}-${max}`);
      }
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range: ${part} (valid: ${min}-${max})`);
      }
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const val = Number.parseInt(part, 10);
      if (Number.isNaN(val) || val < min || val > max) {
        throw new Error(`Value ${part} out of range ${min}-${max}`);
      }
      values.add(val);
    }
  }

  // Normalize day-of-week: 7 → 0 (both mean Sunday)
  if (max === 7 && values.has(7)) {
    values.add(0);
    values.delete(7);
  }

  return values;
}

// --- Timezone-aware date field extraction ---

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Extract cron-relevant date fields, optionally in a specific timezone. */
function getFields(date: Date, timezone?: string): DateFields {
  if (!timezone) {
    return {
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      dayOfWeek: date.getUTCDay(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => {
    const val = parts.find((p) => p.type === type)?.value;
    return val ? Number.parseInt(val, 10) : 0;
  };

  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";

  return {
    month: get("month"),
    day: get("day"),
    dayOfWeek: WEEKDAY_MAP[weekdayStr] ?? 0,
    hour: get("hour") % 24, // Intl hour12:false can return 24 for midnight
    minute: get("minute"),
  };
}

// --- Next fire time computation ---

const MAX_ITERATIONS = 366 * 24 * 60;

/**
 * Find the next time that matches the cron fields.
 * All advancement is done in UTC; field matching uses getFields() for timezone awareness.
 * Skip optimizations use local-time offsets so they're safe across timezone boundaries.
 */
function computeNext(fields: CronFields, from: Date, timezone?: string): Date {
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const f = getFields(d, timezone);

    if (!fields.months.has(f.month)) {
      // Skip to start of next local day
      d.setUTCMinutes(d.getUTCMinutes() + (23 - f.hour) * 60 + (60 - f.minute));
      continue;
    }

    if (!fields.daysOfMonth.has(f.day) || !fields.daysOfWeek.has(f.dayOfWeek)) {
      d.setUTCMinutes(d.getUTCMinutes() + (23 - f.hour) * 60 + (60 - f.minute));
      continue;
    }

    if (!fields.hours.has(f.hour)) {
      d.setUTCMinutes(d.getUTCMinutes() + (60 - f.minute));
      continue;
    }

    if (!fields.minutes.has(f.minute)) {
      d.setUTCMinutes(d.getUTCMinutes() + 1);
      continue;
    }

    return d;
  }

  throw new Error("Could not find next fire time within one year");
}
