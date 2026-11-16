const {
  hasStoredSession,
  clearStoredSession,
  launchToolBrowser,
  launchLoginBrowser,
  persistStoredSession,
  readActiveLoginProfile,
  persistActiveLoginProfile,
  clearActiveLoginProfile,
  focusLoginBrowser,
  closeToolBrowser
} = require('./browser-session');
const { getCmsCredentials } = require('./cms/credential-store');

const CRM_CHECK_URL = 'https://crm.fastboy.dev/tickets/views/technical';
const CMS_CHECK_URL = 'https://apps.newzensite.com/organizations';

function shortLoginError(error) {
  const detail = `${error?.message || ''}\n${error?.stack || ''}`;
  if (/ProcessSingleton|profile directory.*(?:in use|lock)|Lock file.*access is denied/i.test(detail)) {
    return 'Phiên Chrome cũ không thể được dùng lại. Hãy bấm mở Chrome để app tạo một phiên đăng nhập mới.';
  }
  return 'Không thể mở hoặc kiểm tra phiên đăng nhập. Hãy kiểm tra Chrome, mạng và thử lại.';
}

async function crmAuthenticated(page) {
  try {
    await page.goto(CRM_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (document.body?.innerText || '').trim().length > 100, { timeout: 15000 }).catch(() => {});
    return await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const url = location.href.toLowerCase();
      const loginForm = Boolean(document.querySelector('input[type="password"], input[name*="password" i]'));
      const loginPage = /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/.test(url) || /\b(sign in|log in|đăng nhập)\b/i.test(body.slice(0, 800));
      return !loginForm && !loginPage
        && /\/tickets\/views\/technical(?:[/?#]|$)/.test(url)
        && body.length > 100;
    });
  } catch {
    return false;
  }
}

async function cmsAuthenticated(page) {
  try {
    await page.goto(CMS_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (document.body?.innerText || '').trim().length > 100, { timeout: 15000 }).catch(() => {});
    return await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const url = location.href.toLowerCase();
      const loginForm = Boolean(document.querySelector('input[type="password"], input[name*="password" i]'));
      const loginPage = /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/.test(url) || /\b(sign in|log in|đăng nhập)\b/i.test(body.slice(0, 800));
      return !loginForm && !loginPage && /\bOrganizations\b/i.test(body) && /\bfastboy\b/i.test(body);
    });
  } catch {
    return false;
  }
}

class SessionManager {
  constructor(root) {
    this.root = root;
    this.browser = null;
    this.context = null;
    this.crmPage = null;
    this.cmsPage = null;
    this.loginProfileDirectory = null;
    this.loginLaunchedAt = null;
    this.state = 'required';
    this.crmReady = false;
    this.cmsReady = false;
    this.error = null;
    this.restorePromise = null;
    this.operationEpoch = 0;
  }

  snapshot() {
    const loginWindowOpen = this.loginWindowIsAlive();
    return {
      state: this.state,
      ready: this.state === 'ready' && this.crmReady && this.cmsReady,
      loginWindowOpen,
      loginTabs: loginWindowOpen ? 2 : 0,
      crm: { ready: this.crmReady },
      cms: { ready: this.cmsReady },
      error: this.error
    };
  }

