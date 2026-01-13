const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const fs_pr = require("fs/promises");
const chokidar = require("chokidar");
const { spawn } = require("child_process");

let mainWindow;
let watcher = null;

/* =========================
   APP FOLDER & WATCHER
========================= */

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function getDefaultScanFolder() {
  const base = app.getPath("userData");
  const folder = path.join(base, "ricoh_scans", "INBOX");
  ensureDir(folder);
  return folder;
}

function startWatching(folderPath) {
  ensureDir(folderPath);

  if (watcher) {
    try {
      watcher.close();
    } catch {}
    watcher = null;
  }

  watcher = chokidar.watch(folderPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 900,
      pollInterval: 120,
    },
  });

  watcher.on("add", (filePath) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("scan:fileDetected", {
      filePath,
      fileName: path.basename(filePath),
      createdAt: Date.now(),
    });
  });
}

/* =========================
   ELECTRON WINDOW
========================= */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl =
    process.env.ELECTRON_RENDERER_URL || "http://localhost:5173";
  mainWindow.loadURL(devUrl);
}

/* =========================
   IPC BRIDGE
========================= */

ipcMain.handle("scan:getDefaultFolder", async () => {
  return { ok: true, folder: getDefaultScanFolder() };
});

ipcMain.handle("scan:startWatcher", async (_e, folderPath) => {
  startWatching(folderPath);
  return { ok: true };
});

ipcMain.handle("scan:stopWatcher", async () => {
  if (watcher) {
    try {
      await watcher.close();
    } catch {}
    watcher = null;
  }
  return { ok: true };
});

ipcMain.handle("scan:readFile", async (_e, filePath) => {
  const data = fs.readFileSync(filePath);
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  );
});

ipcMain.handle("scan:deleteFile", async (_e, filePath) => {
  await fs_pr.unlink(filePath);
  return { ok: true };
});


/* =========================
   APP LIFECYCLE
========================= */

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  if (watcher) {
    try {
      await watcher.close();
    } catch {}
    watcher = null;
  }
  if (process.platform !== "darwin") app.quit();
});
