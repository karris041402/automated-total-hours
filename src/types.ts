export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // Sun=0 ... Sat=6

export type DaySchedule = {
  weekday: Weekday;
  start: string; // "07:00"
  end: string;   // "17:00"
};

export type ScheduleState = {
  items: DaySchedule[]; // unique by weekday
};

export type DtrRow = {
  day: number; // 1..31
  amIn?: string;   // "06:24 AM"
  amOut?: string;
  pmIn?: string;
  pmOut?: string;
};

export type ExtractedDTR = {
  employeeName?: string;
  monthLabel?: string; // "DECEMBER / 2025"
  rows: DtrRow[];
  rawText: string;
};

// ----------------------------
// Electron bridge (optional)
// ----------------------------
export type ScanBridgeFileDetected = {
  filePath: string;
  fileName: string;
  createdAt: number;
};

export type ScanBridgeApi = {
  startWatcher: (folderPath: string) => Promise<{ ok: boolean; error?: string }>;
  stopWatcher: () => Promise<{ ok: boolean }>;
  readFile: (filePath: string) => Promise<ArrayBuffer>;
  getDefaultFolder: () => Promise<{ ok: boolean; folder?: string; error?: string }>;
  onFileDetected: (cb: (payload: ScanBridgeFileDetected) => void) => void;
};

declare global {
  interface Window {
    scanBridge?: ScanBridgeApi;
  }
}
