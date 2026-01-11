import { useEffect, useMemo, useRef, useState } from "react";
import Tesseract from "tesseract.js";
import type { ExtractedDTR, DtrRow, ScheduleState, Weekday } from "./types";
import {
  parseDtrFromTesseractWords,
  parseDtrFromPdfText,
} from "./utils/parseDtr";
import { computeTotalMinutes, formatHours } from "./utils/compute";
import { pdfToPngDataUrls } from "./utils/pdfToImages";
import { extractPdfText } from "./utils/pdfText";
import ScheduleBuilder from "./components/ScheduleBuilder";

// We force LEFT side processing for the Ricoh DTR (two tables side-by-side)
const DEFAULT_SIDE = "left" as const;

type QueueStatus =
  | "PENDING_SCHEDULE"
  | "READY"
  | "PROCESSING"
  | "DONE"
  | "FAILED";

type ScanQueueItem = {
  id: string;
  filePath: string;
  fileName: string;
  createdAt: number;
  status: QueueStatus;
  note?: string;
  totalMinutes?: number;
};

function monthToIndex(month: string) {
  const m = month.toUpperCase();
  const map: Record<string, number> = {
    JANUARY: 0,
    FEBRUARY: 1,
    MARCH: 2,
    APRIL: 3,
    MAY: 4,
    JUNE: 5,
    JULY: 6,
    AUGUST: 7,
    SEPTEMBER: 8,
    OCTOBER: 9,
    NOVEMBER: 10,
    DECEMBER: 11,
  };
  return map[m] ?? 0;
}

