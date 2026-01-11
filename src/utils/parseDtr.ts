import type { ExtractedDTR, DtrRow, Weekday } from "../types";

/**
 * Why this file exists:
 * - For these DTR PDFs, the table is often NOT returned in `out.data.text` (you only get the header text).
 * - But Tesseract still detects individual WORDS in the table with bounding boxes (`out.data.words`).
 * - So we parse from WORDS + their positions (y-clustering per row) to reliably extract day + times.
 */

export type ParseDebugDay = {
  day: number;
  weekday?: Weekday;
  inSchedule?: boolean;
  timesFound: string[];
  uniqueTimes: string[];
  inTime?: string;
  outTime?: string;
};

export type ParseDebug = {
  rawTextPreview: string;
  // shows what tesseract saw as words (first N)
  wordsPreview: { text: string; x0: number; y0: number; x1: number; y1: number }[];
  days: ParseDebugDay[];
};

// Accepts: "12:28 AM", "12.28AM", "8:34 PM", and allows space/dot/colon between HH and MM
const timeTokenRe = /^(\d{1,2})\s*[:.\s]\s*(\d{2})\s*(AM|PM)$/i;
const timeCompactRe = /^(\d{1,2})\s*[:.\s]\s*(\d{2})(AM|PM)$/i;

function normalizeTime(hh: string, mm: string, ap: string) {
  const h = String(Number(hh));
  return `${h}:${mm} ${ap.toUpperCase()}`;
}

function extractName(text: string) {
  const m = text.match(/NAME\s*:\s*([^\n\r]+)/i);
  return m?.[1]?.trim();
}

function extractMonth(text: string) {
  const m = text.match(
    /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s*\/\s*(\d{4})/i
  );
  return m ? `${m[1].toUpperCase()} / ${m[2]}` : undefined;
}

function timeToMinutesOfDay(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i);
  if (!m) return null;

  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ap = m[3].toUpperCase();

  if (ap === "AM") {
    if (hh === 12) hh = 0;
  } else {
    if (hh !== 12) hh += 12;
  }
  return hh * 60 + mm;
}

// Backwards compatible alias (older code used timeToMinutes)
const timeToMinutes = timeToMinutesOfDay;

function weekdayOfDate(year: number, monthIndex0: number, day: number): Weekday {
  return new Date(year, monthIndex0, day).getDay() as Weekday;
}

type WordBox = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

/**
 * Core extractor: from tesseract words -> per day times.
 * - Cluster words into "rows" by y-mid (table rows align horizontally).
 * - For each row, identify the day number in the left column.
 * - Collect time tokens across the row, combine with AM/PM if split.
 */
export function parseDtrFromTesseractWords(args: {
  words: WordBox[];
  rawText: string;
  year: number;
  monthIndex0: number;
  // schedule weekdays set (0..6), used only for debug flags
  allowedWeekdays?: Set<number>;
}): ExtractedDTR & { debug: ParseDebug } {
  const { words, rawText, year, monthIndex0, allowedWeekdays } = args;

  const cleanedWords = (words || [])
    .map((w) => ({
      text: (w.text || "").trim(),
      x0: w.bbox?.x0 ?? 0,
      y0: w.bbox?.y0 ?? 0,
      x1: w.bbox?.x1 ?? 0,
      y1: w.bbox?.y1 ?? 0,
    }))
    .filter((w) => w.text.length > 0);

  const maxX = cleanedWords.reduce((m, w) => Math.max(m, w.x1), 1);
  const dayColMaxX = maxX * 0.22; // day column is near left side (after half-crop)

  // Group by y-mid clusters
  const items = cleanedWords
    .map((w) => ({ ...w, yMid: (w.y0 + w.y1) / 2, xMid: (w.x0 + w.x1) / 2 }))
    .sort((a, b) => a.yMid - b.yMid);

  const clusters: typeof items[] = [];
  const tol = 12; // y tolerance in pixels (works well for 2.2–3.0 scale)
  for (const it of items) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([it]);
      continue;
    }
    const lastMid = last[last.length - 1].yMid;
    if (Math.abs(it.yMid - lastMid) <= tol) last.push(it);
    else clusters.push([it]);
  }

  // day -> times
  const dayMap = new Map<number, string[]>();
  const debugDays: ParseDebugDay[] = [];

  function collectTimesFromRow(row: typeof items): string[] {
    const rowSorted = [...row].sort((a, b) => a.x0 - b.x0);
    const times: string[] = [];

    for (let i = 0; i < rowSorted.length; i++) {
      const t = rowSorted[i].text;

      // ignore header labels
      if (/^(A\.?M\.?|P\.?M\.?|Arrival|Departure|Late|U-?Time|Mins\.?)$/i.test(t)) continue;

      // full compact token like 10:52PM
      const mc = t.match(timeCompactRe);
      if (mc) {
        times.push(normalizeTime(mc[1], mc[2], mc[3]));
        continue;
      }

      // token like "10:52" then next token "PM"
      const m1 = t.match(/^(\d{1,2})\s*[:.\s]\s*(\d{2})$/);
      if (m1) {
        const next = rowSorted[i + 1]?.text ?? "";
        const ap = next.match(/^(AM|PM)$/i)?.[1];
        if (ap) {
          times.push(normalizeTime(m1[1], m1[2], ap));
          i += 1;
          continue;
        }
      }

      // token like "10:52 PM"
      const m2 = t.match(timeTokenRe);
      if (m2) {
        times.push(normalizeTime(m2[1], m2[2], m2[3]));
        continue;
      }
    }

    return times;
  }

  for (const row of clusters) {
    // find a day number in day column
    const dayWord = row.find((w) => w.x0 <= dayColMaxX && /^\d{1,2}$/.test(w.text));
    if (!dayWord) continue;

    const day = Number(dayWord.text);
    if (day < 1 || day > 31) continue;

    const times = collectTimesFromRow(row);
    if (!times.length) continue;

    const prev = dayMap.get(day) ?? [];
    dayMap.set(day, prev.concat(times));
  }

  const rows: DtrRow[] = Array.from(dayMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, times]) => {
      const uniqueTimes = Array.from(new Set(times));
      const sorted = uniqueTimes
        .map((t) => ({ t, m: timeToMinutesOfDay(t) }))
        .filter((x) => x.m != null)
        .sort((a, b) => (a.m! - b.m!));

      let inTime: string | undefined;
      let outTime: string | undefined;

      if (sorted.length >= 2) {
        // your rule: earliest = IN, latest = OUT (deduped)
        inTime = sorted[0].t;
        outTime = sorted[sorted.length - 1].t;
      }

      // debug flags
      const wd = weekdayOfDate(year, monthIndex0, day);
      const inSchedule = allowedWeekdays ? allowedWeekdays.has(wd) : undefined;

      debugDays.push({
        day,
        weekday: wd,
        inSchedule,
        timesFound: times,
        uniqueTimes,
        inTime,
        outTime,
      });

      // store in/out in amIn/amOut to reuse your existing compute.ts logic
      const rowObj: DtrRow = { day };
      if (inTime && outTime) {
        rowObj.amIn = inTime;
        rowObj.amOut = outTime;
      }
      return rowObj;
    });

  return {
    employeeName: extractName(rawText),
    monthLabel: extractMonth(rawText),
    rows,
    rawText,
    debug: {
      rawTextPreview: rawText.slice(0, 2000),
      wordsPreview: cleanedWords.slice(0, 120),
      days: debugDays,
    },
  };
}

