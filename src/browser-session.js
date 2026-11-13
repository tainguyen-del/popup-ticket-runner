'use strict';

// A Chrome user-data directory is exclusive: Chrome refuses to open it in two
// windows at once. Keep the tool's login state in Playwright storageState
// instead, so login, the local UI, and ticket runs each receive their own
// browser process without fighting over a SingletonLock file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { sessionStatePath, activeLoginProfilePath } = require('./app-paths');

const execFileAsync = promisify(execFile);

function hasStoredSession(root) {
  const statePath = sessionStatePath(root);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Array.isArray(state?.cookies) && Array.isArray(state?.origins);
  } catch {
    return false;
  }
}

function clearStoredSession(root) {
  const statePath = sessionStatePath(root);
  try {
    fs.unlinkSync(statePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function launchToolBrowser(root, {
  headless = true,
  acceptDownloads = false,
  viewport = { width: 1440, height: 1000 },
  fresh = false,
  browserType = chromium
} = {}) {
  const statePath = sessionStatePath(root);
  // After login verification, reuse only the app-owned temporary profile.
  // It contains the actual Chrome login state and gives ticket execution a
  // normal, visible Chrome window. It is never the operator's Chrome profile.
  const profileDirectory = !headless && !fresh ? readActiveLoginProfile(root) : null;
  if (profileDirectory) {
    const context = await browserType.launchPersistentContext(profileDirectory, {
      channel: 'chrome',
      headless: false,
      acceptDownloads,
      viewport: null,
      args: ['--new-window', '--start-maximized']
    });
    return {
      browser: context.browser(),
      context,
      statePath,
      profileDirectory,
      cleanupProfile: false
    };
  }
  const launchOptions = { channel: 'chrome', headless };
  if (!headless) {
    // A non-persistent browser receives --no-startup-window by default.
    // Removing only that flag makes the fallback window visible while still
    // allowing Playwright storageState to be loaded into its isolated context.
    launchOptions.ignoreDefaultArgs = ['--no-startup-window'];
    launchOptions.args = ['--new-window', '--start-maximized'];
  }
  const browser = await browserType.launch(launchOptions);
  try {
    const context = await browser.newContext({
      acceptDownloads,
      viewport,
      ...(!fresh && hasStoredSession(root) ? { storageState: statePath } : {})
    });
    return { browser, context, statePath, profileDirectory: null, cleanupProfile: false };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

function createLoginProfileDirectory() {
  // A login is deliberately isolated from the operator's normal Chrome
  // profile. Unlike a reused user-data directory, this can never collide
  // with another Chrome window or carry the previous operator's cookies.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-runner-login-'));
}

function isTemporaryLoginProfileDirectory(profileDirectory) {
  if (!profileDirectory) return false;
  const resolved = path.resolve(profileDirectory);
  return path.dirname(resolved) === path.resolve(os.tmpdir())
    && path.basename(resolved).startsWith('popup-ticket-runner-login-');
}

function removeLoginProfileDirectory(profileDirectory) {
  if (!isTemporaryLoginProfileDirectory(profileDirectory)) return false;
  const resolved = path.resolve(profileDirectory);
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    return true;
  } catch {
    // A just-closed Chrome child can hold a cache file briefly. Leaving this
    // disposable directory behind is safer than failing the login workflow.
    return false;
  }
}

function readActiveLoginProfile(root) {
  try {
    const record = JSON.parse(fs.readFileSync(activeLoginProfilePath(root), 'utf8'));
    return isTemporaryLoginProfileDirectory(record?.profileDirectory) && fs.existsSync(record.profileDirectory)
      ? path.resolve(record.profileDirectory)
      : null;
  } catch {
    return null;
  }
}

function persistActiveLoginProfile(root, profileDirectory) {
  if (!isTemporaryLoginProfileDirectory(profileDirectory)) throw new Error('Invalid temporary login profile.');
  const recordPath = activeLoginProfilePath(root);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({ profileDirectory: path.resolve(profileDirectory) }), 'utf8');
  return recordPath;
}

function clearActiveLoginProfile(root, { removeProfile = false } = {}) {
  const profileDirectory = readActiveLoginProfile(root);
  try {
    fs.unlinkSync(activeLoginProfilePath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (removeProfile && profileDirectory) removeLoginProfileDirectory(profileDirectory);
  return profileDirectory;
}

async function focusLoginBrowser(profileDirectory, {
  platform = process.platform,
  execute = execFileAsync,
  launchedAfter = null
} = {}) {
  // Playwright can switch the active tab, but Windows may leave the Chrome
  // window behind another app. Target only our random temporary profile, not
  // the operator's normal Chrome window.
  if (platform !== 'win32' || !isTemporaryLoginProfileDirectory(profileDirectory)) return false;
  const script = String.raw`
$profile = [Environment]::GetEnvironmentVariable('POPUP_TICKET_RUNNER_PROFILE_TO_FOCUS')
if ([string]::IsNullOrWhiteSpace($profile)) { 'missing'; exit 0 }
$profileName = [IO.Path]::GetFileName($profile)
$candidate = $null
try {
  $candidate = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=') -and $_.CommandLine.Contains($profileName) } |
    ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
} catch { }
# Some managed Windows installations deny Win32_Process.CommandLine access.
# The tool starts its own Chrome immediately before this call, so in that case
# the newest visible Chrome window created after the recorded launch is a
# bounded, safe fallback that does not need WMI permissions.
if ($null -eq $candidate) {
  $launchedRaw = [Environment]::GetEnvironmentVariable('POPUP_TICKET_RUNNER_LAUNCHED_AFTER')
  $launchedAfter = $null
  try { if (-not [string]::IsNullOrWhiteSpace($launchedRaw)) { $launchedAfter = [DateTimeOffset]::Parse($launchedRaw).LocalDateTime } } catch { }
  if ($null -ne $launchedAfter) {
    $candidate = Get-Process -Name chrome -ErrorAction SilentlyContinue |
      ForEach-Object {
        try {
          if ($_.MainWindowHandle -ne 0 -and $_.StartTime -ge $launchedAfter.AddSeconds(-3)) { $_ }
        } catch { }
      } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
  }
}
if ($null -eq $candidate) { 'missing'; exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PopupTicketRunnerNativeWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$handle = [IntPtr]::new([Int64]$candidate.MainWindowHandle)
[void][PopupTicketRunnerNativeWindow]::ShowWindowAsync($handle, 9)
[void][PopupTicketRunnerNativeWindow]::BringWindowToTop($handle)
[void][PopupTicketRunnerNativeWindow]::SetForegroundWindow($handle)
'focused'
`;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      env: {
        ...process.env,
        POPUP_TICKET_RUNNER_PROFILE_TO_FOCUS: path.resolve(profileDirectory),
        POPUP_TICKET_RUNNER_LAUNCHED_AFTER: launchedAfter || ''
      }
    });
    return String(stdout || '').trim() === 'focused';
  } catch {
    return false;
  }
}

async function launchLoginBrowser(root, {
  browserType = chromium,
  createProfileDirectory = createLoginProfileDirectory,
  profileDirectory: existingProfileDirectory = null
} = {}) {
  const profileDirectory = existingProfileDirectory || createProfileDirectory();
  const createdProfile = !existingProfileDirectory;
  const launchedAt = new Date().toISOString();
  try {
    // Playwright's non-persistent launch adds --no-startup-window on Chrome.
    // A temporary persistent context opens an actual native window instead,
    // while remaining completely separate from any Chrome the operator has
    // already opened.
    const context = await browserType.launchPersistentContext(profileDirectory, {
      channel: 'chrome',
      headless: false,
      acceptDownloads: false,
      viewport: null,
      args: ['--new-window', '--start-maximized']
    });
    return { browser: context.browser(), context, profileDirectory, cleanupProfile: true, launchedAt };
  } catch (error) {
    if (createdProfile) removeLoginProfileDirectory(profileDirectory);
    throw error;
  }
}

async function persistStoredSession(context, root) {
  const statePath = sessionStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  try {
    await context.storageState({ path: statePath, indexedDB: true });
  } catch (error) {
    // Playwright versions before IndexedDB storage snapshots accepted only the
    // classic state shape. Preserve cookie/local-storage persistence there.
    if (!/indexeddb|unknown.*option|unexpected.*property/i.test(String(error?.message || ''))) throw error;
    await context.storageState({ path: statePath });
  }
  return statePath;
}

async function closeToolBrowser({ browser, context, profileDirectory, cleanupProfile = false } = {}) {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (cleanupProfile && profileDirectory) removeLoginProfileDirectory(profileDirectory);
}

module.exports = {
  hasStoredSession,
  clearStoredSession,
  launchToolBrowser,
  launchLoginBrowser,
  persistStoredSession,
  readActiveLoginProfile,
  persistActiveLoginProfile,
  clearActiveLoginProfile,
  focusLoginBrowser,
  closeToolBrowser,
  removeLoginProfileDirectory
};