  async openLogin({ fresh = false } = {}) {
    // An explicit click must open the two visible tabs immediately. A slow
    // background session check must never make the login button appear to do
    // nothing for tens of seconds.
    this.operationEpoch = (this.operationEpoch || 0) + 1;
    let reopenProfileDirectory = null;
    if (this.context && !this.loginWindowIsAlive()) {
      // A Chrome window can be closed from its title bar while Playwright
      // still has stale references. Preserve its app-owned profile so a
      // click on “Hiện cửa sổ” restores the same login instead of asking the
      // operator to authenticate again.
      reopenProfileDirectory = this.loginProfileDirectory;
      await this.closeContext({ cleanupProfile: false });
    }
    if (fresh) {
      try {
        await this.closeContext({ cleanupProfile: true });
        clearActiveLoginProfile(this.root, { removeProfile: true });
        clearStoredSession(this.root);
        this.crmReady = false;
        this.cmsReady = false;
        reopenProfileDirectory = null;
      } catch (error) {
        this.state = 'required';
        this.error = 'Không thể xoá phiên đăng nhập cũ trên máy này.';
        return this.snapshot();
      }
    }
    if (!fresh && !reopenProfileDirectory) {
      // After a successful verification the interactive Chrome context is
      // intentionally closed, but its app-owned profile is kept. Reopen it
      // so the operator can always see exactly the CRM and CMS tabs again.
      reopenProfileDirectory = readActiveLoginProfile(this.root);
    }
    if (this.context) {
      this.state = 'awaiting-login';
      // page.bringToFront() selects a tab only. Restore and focus the actual
      // Chrome window as well; if it cannot be surfaced, reopen the same
      // app-owned profile rather than creating a new login session.
      if (await this.revealLoginWindow()) return this.snapshot();
      reopenProfileDirectory = this.loginProfileDirectory;
      await this.closeContext({ cleanupProfile: false });
    }
    this.state = 'opening-login';
    this.error = null;
    return this.launchLoginTabs(reopenProfileDirectory);
  }

  async launchLoginTabs(reopenProfileDirectory = null) {
    try {
      // Use a new persistent *temporary* profile only for interactive login.
      // This produces a visible Chrome window and does not touch any normal
      // Chrome profile or its currently-open tabs.
      const launched = await launchLoginBrowser(this.root, reopenProfileDirectory
        ? { profileDirectory: reopenProfileDirectory }
        : undefined);
      this.browser = launched.browser;
      this.context = launched.context;
      this.loginProfileDirectory = launched.profileDirectory;
      this.loginLaunchedAt = launched.launchedAt || new Date().toISOString();
      const pages = this.context.pages();
      this.crmPage = pages[0] || await this.context.newPage();
      this.cmsPage = pages[1] || await this.context.newPage();
      // This is a profile owned solely by the tool. Normalise its restored
      // tabs so reopening the login window never leaves an old ticket tab in
      // place of CRM/CMS, nor keeps silently accumulating browser tabs.
      await Promise.all(pages.slice(2).map((page) => page.close().catch(() => {})));
      // The login window must become usable immediately. Waiting for both
      // third-party pages to finish navigation can take 45 seconds and used
      // to leave the local UI permanently showing “checking”.
      this.state = 'awaiting-login';
      void Promise.allSettled([
        this.crmPage.goto(CRM_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }),
        this.cmsPage.goto(CMS_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      ]).then(async () => {
        const didAutoLoginCms = await this.autoLoginCmsIfConfigured();
        if (didAutoLoginCms) this.cmsReady = await cmsAuthenticated(this.cmsPage);
        await this.revealLoginWindow();
      });
      void this.revealLoginWindow();
      return this.snapshot();
    } catch (error) {
      this.error = shortLoginError(error);
      this.state = 'required';
      await this.closeContext({ cleanupProfile: true });
      return this.snapshot();
    }
  }

  loginWindowIsAlive() {
    try {
      if (!this.context || !this.crmPage || !this.cmsPage) return false;
      if (typeof this.browser?.isConnected === 'function' && !this.browser.isConnected()) return false;
      if (typeof this.crmPage.isClosed === 'function' && this.crmPage.isClosed()) return false;
      if (typeof this.cmsPage.isClosed === 'function' && this.cmsPage.isClosed()) return false;
      return true;
    } catch {
      return false;
    }
  }

  async revealLoginWindow() {
    const loginPage = this.cmsPage || this.crmPage;
    if (loginPage) await loginPage.bringToFront().catch(() => {});
    return focusLoginBrowser(this.loginProfileDirectory, {
      launchedAfter: this.loginLaunchedAt
    }).catch(() => false);
  }