/**
 * Fallback (older) text parser. Keep for images where text lines contain day+times.
 */

export function parseDtrFromPdfText(args: {
  text: string;
  year: number;
  monthIndex0: number;
  allowedWeekdays: Set<Weekday>;
}) {
  const { text, year, monthIndex0, allowedWeekdays } = args;

  const employeeName = extractName(text);
  const monthLabel = extractMonth(text);

  // Time tokens like "10:10 AM" or "08:28 PM"
  const timeRe = /\b(\d{1,2})\s*[:.]\s*(\d{2})\s*(AM|PM)\b/gi;

  // We expect pdf.js text to contain day numbers in-line, e.g.
  // " 3 10:10 AM 8:28 PM 08:28 PM"
  const lines = text
    .replace(/\s+/g, " ")
    .split(/\b(?=\d{1,2}\s+(?:\d{1,2}[:.]\d{2}\s*(?:AM|PM)))/g); // rough split near day rows

  const rows: DtrRow[] = [];
  const debugDays: ParseDebugDay[] = [];

  for (let day = 1; day <= 31; day++) {
    // Find a chunk that looks like it starts with this day number
    const chunk = lines.find((ln) => ln.trim().startsWith(String(day) + " "));
    const timesFound: string[] = [];

    if (chunk) {
      let m: RegExpExecArray | null;
      while ((m = timeRe.exec(chunk)) !== null) {
        timesFound.push(normalizeTime(m[1], m[2], m[3]));
      }
      timeRe.lastIndex = 0;
    }

    const uniqueTimes = Array.from(new Set(timesFound));

    const wd = weekdayOfDate(year, monthIndex0, day);
    const inSchedule = allowedWeekdays.has(wd);

    let inTime: string | undefined;
    let outTime: string | undefined;

    if (uniqueTimes.length >= 2) {
      // pick earliest & latest by actual minutes
      const sorted = uniqueTimes
        .map((t) => ({ t, mins: timeToMinutes(t) ?? Number.POSITIVE_INFINITY }))
        .filter((x) => Number.isFinite(x.mins))
        .sort((a, b) => a.mins - b.mins);

      if (sorted.length >= 2) {
        inTime = sorted[0].t;
        outTime = sorted[sorted.length - 1].t;
      }
    }

    debugDays.push({ day, weekday: wd, inSchedule, timesFound, uniqueTimes, inTime, outTime });

    if (inTime && outTime) {
      rows.push({ day, amIn: inTime, amOut: outTime });
    }
  }

  return {
    employeeName,
    monthLabel,
    rows,
    rawText: text,
    debug: {
      monthLabel,
      employeeName,
      source: "pdf-text",
      wordsPreview: [],
      days: debugDays,
    } as any,
  };
}


export function parseDtrFromOcr(rawText: string): ExtractedDTR {
  // simple fallback: no row parsing
  return {
    employeeName: extractName(rawText),
    monthLabel: extractMonth(rawText),
    rows: [],
    rawText,
  };
}
