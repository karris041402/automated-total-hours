const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const fs_pr = require("fs/promises");

let mainWindow;
let watcher = null;

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

function getDefaultScanFolder() {
  // App-managed system folder (no manual creation needed)
  const base = app.getPath('userData');
  const folder = path.join(base, 'ricoh_scans', 'INBOX');
  ensureDir(folder);
  return folder;
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Vite dev server
  const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
  mainWindow.loadURL(devUrl);

  // Uncomment if you want devtools always open
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function startWatching(folderPath) {
  ensureDir(folderPath);
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }

  watcher = chokidar.watch(folderPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 900,
      pollInterval: 120,
    },
  });

  watcher.on('add', (filePath) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('scan:fileDetected', {
      filePath,
      fileName: path.basename(filePath),
      createdAt: Date.now(),
    });
  });
}

ipcMain.handle('scan:getDefaultFolder', async () => {
  try {
    const folder = getDefaultScanFolder();
    return { ok: true, folder };
  } catch (e) {
    return { ok: false, error: e?.message ? String(e.message) : 'Failed to get default folder' };
  }
});

ipcMain.handle('scan:startWatcher', async (_evt, folderPath) => {
  try {
    startWatching(folderPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ? String(e.message) : 'Failed to start watcher' };
  }
});

ipcMain.handle('scan:stopWatcher', async () => {
  try {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
  } catch {}
  return { ok: true };
});

ipcMain.handle('scan:readFile', async (_evt, filePath) => {
  const data = fs.readFileSync(filePath);
  // Return as ArrayBuffer-compatible
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle("scan:deleteFile", async (_, filePath) => {
  await fs_pr.unlink(filePath);
  return { ok: true };
});


app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (watcher) {
    try { await watcher.close(); } catch {}
    watcher = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