  async autoLoginCmsIfConfigured() {
    if (!this.context || !this.cmsPage) return false;

    let credentials;
    try {
      credentials = getCmsCredentials(this.root);
    } catch {
      this.error = 'Không thể đọc credential CMS đã lưu. Hãy cấu hình lại bằng lệnh node .\\src\\cms\\configure-login.js.';
      return false;
    }
    if (!credentials) return false;

    let stage = 'opening-cms-login';
    try {
      await this.cmsPage.goto('https://apps.newzensite.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });

      stage = 'fetching-csrf';
      const csrfResult = await this.cmsPage.evaluate(async () => {
        const response = await fetch('/api/auth/csrf', { credentials: 'include' });
        const payload = await response.json().catch(() => ({}));
        return {
          ok: response.ok,
          csrfToken: payload?.csrfToken || null
        };
      });

      if (!csrfResult.ok || !csrfResult.csrfToken) {
        this.error = 'Không lấy được CSRF token từ NewZenSite; đăng nhập CMS tự động đã dừng.';
        return false;
      }

      stage = 'submitting-cms-credentials';
      const loginResult = await this.cmsPage.evaluate(async ({ emailValue, passwordValue, csrfToken }) => {
        const formBody = new URLSearchParams({
          attribute: emailValue,
          password: passwordValue,
          redirect: 'false',
          csrfToken,
          callbackUrl: 'https://apps.newzensite.com/login',
          json: 'true'
        }).toString();

        const response = await fetch('/api/auth/callback/credentials', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: formBody
        });

        const rawText = await response.text();
        let payload = null;
        try {
          payload = rawText ? JSON.parse(rawText) : null;
        } catch {
          payload = rawText;
        }

        return {
          ok: response.ok,
          status: response.status,
          location: response.headers.get('location') || '',
          payload
        };
      }, {
        emailValue: credentials.email,
        passwordValue: credentials.password,
        csrfToken: csrfResult.csrfToken
      });

      const loginFailureText = `${loginResult.location || ''} ${JSON.stringify(loginResult.payload || '')}`;
      if (!loginResult.ok || /CredentialsSignin|error=|invalid/i.test(loginFailureText)) {
        this.error = `NewZenSite từ chối đăng nhập tự động (HTTP ${loginResult.status}). Kiểm tra credential hoặc tiếp tục đăng nhập thủ công.`;
        return false;
      }

      stage = 'verifying-cms-session';
      const sessionResult = await this.cmsPage.evaluate(async () => {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        const payload = await response.json().catch(() => null);
        return {
          ok: response.ok,
          payload
        };
      });

      if (!sessionResult.ok || !sessionResult.payload || !sessionResult.payload.user) {
        this.error = 'NewZenSite chưa tạo session sau khi gửi thông tin đăng nhập; hãy tiếp tục đăng nhập thủ công.';
        return false;
      }

      stage = 'saving-cms-session';
      await persistStoredSession(this.context, this.root);
      persistActiveLoginProfile(this.root, this.loginProfileDirectory);
      return true;
    } catch (error) {
      this.error = `Tự động đăng nhập CMS thất bại ở bước ${stage}: ${error?.message || 'lỗi không xác định'}`;
      return false;
    }
  }

