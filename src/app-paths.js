const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configuredPath(name) {
  const value = process.env[name];
  return value ? path.resolve(value) : null;
}

function appDataDirectory(root) {
  return configuredPath('POPUP_TICKET_RUNNER_DATA_DIR')
    // Match Electron's Windows userData location so the local link and the
    // desktop launcher share one app-owned session store.
    || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'popup-ticket-runner');
}

function sessionStatePath(root) {
  return configuredPath('POPUP_TICKET_RUNNER_SESSION_STATE')
    || path.join(appDataDirectory(root), 'session-state.json');
}

function activeLoginProfilePath(root) {
  return configuredPath('POPUP_TICKET_RUNNER_ACTIVE_PROFILE')
    || path.join(appDataDirectory(root), 'active-login-profile.json');
}

function profileDirectory(root) {
  const configured = configuredPath('POPUP_TICKET_RUNNER_PROFILE_DIR');
  if (configured) return configured;
  const legacy = path.join(root, '.chrome-profile');
  if (!process.env.POPUP_TICKET_RUNNER_DATA_DIR && fs.existsSync(legacy)) return legacy;
  return path.join(appDataDirectory(root), 'chrome-profile');
}

function runDirectoryRoots(root) {
  const roots = [
    path.join(appDataDirectory(root), 'runs'),
    path.join(root, 'runs'),
    path.join(os.tmpdir(), 'popup-ticket-runner', 'runs')
  ].map((directory) => path.resolve(directory));
  return [...new Set(roots)];
}

module.exports = {
  appDataDirectory,
  profileDirectory,
  runDirectoryRoots,
  sessionStatePath,
  activeLoginProfilePath
};