export default function App() {
  // 1) schedule builder (weekday + start + end)
  const [schedule, setSchedule] = useState<ScheduleState>(() => {
    try {
      const raw = localStorage.getItem("dtrSchedule");
      return raw ? (JSON.parse(raw) as ScheduleState) : { items: [] };
    } catch {
      return { items: [] };
    }
  });
  const scheduleRef = useRef<ScheduleState>(schedule);
  useEffect(() => {
    scheduleRef.current = schedule;
    try {
      localStorage.setItem("dtrSchedule", JSON.stringify(schedule));
    } catch {}
  }, [schedule]);

  // 2) month/year used for weekday matching
  const [year, setYear] = useState(2025);
  const [monthIndex0, setMonthIndex0] = useState(11); // Dec default
  const yearRef = useRef<number>(year);
  const monthRef = useRef<number>(monthIndex0);
  useEffect(() => {
    yearRef.current = year;
  }, [year]);
  useEffect(() => {
    monthRef.current = monthIndex0;
  }, [monthIndex0]);

  // We always read the LEFT side.

  // 3.5) Ricoh scanner integration (Electron) - watched folder + queue
  const isElectron =
    typeof window !== "undefined" && !!(window as any).scanBridge;
  const [scanFolder, setScanFolder] = useState<string>(
    () => localStorage.getItem("scanFolder") || ""
  );
  const [watcherOn, setWatcherOn] = useState(false);

  // Auto-pick app-managed scan folder (inside Electron userData) when empty
  useEffect(() => {
    if (!isElectron) return;
    if (scanFolder) return;
    (async () => {
      try {
        const res = await window.scanBridge!.getDefaultFolder();
        if (res?.ok && res.folder) {
          setScanFolder(res.folder);
          localStorage.setItem("scanFolder", res.folder);
        }
      } catch {}
    })();
  }, [isElectron, scanFolder]);
  const [queue, setQueue] = useState<ScanQueueItem[]>(() => {
    try {
      const raw = localStorage.getItem("scanQueue");
      return raw ? (JSON.parse(raw) as ScanQueueItem[]) : [];
    } catch {
      return [];
    }
  });
  const processingRef = useRef(false);

  // 4) last processed file (for preview only)
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  // 5) OCR state
  const [ocrLoading, setOcrLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  // 6) extracted
  const [extracted, setExtracted] = useState<ExtractedDTR | null>(null);
  const [rows, setRows] = useState<DtrRow[]>([]);

  // (we keep UI clean: no debug output)

  const allowedWeekdays = useMemo(
    () => new Set(schedule.items.map((i) => i.weekday)),
    [schedule]
  ) as Set<Weekday>;
  const allowedWeekdaysRef = useRef<Set<Weekday>>(allowedWeekdays);
  useEffect(() => {
    allowedWeekdaysRef.current = allowedWeekdays;
  }, [allowedWeekdays]);

  // Persist folder + queue (so pending scans survive refresh)
  useEffect(() => {
    localStorage.setItem("scanFolder", scanFolder);
  }, [scanFolder]);

  useEffect(() => {
    localStorage.setItem("scanQueue", JSON.stringify(queue));
  }, [queue]);

  // When schedule becomes available, unblock queued scans automatically
  useEffect(() => {
    if (!hasSchedule()) return;
    setQueue((prev) =>
      prev.map((it) =>
        it.status === "PENDING_SCHEDULE"
          ? { ...it, status: "READY", note: undefined }
          : it
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  function hasSchedule() {
    return schedule.items.length > 0;
  }

  function hasScheduleNow() {
    return scheduleRef.current.items.length > 0;
  }

  function mkId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function upsertQueue(item: ScanQueueItem) {
    setQueue((prev) => {
      const i = prev.findIndex((x) => x.filePath === item.filePath);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], ...item };
        return next;
      }
      return [item, ...prev].sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  function setStatus(filePath: string, patch: Partial<ScanQueueItem>) {
    setQueue((prev) =>
      prev.map((x) => (x.filePath === filePath ? { ...x, ...patch } : x))
    );
  }

  async function filePathToFile(
    filePath: string,
    fileName: string
  ): Promise<File> {
    const buf = await window.scanBridge!.readFile(filePath);
    const lower = fileName.toLowerCase();
    const mime = lower.endsWith(".pdf")
      ? "application/pdf"
      : lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
      ? "image/jpeg"
      : "application/octet-stream";
    return new File([buf], fileName, { type: mime });
  }

  async function processQueueItem(item: ScanQueueItem) {
    if (!isElectron) return;

    if (!hasScheduleNow()) {
      setStatus(item.filePath, {
        status: "PENDING_SCHEDULE",
        note: "No schedule set",
      });
      return;
    }

    if (processingRef.current) return;
    processingRef.current = true;

    try {
      setStatus(item.filePath, { status: "PROCESSING", note: undefined });

      const f = await filePathToFile(item.filePath, item.fileName);

      if (fileUrl) URL.revokeObjectURL(fileUrl);
      setFileUrl(URL.createObjectURL(f));

      const parsed = await scanAndCompute(f);

      if (parsed && parsed.rows.length) {
        const computed = computeTotalMinutes(
          parsed.rows,
          scheduleRef.current,
          yearRef.current,
          monthRef.current
        );

        setStatus(item.filePath, {
          status: "DONE",
          totalMinutes: computed.totalMinutes,
        });

        // ✅ delete the processed file
        try {
          await (window as any).scanBridge?.deleteFile(item.filePath);
          removeFromQueue(item.filePath);
        } catch (e) {
          console.warn("Failed to delete processed file:", e);
        }
      } else {
        setStatus(item.filePath, {
          status: "FAILED",
          note: "No rows detected",
        });
      }
    } catch (e: any) {
      setStatus(item.filePath, {
        status: "FAILED",
        note: e?.message ? String(e.message) : "Failed",
      });
    } finally {
      processingRef.current = false;
    }
  }

  async function reprocessPending() {
    if (!isElectron) return;
    if (!hasSchedule()) return;

    const pend = queue.filter(
      (q) =>
        q.status === "PENDING_SCHEDULE" ||
        q.status === "READY" ||
        q.status === "FAILED"
    );
    for (const it of pend) {
      // eslint-disable-next-line no-await-in-loop
      await processQueueItem({ ...it, status: "READY" });
    }
  }

  async function restartWatcher() {
    if (!isElectron) return;
    try {
      await window.scanBridge!.stopWatcher();
    } catch {}
    try {
      await window.scanBridge!.startWatcher(
        scanFolder || (await window.scanBridge!.getDefaultFolder()).folder || ""
      );
      setWatcherOn(true);
    } catch {
      setWatcherOn(false);
    }
  }

  async function stopWatcher() {
    if (!isElectron) return;
    try {
      await window.scanBridge!.stopWatcher();
    } finally {
      setWatcherOn(false);
    }
  }

  function removeFromQueue(filePath: string) {
    setQueue((prev) => prev.filter((x) => x.filePath !== filePath));
    setStatusMap((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
  }

  // Start watcher + listen for new scans (Electron only)
  useEffect(() => {
    if (!isElectron) return;

    let active = true;
    (async () => {
      try {
        await window.scanBridge!.startWatcher(
          scanFolder ||
            (
              await window.scanBridge!.getDefaultFolder()
            ).folder ||
            ""
        );
        if (active) setWatcherOn(true);
      } catch {
        if (active) setWatcherOn(false);
      }
    })();

    window.scanBridge!.onFileDetected((p) => {
      const newItem: ScanQueueItem = {
        id: mkId(),
        filePath: p.filePath,
        fileName: p.fileName,
        createdAt: p.createdAt,
        status: hasScheduleNow() ? "READY" : "PENDING_SCHEDULE",
        note: hasScheduleNow() ? undefined : "No schedule set",
      };
      upsertQueue(newItem);
    });

    return () => {
      active = false;
    };
    // NOTE: we intentionally do NOT depend on schedule here; schedule changes enable the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isElectron, scanFolder]);

  // Auto-process READY items sequentially (prevents stale-closure schedule checks)
  useEffect(() => {
    if (!isElectron) return;
    if (!hasSchedule()) return;
    if (processingRef.current) return;
    const next = queue.find((q) => q.status === "READY");
    if (next) {
      void processQueueItem(next);
    }
  }, [queue, schedule, isElectron]);

  const result = useMemo(() => {
    if (!rows.length) return null;
    return computeTotalMinutes(rows, schedule, year, monthIndex0);
  }, [rows, schedule, year, monthIndex0]);

  async function scanAndCompute(f: File): Promise<ExtractedDTR | null> {
    if (scheduleRef.current.items.length === 0) {
      alert("Please add at least one schedule day before scanning.");
      return null;
    }

    const curYear = yearRef.current;
    const curMonthIndex0 = monthRef.current;
    const curAllowedWeekdays = allowedWeekdaysRef.current;

    setExtracted(null);
    setRows([]);
    setProgress(0);

    setOcrLoading(true);
    try {
      // 0) FAST PATH (no OCR): extract text directly from the PDF.
      // If the Ricoh PDF has an embedded text layer, this will read the TABLE perfectly.
      // If we get enough time tokens, we skip Tesseract entirely.
      if (
        f.type === "application/pdf" ||
        f.name.toLowerCase().endsWith(".pdf")
      ) {
        try {
          const pdfText = await extractPdfText(f, DEFAULT_SIDE);
          const timeTokenCount = (
            pdfText.match(/\b\d{1,2}\s*[:.]\s*\d{2}\s*(?:AM|PM)\b/gi) || []
          ).length;

          if (timeTokenCount >= 6) {
            const parsedPdf = parseDtrFromPdfText({
              text: pdfText,
              year: curYear,
              monthIndex0: curMonthIndex0,
              allowedWeekdays: curAllowedWeekdays,
            });

            const out: ExtractedDTR = {
              employeeName: parsedPdf.employeeName,
              monthLabel: parsedPdf.monthLabel,
              rows: parsedPdf.rows,
              rawText: parsedPdf.rawText,
            };
            setExtracted(out);
            setRows(parsedPdf.rows);

            // auto month/year if detected (e.g. "NOVEMBER / 2025")
            if (parsedPdf.monthLabel) {
              const parts = parsedPdf.monthLabel.split("/");
              const mm = parts[0]?.trim() ?? "";
              const yy = Number(parts[1]?.trim());
              if (!Number.isNaN(yy)) setYear(yy);
              setMonthIndex0(monthToIndex(mm));
            }

            setProgress(100);
            return out;
          }
        } catch (e) {
          // ignore and fall back to OCR
        }
      }
      let pageImages: string[] = [];

      // PDF -> images (cropped left/right)
      if (
        f.type === "application/pdf" ||
        f.name.toLowerCase().endsWith(".pdf")
      ) {
        pageImages = await pdfToPngDataUrls(f, 2.6, DEFAULT_SIDE); // 2.6 sharper for table
        setFileUrl(pageImages[0] ?? null);
      } else {
        const url = URL.createObjectURL(f);
        setFileUrl(url);
        pageImages = [url];
      }

      let combinedText = "";
      let allWords: any[] = [];

      for (let i = 0; i < pageImages.length; i++) {
        const img = pageImages[i];

        const ocrOptions: any = {
          // OCR tuning for grid tables / small fonts
          tessedit_pageseg_mode: "6", // assume a uniform block of text
          user_defined_dpi: "300",
          preserve_interword_spaces: "1",
          tessedit_char_whitelist: "0123456789:APMapm. ",
          logger: (m: any) => {
            if (
              m.status === "recognizing text" &&
              typeof m.progress === "number"
            ) {
              const base = (i / pageImages.length) * 100;
              const pageProg = m.progress * (100 / pageImages.length);
              setProgress(Math.round(base + pageProg));
            }
          },
        };

        const out = await (Tesseract as any).recognize(img, "eng", ocrOptions);

        // Keep header/body text for name/month
        combinedText += "\n" + (out.data.text || "");

        // IMPORTANT: table is usually here, as WORD boxes
        allWords = allWords.concat(((out as any).data.words as any[]) || []);
      }

      const parsed = parseDtrFromTesseractWords({
        words: allWords,
        rawText: combinedText,
        year: curYear,
        monthIndex0: curMonthIndex0,
        allowedWeekdays: curAllowedWeekdays,
      });

      const out: ExtractedDTR = {
        employeeName: parsed.employeeName,
        monthLabel: parsed.monthLabel,
        rows: parsed.rows,
        rawText: parsed.rawText,
      };
      setExtracted(out);
      setRows(parsed.rows);

      // auto month/year if OCR detected "DECEMBER / 2025"
      if (parsed.monthLabel) {
        const parts = parsed.monthLabel.split("/");
        const mm = parts[0]?.trim() ?? "";
        const yy = Number(parts[1]?.trim());
        if (!Number.isNaN(yy)) setYear(yy);
        setMonthIndex0(monthToIndex(mm));
      }

      return out;
    } finally {
      setOcrLoading(false);
    }
  }

  function updateRow(day: number, key: keyof DtrRow, value: string) {
    setRows((prev) =>
      prev.map((r) => (r.day === day ? { ...r, [key]: value || undefined } : r))
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-semibold">Automated DTR Total Hours</h1>

        {/* 1) Schedule builder */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <div className="font-medium">1) Build Schedule</div>
          <ScheduleBuilder schedule={schedule} setSchedule={setSchedule} />
          {schedule.items.length === 0 && (
            <div className="text-sm text-amber-300">
              Add at least one schedule day before scanning.
            </div>
          )}
        </div>

        {/* 1.5) Ricoh scanner integration (Electron) */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <div className="font-medium">
            1.5) Ricoh Scanner Auto-Scan (Folder Watch)
          </div>
          {!isElectron && (
            <div className="text-sm text-amber-300">
              Folder auto-detect works only in the Electron desktop version. You
              can still use manual upload below.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
            <div>Scan folder:</div>
            <input
              className="flex-1 min-w-[280px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
              value={scanFolder}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setScanFolder(e.currentTarget.value)
              }
              placeholder="C:\\DTR_SCANS\\INBOX"
            />
            <div className={watcherOn ? "text-green-400" : "text-red-400"}>
              {watcherOn ? "WATCHING" : "OFF"}
            </div>
            <button
              type="button"
              disabled={!isElectron}
              onClick={() => void restartWatcher()}
              className="rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-2 font-medium"
            >
              Restart
            </button>
            <button
              type="button"
              disabled={!isElectron}
              onClick={() => void stopWatcher()}
              className="rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-2 font-medium"
            >
              Stop
            </button>
            <button
              type="button"
              disabled={!isElectron || !hasSchedule() || queue.length === 0}
              onClick={() => void reprocessPending()}
              className="rounded-lg bg-emerald-600/90 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 font-medium"
            >
              Reprocess Pending Files
            </button>
          </div>

          {queue.length > 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <div className="text-sm text-slate-200 font-semibold mb-2">
                Detected Scans
              </div>
              <div className="space-y-2">
                {queue.slice(0, 8).map((q) => (
                  <div
                    key={q.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <div className="min-w-[260px]">
                      <div className="text-slate-100">{q.fileName}</div>
                      <div className="text-xs text-slate-400 break-all">
                        {q.filePath}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div
                        className={
                          q.status === "DONE"
                            ? "text-green-400"
                            : q.status === "PROCESSING"
                            ? "text-sky-300"
                            : q.status === "PENDING_SCHEDULE"
                            ? "text-amber-300"
                            : q.status === "FAILED"
                            ? "text-red-400"
                            : "text-slate-300"
                        }
                      >
                        {q.status}
                      </div>
                      {typeof q.totalMinutes === "number" &&
                        q.status === "DONE" && (
                          <div className="text-slate-200">
                            {formatHours(q.totalMinutes)}
                          </div>
                        )}
                      {q.note && (
                        <div className="text-xs text-slate-400">{q.note}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {queue.length > 8 && (
                <div className="text-xs text-slate-400 mt-2">
                  Showing latest 8 of {queue.length}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 2) Month/year */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <div className="font-medium">
            2) Set Month &amp; Year (for weekday matching)
          </div>
          <div className="flex flex-wrap gap-3 items-center text-sm text-slate-300">
            <div>Year:</div>
            <input
              className="w-28 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
              type="number"
              value={year}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setYear(Number(e.currentTarget.value))
              }
            />
            <div>Month (0-11):</div>
            <input
              className="w-28 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
              type="number"
              value={monthIndex0}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMonthIndex0(Number(e.currentTarget.value))
              }
            />
            <div className="text-slate-400">
              (OCR will auto-fill if it detects "DECEMBER / 2025")
            </div>
          </div>
        </div>

        {/* 3) Processing (auto from Ricoh scan folder) */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <div className="font-medium">3) Processing</div>
          <div className="text-sm text-slate-300">
            This app automatically processes new scans saved by the Ricoh
            scanner into the watched folder.
          </div>

          {fileUrl && (
            <div className="rounded-lg overflow-hidden border border-slate-800 bg-white">
              <img src={fileUrl} className="w-full" />
            </div>
          )}

          {ocrLoading && (
            <div className="text-sm text-slate-300">
              OCR running… {progress}%
            </div>
          )}
        </div>

        {/* 4) Extracted */}
        {extracted && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
            <div className="font-medium">4) Extracted</div>
            <div className="text-sm text-slate-300 space-y-1">
              <div>
                <span className="text-slate-100">Employee:</span>{" "}
                {extracted.employeeName ?? "—"}
              </div>
              <div>
                <span className="text-slate-100">Month:</span>{" "}
                {extracted.monthLabel ?? "—"}
              </div>
              <div>
                <span className="text-slate-100">Rows detected:</span>{" "}
                {rows.length}
              </div>
            </div>
          </div>
        )}

        {/* 5) Review/Edit */}
        {!!rows.length && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
            <div className="font-medium">5) Review / Edit</div>

            <div className="overflow-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="text-slate-300">
                  <tr className="border-b border-slate-800">
                    <th className="py-2 text-left">Day</th>
                    <th className="py-2 text-left">In</th>
                    <th className="py-2 text-left">Out</th>
                    <th className="py-2 text-left">Counted?</th>
                    <th className="py-2 text-left">Minutes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const computed = computeTotalMinutes(
                      [r],
                      schedule,
                      year,
                      monthIndex0
                    ).perDay[0];
                    return (
                      <tr key={r.day} className="border-b border-slate-800/60">
                        <td className="py-2 pr-3">{r.day}</td>

                        <td className="py-2 pr-3">
                          <input
                            className="w-40 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1"
                            value={r.amIn ?? ""}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>
                            ) =>
                              updateRow(r.day, "amIn", e.currentTarget.value)
                            }
                            placeholder="e.g. 06:24 AM"
                          />
                        </td>

                        <td className="py-2 pr-3">
                          <input
                            className="w-40 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1"
                            value={r.amOut ?? ""}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>
                            ) =>
                              updateRow(r.day, "amOut", e.currentTarget.value)
                            }
                            placeholder="e.g. 05:00 PM"
                          />
                        </td>

                        <td className="py-2 pr-3">
                          <span
                            className={
                              computed.inSchedule
                                ? "text-green-400"
                                : "text-red-400"
                            }
                          >
                            {computed.inSchedule ? "YES" : "NO"}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          {computed.inSchedule ? computed.minutes : 0}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Total */}
        {result && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 flex items-center justify-between">
            <div>
              <div className="font-medium">
                6) Total Hours (Schedule-filtered)
              </div>
              <div className="text-sm text-slate-300">
                Days outside schedule are excluded automatically.
              </div>
            </div>
            <div className="text-xl font-semibold">
              {formatHours(result.totalMinutes)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