  async verifyLogin() {
    // A visible login context takes precedence over an older headless restore
    // probe. Otherwise the operator can sign in and press Check yet receive
    // the stale probe result instead of a real verification.
    if (this.restorePromise && !this.context) return this.restorePromise;
    if (!this.context || !this.crmPage || !this.cmsPage) {
      this.state = 'required';
      this.error = 'Hãy mở cửa sổ đăng nhập CRM và CMS trước.';
      return this.snapshot();
    }
    this.state = 'checking-login';
    this.error = null;
    [this.crmReady, this.cmsReady] = await Promise.all([
      crmAuthenticated(this.crmPage),
      cmsAuthenticated(this.cmsPage)
    ]);

    if (!this.cmsReady) {
      const didAutoLoginCms = await this.autoLoginCmsIfConfigured();
      if (didAutoLoginCms) {
        this.cmsReady = await cmsAuthenticated(this.cmsPage);
      }
    }

    if (this.crmReady && this.cmsReady) {
      try {
        await persistStoredSession(this.context, this.root);
        persistActiveLoginProfile(this.root, this.loginProfileDirectory);
      } catch {
        this.state = 'awaiting-login';
        this.error = 'Đã đăng nhập nhưng app không thể lưu phiên cục bộ. Hãy kiểm tra quyền ghi rồi thử lại.';
        return this.snapshot();
      }
      // Closing releases Chrome's profile lock, but preserve this app-owned
      // temporary profile for the visible ticket-run window that follows.
      await this.closeContext({ cleanupProfile: false });
      this.state = 'ready';
      return this.snapshot();
    }
    this.state = 'awaiting-login';
    this.error = !this.crmReady && !this.cmsReady
      ? 'CRM và CMS chưa đăng nhập được.'
      : (!this.crmReady ? 'CRM chưa đăng nhập được.' : 'CMS chưa đăng nhập được hoặc không có Organization fastboy.');
    return this.snapshot();
  }

  async cancelLogin() {
    await this.closeContext({ cleanupProfile: true });
    clearActiveLoginProfile(this.root, { removeProfile: true });
    this.state = 'required';
    this.crmReady = false;
    this.cmsReady = false;
    this.error = null;
    return this.snapshot();
  }

  async restoreStoredSession() {
    if (this.context) return this.snapshot();
    if (this.restorePromise) return this.restorePromise;
    // Do not launch a browser at all until there is a local saved session.
    // This prevents a first app launch from colliding with any old Chrome
    // window, while still keeping a verified session available next time.
    if (!hasStoredSession(this.root)) {
      this.state = 'required';
      this.crmReady = false;
      this.cmsReady = false;
      this.error = null;
      return this.snapshot();
    }
    this.state = 'checking-login';
    this.crmReady = false;
    this.cmsReady = false;
    this.error = null;
    const restoreEpoch = this.operationEpoch || 0;
    this.restorePromise = (async () => {
      let browser = null;
      let context = null;
      try {
        const launched = await launchToolBrowser(this.root, { headless: true });
        browser = launched.browser;
        context = launched.context;
        const pages = context.pages();
        const crmPage = pages[0] || await context.newPage();
        const cmsPage = pages[1] || await context.newPage();
        const [crmReady, cmsReady] = await Promise.all([
          crmAuthenticated(crmPage),
          cmsAuthenticated(cmsPage)
        ]);
        // A user click on the visible login button wins over this background
        // probe. Do not let a late probe overwrite that newer state.
        if (restoreEpoch !== (this.operationEpoch || 0)) return this.snapshot();
        this.crmReady = crmReady;
        this.cmsReady = cmsReady;
        if (crmReady && cmsReady) {
          await persistStoredSession(context, this.root).catch(() => {});
          this.state = 'ready';
        } else {
          this.state = 'required';
          this.error = null;
        }
      } catch (error) {
        if (restoreEpoch !== (this.operationEpoch || 0)) return this.snapshot();
        this.crmReady = false;
        this.cmsReady = false;
        this.state = 'required';
        this.error = shortLoginError(error);
      } finally {
        await closeToolBrowser({ browser, context });
        this.restorePromise = null;
      }
      return this.snapshot();
    })();
    return this.restorePromise;
  }

  requireLogin(reason = null) {
    this.state = 'required';
    this.crmReady = false;
    this.cmsReady = false;
    this.error = reason;
  }

  async closeContext({ cleanupProfile = false } = {}) {
    const browser = this.browser;
    const context = this.context;
    const profileDirectory = this.loginProfileDirectory;
    this.browser = null;
    this.context = null;
    this.crmPage = null;
    this.cmsPage = null;
    this.loginProfileDirectory = null;
    this.loginLaunchedAt = null;
    await closeToolBrowser({ browser, context, profileDirectory, cleanupProfile });
  }
}

module.exports = { SessionManager };
