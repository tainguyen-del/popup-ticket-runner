'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CREDENTIAL_FILENAME,
  clearStoredCredentials,
  credentialPath,
  cmsCredentialStatus,
  environmentCredentials,
  getCmsCredentials,
  readStoredCredentials,
  saveCredentialsInteractively,
  saveStoredCredentials
} = require('../src/cms/credential-store');

test('prefers complete credentials from environment without touching secure storage', () => {
  const credentials = environmentCredentials({
    NEWZENSITE_EMAIL: 'operator@example.com',
    NEWZENSITE_PASSWORD: 'local-secret'
  });
  assert.deepEqual(credentials, { email: 'operator@example.com', password: 'local-secret' });
});

test('does not use partial environment credentials', () => {
  assert.equal(environmentCredentials({ NEWZENSITE_EMAIL: 'operator@example.com' }), null);
});

test('returns no stored credentials when the encrypted file does not exist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  try {
    assert.equal(readStoredCredentials(directory, { dataDirectory: directory, platform: 'win32' }), null);
    assert.equal(fs.existsSync(path.join(directory, CREDENTIAL_FILENAME)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('uses stored credentials before environment credentials when both exist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  const storedPath = credentialPath(directory, directory);
  fs.writeFileSync(storedPath, 'encrypted');
  const credentials = getCmsCredentials('unused-root', {
    env: { CMS_EMAIL: 'user@example.com', CMS_PASSWORD: 'secret' },
    dataDirectory: directory,
    platform: 'win32',
    execute: () => Buffer.from(JSON.stringify({
      email: 'stored-user@example.com',
      password: 'stored-secret'
    })).toString('base64')
  });
  assert.deepEqual(credentials, { email: 'stored-user@example.com', password: 'stored-secret' });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('rejects reading an encrypted credential file on non-Windows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  try {
    fs.writeFileSync(credentialPath(directory, directory), 'encrypted');
    assert.throws(
      () => readStoredCredentials(directory, { dataDirectory: directory, platform: 'linux' }),
      { code: 'cms-credential-platform' }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects interactive credential setup outside Windows', () => {
  assert.throws(
    () => saveCredentialsInteractively(process.cwd(), { platform: 'linux' }),
    { code: 'cms-credential-platform' }
  );
});

test('saves credentials through the DPAPI helper without putting them in command arguments', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  try {
    let commandArguments;
    let processOptions;
    const status = saveStoredCredentials(directory, {
      email: 'operator@example.com',
      password: 'a-secret-password'
    }, {
      dataDirectory: directory,
      platform: 'win32',
      execute: (_command, args, options) => {
        commandArguments = args;
        processOptions = options;
        return { status: 0 };
      }
    });

    assert.deepEqual(status, { configured: true, source: 'secure-storage' });
    assert.equal(commandArguments.join(' ').includes('a-secret-password'), false);
    assert.equal(processOptions.input.includes('a-secret-password'), true);
    assert.equal(processOptions.env.POPUP_TICKET_RUNNER_CREDENTIAL_PATH, credentialPath(directory, directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('validates account and password before invoking DPAPI', () => {
  let invoked = false;
  assert.throws(
    () => saveStoredCredentials(process.cwd(), { email: '', password: '' }, {
      platform: 'win32',
      execute: () => { invoked = true; return { status: 0 }; }
    }),
    { code: 'cms-credential-invalid' }
  );
  assert.equal(invoked, false);
});

test('reports credential status without returning username or password', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  try {
    const status = cmsCredentialStatus(directory, {
      dataDirectory: directory,
      env: { CMS_EMAIL: 'operator@example.com', CMS_PASSWORD: 'secret' }
    });
    assert.equal(status.configured, true);
    assert.equal(status.source, 'environment');
    assert.equal(status.identifier, 'operator@example.com');
    assert.equal(status.hasPassword, true);
    assert.equal('password' in status, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reports a recoverable state when the stored DPAPI credential cannot be decrypted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  try {
    fs.writeFileSync(credentialPath(directory, directory), 'encrypted-for-another-user');
    const status = cmsCredentialStatus(directory, {
      dataDirectory: directory,
      env: {},
      platform: 'win32',
      execute: () => { throw new Error('DPAPI unavailable for this user'); }
    });
    assert.equal(status.configured, false);
    assert.equal(status.source, null);
    assert.equal(status.identifier, null);
    assert.equal(status.hasPassword, false);
    assert.equal(status.needsReconfigure, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('falls back to complete environment credentials when stored DPAPI credentials cannot be decrypted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  try {
    fs.writeFileSync(credentialPath(directory, directory), 'encrypted-for-another-user');
    const credentials = getCmsCredentials(directory, {
      dataDirectory: directory,
      env: { CMS_EMAIL: 'operator@example.com', CMS_PASSWORD: 'environment-secret' },
      platform: 'win32',
      execute: () => { throw new Error('DPAPI unavailable for this user'); }
    });
    assert.deepEqual(credentials, { email: 'operator@example.com', password: 'environment-secret' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removes only the app-owned CMS credential file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-cms-credentials-'));
  const filePath = credentialPath(directory, directory);
  try {
    fs.writeFileSync(filePath, 'encrypted');
    assert.equal(clearStoredCredentials(directory, { dataDirectory: directory }), true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(clearStoredCredentials(directory, { dataDirectory: directory }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
