'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GeminiKeyStore, KEY_FILENAME, normalizedKey } = require('../src/gemini-key-store');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice('cipher:'.length), 'base64').toString('utf8')
  };
}

test('GeminiKeyStore encrypts a saved key and never returns it in status', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-gemini-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const apiKey = 'test-gemini-key-that-is-long-enough-123456789';
  const store = new GeminiKeyStore({ dataDirectory: directory, safeStorage: fakeSafeStorage(), env: {} });

  const status = store.saveKey(apiKey);
  assert.deepEqual(status, {
    configured: true,
    source: 'secure-storage',
    canSave: true,
    secureStorage: true
  });
  assert.equal(store.getKey(), apiKey);
  const raw = fs.readFileSync(path.join(directory, KEY_FILENAME));
  assert.equal(raw.includes(Buffer.from(apiKey)), false);
  assert.equal(JSON.stringify(status).includes(apiKey), false);

  const replacementKey = 'replacement-gemini-key-that-is-long-enough-987654321';
  store.saveKey(replacementKey);
  assert.equal(store.getKey(), replacementKey);
  const replacedRaw = fs.readFileSync(path.join(directory, KEY_FILENAME));
  assert.equal(replacedRaw.includes(Buffer.from(replacementKey)), false);

  const reopened = new GeminiKeyStore({ dataDirectory: directory, safeStorage: fakeSafeStorage(), env: {} });
  assert.equal(reopened.getKey(), replacementKey);
  assert.equal(reopened.status().configured, true);
});

test('environment key remains supported without secure storage', () => {
  const apiKey = 'environment-gemini-key-long-enough-12345';
  const store = new GeminiKeyStore({
    dataDirectory: path.join(os.tmpdir(), 'not-used-gemini-key-store'),
    env: { GEMINI_API_KEY: apiKey }
  });
  assert.equal(store.getKey(), apiKey);
  assert.deepEqual(store.status(), {
    configured: true,
    source: 'environment',
    canSave: false,
    secureStorage: false
  });
  assert.throws(() => store.saveKey(apiKey), { code: 'gemini-secure-storage-unavailable' });
});

test('invalid Gemini keys are rejected before persistence', () => {
  assert.throws(() => normalizedKey('short'), { code: 'gemini-key-invalid' });
  assert.throws(() => normalizedKey(`valid-looking-key with-space-${'x'.repeat(30)}`), { code: 'gemini-key-invalid' });
});
