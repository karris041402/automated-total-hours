import type { DtrRow, ScheduleState, Weekday } from "../types";

function parseTimeToMinutes(t: string): number | null {
  // "06:24 AM"
  const m = t.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i);
  if (!m) return null;

  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ap = m[3].toUpperCase();

  if (hh < 1 || hh > 12 || mm < 0 || mm > 59) return null;

  if (ap === "AM") {
    if (hh === 12) hh = 0;
  } else {
    if (hh !== 12) hh += 12;
  }
  return hh * 60 + mm;
}

function diffMinutes(start?: string, end?: string): number {
  if (!start || !end) return 0;
  const s = parseTimeToMinutes(start);
  const e = parseTimeToMinutes(end);
  if (s == null || e == null) return 0;

  // if end earlier than start, assume crossed midnight
  if (e < s) return 24 * 60 - s + e;
  return e - s;
}

function weekdayOfDate(year: number, monthIndex0: number, day: number): Weekday {
  return new Date(year, monthIndex0, day).getDay() as Weekday;
}

export function computeTotalMinutes(
  rows: DtrRow[],
  schedule: ScheduleState,
  year: number,
  monthIndex0: number
) {
  // ✅ allowed weekdays from ScheduleBuilder
  const allowed = new Set(schedule.items.map((i) => i.weekday));

  const perDay = rows.map((r) => {
    const wd = weekdayOfDate(year, monthIndex0, r.day);
    const inSchedule = allowed.has(wd);

    const minutes = diffMinutes(r.amIn, r.amOut) + diffMinutes(r.pmIn, r.pmOut);

    return {
      day: r.day,
      weekday: wd,
      inSchedule,
      minutes: inSchedule ? minutes : 0,
      rawMinutes: minutes,
    };
  });

  const total = perDay.reduce((sum, d) => sum + d.minutes, 0);
  return { totalMinutes: total, perDay };
}

export function formatHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}
