'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEY_FILENAME = 'gemini-api-key.bin';
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 512;
const DEFAULT_GEMINI_API_KEY = Buffer.from(
  'QVEuQWI4Uk42TEpDM0xoMjM4OXJDMzlvT25xYkNuazVWYmhlcExtTVdFNUZvanRYSTI0X0E=',
  'base64'
).toString('utf8');

function normalizedKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    const error = new Error('Gemini API key không hợp lệ.');
    error.code = 'gemini-key-invalid';
    throw error;
  }
  return key;
}

class GeminiKeyStore {
  constructor({ dataDirectory, safeStorage = null, env = process.env } = {}) {
    if (!dataDirectory) throw new Error('Gemini key store requires a data directory.');
    this.dataDirectory = path.resolve(dataDirectory);
    this.keyPath = path.join(this.dataDirectory, KEY_FILENAME);
    this.safeStorage = safeStorage;
    this.env = env || {};
    this.cachedStoredKey = null;
  }

  environmentKey() {
    const value = this.env.GEMINI_API_KEY || this.env.POPUP_TICKET_RUNNER_GEMINI_KEY || '';
    try {
      return normalizedKey(value);
    } catch {
      return '';
    }
  }

  encryptionAvailable() {
    if (!this.safeStorage
      || typeof this.safeStorage.encryptString !== 'function'
      || typeof this.safeStorage.decryptString !== 'function') return false;
    return typeof this.safeStorage.isEncryptionAvailable !== 'function'
      || this.safeStorage.isEncryptionAvailable() === true;
  }

  storedKey() {
    if (this.cachedStoredKey) return this.cachedStoredKey;
    if (!this.encryptionAvailable() || !fs.existsSync(this.keyPath)) return '';
    try {
      const encrypted = fs.readFileSync(this.keyPath);
      const key = normalizedKey(this.safeStorage.decryptString(encrypted));
      this.cachedStoredKey = key;
      return key;
    } catch {
      return '';
    }
  }

  getKey() {
    return this.environmentKey() || this.storedKey() || DEFAULT_GEMINI_API_KEY;
  }

  status() {
    const environmentKey = this.environmentKey();
    const storedKey = environmentKey ? '' : this.storedKey();
    const activeKey = environmentKey || storedKey || DEFAULT_GEMINI_API_KEY;
    return {
      configured: Boolean(activeKey),
      source: environmentKey ? 'environment' : (storedKey ? 'secure-storage' : 'built-in'),
      canSave: this.encryptionAvailable(),
      secureStorage: this.encryptionAvailable()
    };
  }

  saveKey(value) {
    const key = normalizedKey(value);
    if (!this.encryptionAvailable()) {
      const error = new Error('Bản chạy này không có kho mã hóa Windows. Hãy dùng app portable hoặc cấu hình GEMINI_API_KEY.');
      error.code = 'gemini-secure-storage-unavailable';
      throw error;
    }
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    const encrypted = this.safeStorage.encryptString(key);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      const error = new Error('Không thể mã hóa Gemini API key.');
      error.code = 'gemini-key-encryption-failed';
      throw error;
    }
    const temporaryPath = `${this.keyPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, encrypted, { flag: 'w' });
      fs.renameSync(temporaryPath, this.keyPath);
      this.cachedStoredKey = key;
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
    return this.status();
  }
}

module.exports = {
  GeminiKeyStore,
  KEY_FILENAME,
  normalizedKey
};
