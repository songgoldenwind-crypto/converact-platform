import { NotificationError } from './errors.js';
import type { NotificationAdministrationRepository } from './ports.js';
import type {
  CreateNotificationInput,
  NotificationPreference,
  NotificationTargetInput
} from './types.js';

export class NotificationPreferencePolicy {
  readonly #repository: Pick<NotificationAdministrationRepository, 'listPreferences'>;
  readonly #now: () => Date;

  constructor(input: {
    repository: Pick<NotificationAdministrationRepository, 'listPreferences'>;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#now = input.now || (() => new Date());
  }

  async apply(input: CreateNotificationInput): Promise<CreateNotificationInput> {
    if (input.force_delivery || input.recipient.kind !== 'user') return input;
    const preferences = await this.#repository.listPreferences(
      input.tenant_id, input.recipient.ref
    );
    const now = this.#now();
    let scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : now;
    let locale = input.locale || '';
    const targets: NotificationTargetInput[] = [];
    for (const target of input.targets) {
      const preference = effectivePreference(preferences, input.event_type, target.channel);
      if (preference?.enabled === false) continue;
      targets.push(target);
      if (!locale && preference?.locale) locale = preference.locale;
      const quietEnd = preference ? quietHoursEnd(preference, now) : null;
      if (quietEnd && quietEnd.getTime() > scheduledAt.getTime()) scheduledAt = quietEnd;
    }
    if (!targets.length) {
      throw new NotificationError({
        code: 'compliance_denied', status: 409, details: { reason: 'recipient_preferences' }
      });
    }
    return {
      ...input,
      targets,
      ...(locale ? { locale } : {}),
      ...(scheduledAt.getTime() > now.getTime() ? { scheduled_at: scheduledAt.toISOString() } : {})
    };
  }
}

function effectivePreference(
  preferences: readonly NotificationPreference[],
  eventType: string,
  channel: NotificationTargetInput['channel']
): NotificationPreference | null {
  return preferences.find((item) => item.event_type === eventType && item.channel === channel)
    || preferences.find((item) => item.event_type === '*' && item.channel === channel)
    || null;
}

function quietHoursEnd(preference: NotificationPreference, now: Date): Date | null {
  const quiet = preference.quiet_hours;
  if (!Object.keys(quiet).length) return null;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  const timezone = String(quiet.timezone || '');
  const local = zonedParts(now, timezone);
  const minute = local.hour * 60 + local.minute;
  const overnight = start >= end;
  const active = overnight ? minute >= start || minute < end : minute >= start && minute < end;
  if (!active) return null;
  const addDay = overnight && minute >= start ? 1 : 0;
  const date = addLocalDays(local, addDay);
  return localDateTimeToUtc({
    ...date, hour: Math.floor(end / 60), minute: end % 60, second: 0
  }, timezone);
}

function parseClock(value: unknown): number {
  const match = typeof value === 'string' ? value.match(/^([01]\d|2[0-3]):([0-5]\d)$/) : null;
  if (!match) throw validationError();
  return Number(match[1]) * 60 + Number(match[2]);
}

function zonedParts(date: Date, timezone: string): DateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
  } catch {
    throw validationError();
  }
  const values = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second
  };
}

function addLocalDays(parts: DateParts, days: number): Pick<DateParts, 'year' | 'month' | 'day'> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDateTimeToUtc(parts: DateParts, timezone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(guess), timezone);
    const observedEpoch = Date.UTC(
      observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second
    );
    const adjustment = target - observedEpoch;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess);
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
