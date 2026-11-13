const path = require('node:path');
const { app, BrowserWindow, dialog, safeStorage, shell, nativeImage } = require('electron');
const { GeminiKeyStore } = require('../src/gemini-key-store');

let mainWindow = null;
let serverControl = null;
let serverInfo = null;

function safeExternalUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function resolveAppIcon() {
  const icoPath = path.join(app.getAppPath(), 'public', 'app-icon.ico');
  if (process.platform === 'win32' && require('node:fs').existsSync(icoPath)) {
    return icoPath;
  }
  const pngPath = path.join(app.getAppPath(), 'public', 'app-icon.png');
  return pngPath;
}

function createWindow() {
  const appIcon = resolveAppIcon();

  mainWindow = new BrowserWindow({
    width: 1060,
    height: 900,
    minWidth: 780,
    minHeight: 680,
    icon: appIcon,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#edf5f6',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (appIcon) {
    mainWindow.setIcon(appIcon);
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = safeExternalUrl(url);
    if (externalUrl) void shell.openExternal(externalUrl);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://${serverInfo.host}:${serverInfo.port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function bootstrap() {
  // The app data directory is writable after installation and is intentionally
  // separate from the app bundle. It holds the isolated Chrome session and
  // local reports, never a plaintext username or password.
  process.env.POPUP_TICKET_RUNNER_DATA_DIR = app.getPath('userData');
  const geminiKeyStore = new GeminiKeyStore({
    dataDirectory: app.getPath('userData'),
    safeStorage
  });
  const root = app.getAppPath();
  // Require after the data path is defined, so the login manager and runner
  // use this app's persistent Chrome profile from their first call.
  serverControl = require(path.join(root, 'src', 'server.js'));
  serverInfo = await serverControl.startServer({
    port: 0,
    host: '127.0.0.1',
    geminiKeyStore
  });
  createWindow();
}

app.setAppUserModelId('dev.fastboy.popup-ticket-runner.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox('Popup Ticket Runner', `Không thể mở app: ${error.message}`);
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    serverControl?.stopServer().catch(() => {});
  });
}
