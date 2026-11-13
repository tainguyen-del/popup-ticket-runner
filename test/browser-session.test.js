const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionStatePath } = require('../src/app-paths');
const {
  hasStoredSession,
  clearStoredSession,
  launchToolBrowser,
  launchLoginBrowser,
  closeToolBrowser,
  persistActiveLoginProfile,
  clearActiveLoginProfile,
  focusLoginBrowser
} = require('../src/browser-session');

function temporaryAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-runner-session-'));
}

async function withAppData(directory, fn) {
  const before = process.env.POPUP_TICKET_RUNNER_DATA_DIR;
  process.env.POPUP_TICKET_RUNNER_DATA_DIR = directory;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.POPUP_TICKET_RUNNER_DATA_DIR;
    else process.env.POPUP_TICKET_RUNNER_DATA_DIR = before;
  }
}

test('uses a valid local storage-state file without a Chrome profile directory', async () => {
  const directory = temporaryAppData();
  try {
    await withAppData(directory, () => {
      const statePath = sessionStatePath(directory);
      assert.equal(hasStoredSession(directory), false);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
      assert.equal(hasStoredSession(directory), true);
      assert.equal(clearStoredSession(directory), true);
      assert.equal(hasStoredSession(directory), false);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('creates an isolated browser context and loads storage state only when requested', async () => {
  const directory = temporaryAppData();
  try {
    let launchOptions = null;
    let contextOptions = null;
    const context = {};
    const browser = {
      newContext: async (options) => {
        contextOptions = options;
        return context;
      },
      close: async () => {}
    };
    const browserType = {
      launch: async (options) => {
        launchOptions = options;
        return browser;
      }
    };
    await withAppData(directory, async () => {
      const statePath = sessionStatePath(directory);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
      const launched = await launchToolBrowser(directory, {
        headless: false,
        acceptDownloads: true,
        browserType
      });
      assert.equal(launched.context, context);
      assert.deepEqual(launchOptions, {
        channel: 'chrome',
        headless: false,
        ignoreDefaultArgs: ['--no-startup-window'],
        args: ['--new-window', '--start-maximized']
      });
      assert.equal(contextOptions.storageState, statePath);
      assert.equal(contextOptions.acceptDownloads, true);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reopens the verified app-owned login profile visibly for a ticket run', async () => {
  const directory = temporaryAppData();
  const loginProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-runner-login-run-'));
  let profileArgument = null;
  let launchOptions = null;
  let contextClosed = false;
  const browser = { close: async () => {} };
  const context = {
    browser: () => browser,
    close: async () => { contextClosed = true; }
  };
  const browserType = {
    launchPersistentContext: async (profileDirectory, options) => {
      profileArgument = profileDirectory;
      launchOptions = options;
      return context;
    }
  };
  try {
    await withAppData(directory, async () => {
      persistActiveLoginProfile(directory, loginProfile);
      const launched = await launchToolBrowser(directory, { headless: false, acceptDownloads: true, browserType });
      assert.equal(launched.context, context);
      assert.equal(launched.profileDirectory, loginProfile);
      assert.equal(launched.cleanupProfile, false);
      assert.equal(profileArgument, loginProfile);
      assert.deepEqual(launchOptions, {
        channel: 'chrome',
        headless: false,
        acceptDownloads: true,
        viewport: null,
        args: ['--new-window', '--start-maximized']
      });
      await closeToolBrowser(launched);
      assert.equal(contextClosed, true);
      assert.equal(fs.existsSync(loginProfile), true);
      clearActiveLoginProfile(directory, { removeProfile: true });
      assert.equal(fs.existsSync(loginProfile), false);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(loginProfile, { recursive: true, force: true });
  }
});

test('opens login in a visible temporary persistent Chrome profile', async () => {
  const directory = temporaryAppData();
  const loginProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-runner-login-test-'));
  let profileArgument = null;
  let launchOptions = null;
  let contextClosed = false;
  let browserClosed = false;
  const browser = { close: async () => { browserClosed = true; } };
  const context = {
    browser: () => browser,
    close: async () => { contextClosed = true; }
  };
  const browserType = {
    launchPersistentContext: async (profileDirectory, options) => {
      profileArgument = profileDirectory;
      launchOptions = options;
      return context;
    }
  };
  try {
    const launched = await launchLoginBrowser(directory, {
      browserType,
      createProfileDirectory: () => loginProfile
    });
    assert.equal(launched.context, context);
    assert.equal(launched.browser, browser);
    assert.equal(launched.profileDirectory, loginProfile);
    assert.equal(profileArgument, loginProfile);
    assert.deepEqual(launchOptions, {
      channel: 'chrome',
      headless: false,
      acceptDownloads: false,
      viewport: null,
      args: ['--new-window', '--start-maximized']
    });
    await closeToolBrowser({ ...launched, cleanupProfile: true });
    assert.equal(contextClosed, true);
    assert.equal(browserClosed, true);
    assert.equal(fs.existsSync(loginProfile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(loginProfile, { recursive: true, force: true });
  }
});

test('skips native window focus outside Windows', async () => {
  const loginProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-runner-login-focus-'));
  let invoked = false;
  try {
    const focused = await focusLoginBrowser(loginProfile, {
      platform: 'linux',
      execute: async () => {
        invoked = true;
        return { stdout: 'focused' };
      }
    });
    assert.equal(focused, false);
    assert.equal(invoked, false);
  } finally {
    fs.rmSync(loginProfile, { recursive: true, force: true });
  }
});
