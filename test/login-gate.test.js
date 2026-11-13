const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer } = require('../src/server');
const { SessionManager } = require('../src/session-manager');

test('requires verified CRM and CMS sessions before accepting a ticket job', async () => {
  const info = await startServer({ port: 0, host: '127.0.0.1', restoreSession: false });
  try {
    const sessionResponse = await fetch(`http://${info.host}:${info.port}/api/session`);
    const session = await sessionResponse.json();
    assert.equal(session.ready, false);

    const response = await fetch(`http://${info.host}:${info.port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketUrl: 'https://crm.fastboy.dev/tickets/detail/1580297' })
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /đăng nhập/i);
  } finally {
    await stopServer({ closeSession: false });
  }
});

test('opens the two-tab login flow even after a session is already ready', async () => {
  const manager = new SessionManager(process.cwd());
  manager.state = 'ready';
  manager.crmReady = true;
  manager.cmsReady = true;
  let launches = 0;
  manager.launchLoginTabs = async () => {
    launches += 1;
    manager.state = 'awaiting-login';
    return manager.snapshot();
  };

  const session = await manager.openLogin();
  assert.equal(launches, 1);
  assert.equal(session.state, 'awaiting-login');
  assert.equal(session.ready, false);
});
