#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { sessionStatePath } = require('../app-paths');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BASE_URL = 'https://apps.newzensite.com';
const STATE_PATH = sessionStatePath(ROOT);

function parseArgs(argv) {
  const args = { headless: false, baseUrl: DEFAULT_BASE_URL };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--headless') args.headless = true;
    else if (token === '--base-url') args.baseUrl = next || args.baseUrl;
    else if (token === '--email') args.email = next;
    else if (token === '--password') args.password = next;
    else if (token === '--state-path') args.statePath = next;
    else if (token === '--keep-open') args.keepOpen = true;
  }

  args.email = args.email || process.env.NEWZENSITE_EMAIL || process.env.CMS_EMAIL || null;
  args.password = args.password || process.env.NEWZENSITE_PASSWORD || process.env.CMS_PASSWORD || null;
  args.statePath = args.statePath || STATE_PATH;
  return args;
}

function requireCredentials(options) {
  if (!options.email || !options.password) {
    throw new Error(
      'Missing CMS credentials. Supply --email/--password or set NEWZENSITE_EMAIL / NEWZENSITE_PASSWORD.'
    );
  }
}

async function fetchJson(page, url, options = {}) {
  const response = await page.evaluate(async ({ requestUrl, requestOptions }) => {
    const response = await fetch(requestUrl, {
      credentials: 'include',
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        ...(requestOptions.headers || {})
      }
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      payload
    };
  }, { requestUrl: url, requestOptions: options });

  return response;
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function loginCms(options) {
  requireCredentials(options);

  const browser = await chromium.launch({
    headless: options.headless,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: false
  });

  const page = await context.newPage();
  const loginUrl = `${options.baseUrl.replace(/\/$/, '')}/login`;

  try {
    console.log(`[cms-auth] Opening ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const csrfResult = await fetchJson(page, `${options.baseUrl}/api/auth/csrf`);
    if (!csrfResult.ok || !csrfResult.payload || !csrfResult.payload.csrfToken) {
      throw new Error(`Could not fetch CSRF token. Response: ${JSON.stringify(csrfResult)}`);
    }

    const csrfToken = csrfResult.payload.csrfToken;
    const callbackUrl = `${options.baseUrl}/login`;
    const formBody = new URLSearchParams({
      attribute: options.email,
      password: options.password,
      redirect: 'false',
      csrfToken,
      callbackUrl,
      json: 'true'
    }).toString();

    const loginResult = await page.evaluate(async ({ requestUrl, body }) => {
      const result = await fetch(requestUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body
      });

      const responseText = await result.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = responseText;
      }

      return {
        status: result.status,
        ok: result.ok,
        location: result.headers.get('location'),
        payload
      };
    }, {
      requestUrl: `${options.baseUrl}/api/auth/callback/credentials`,
      body: formBody
    });

    const locationHeader = loginResult.location || '';
    const hasLoginError = /error=|CredentialsSignin|invalid/i.test(locationHeader + ' ' + JSON.stringify(loginResult.payload || ''));
    if (!loginResult.ok || hasLoginError) {
      throw new Error(`CMS login failed: ${JSON.stringify(loginResult)}`);
    }

    const sessionResult = await fetchJson(page, `${options.baseUrl}/api/auth/session`);
    const user = sessionResult.payload && sessionResult.payload.user ? sessionResult.payload.user : null;
    if (!sessionResult.ok || !user) {
      throw new Error(`CMS session check failed: ${JSON.stringify(sessionResult)}`);
    }

    ensureParentDirectory(options.statePath);
    await context.storageState({ path: options.statePath });

    console.log('[cms-auth] CMS login successful');
    console.log('[cms-auth] Session saved to', options.statePath);
    console.log('[cms-auth] Logged in user:', user.email || user.name || JSON.stringify(user));

    if (options.keepOpen) {
      console.log('[cms-auth] Browser left open because --keep-open was passed.');
      return { browser, context, page, user };
    }

    await browser.close();
    return { browser: null, context: null, page: null, user };
  } catch (error) {
    console.error('[cms-auth] Login failed');
    console.error(error && error.stack ? error.stack : error);
    await browser.close().catch(() => {});
    process.exitCode = 1;
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('[cms-auth] Starting CMS auto-login flow');
  console.log('[cms-auth] Saving session to', options.statePath);
  await loginCms(options);
}

if (require.main === module) {
  main().catch(() => {
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  loginCms,
  fetchJson,
  requireCredentials
};
