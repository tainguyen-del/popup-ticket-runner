'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { appDataDirectory } = require('../app-paths');

const CREDENTIAL_FILENAME = 'newzensite-credentials.bin';

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function credentialPath(root, dataDirectory = appDataDirectory(root)) {
  return path.join(dataDirectory, CREDENTIAL_FILENAME);
}

function environmentCredentials(env = process.env) {
  const email = env.NEWZENSITE_EMAIL || env.CMS_EMAIL || '';
  const password = env.NEWZENSITE_PASSWORD || env.CMS_PASSWORD || '';
  return email.trim() && password
    ? { email: email.trim(), password }
    : null;
}

function validateCredentials({ email, password } = {}) {
  const identifier = typeof email === 'string' ? email.trim() : '';
  if (!identifier || identifier.length > 254 || /[\r\n]/.test(identifier)) {
    const error = new Error('Hãy nhập tài khoản CMS hợp lệ.');
    error.code = 'cms-credential-invalid';
    throw error;
  }
  if (typeof password !== 'string' || !password || password.length > 1024) {
    const error = new Error('Hãy nhập mật khẩu CMS hợp lệ.');
    error.code = 'cms-credential-invalid';
    throw error;
  }
  return { email: identifier, password };
}

function saveStoredCredentials(root, credentials, {
  dataDirectory,
  platform = process.platform,
  execute = spawnSync
} = {}) {
  const normalized = validateCredentials(credentials);
  if (platform !== 'win32') {
    const error = new Error('CMS credential storage requires Windows DPAPI.');
    error.code = 'cms-credential-platform';
    throw error;
  }

  const filePath = credentialPath(root, dataDirectory);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "if ([string]::IsNullOrWhiteSpace($payload.email) -or [string]::IsNullOrEmpty($payload.password)) { throw 'Invalid credentials.' }",
    '$securePayload = $payload | ConvertTo-Json -Compress',
    '$secure = ConvertTo-SecureString -String $securePayload -AsPlainText -Force',
    '$encrypted = ConvertFrom-SecureString -SecureString $secure',
    '$directory = [IO.Path]::GetDirectoryName($env:POPUP_TICKET_RUNNER_CREDENTIAL_PATH)',
    '[IO.Directory]::CreateDirectory($directory) | Out-Null',
    '[IO.File]::WriteAllText($env:POPUP_TICKET_RUNNER_CREDENTIAL_TEMP_PATH, $encrypted)',
    'Move-Item -LiteralPath $env:POPUP_TICKET_RUNNER_CREDENTIAL_TEMP_PATH -Destination $env:POPUP_TICKET_RUNNER_CREDENTIAL_PATH -Force',
    '$payload.password = $null',
    '$securePayload = $null',
    '$payload = $null',
    '$secure.Dispose()'
  ].join('\n');
  try {
    const result = execute('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)
    ], {
      input: JSON.stringify(normalized),
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        POPUP_TICKET_RUNNER_CREDENTIAL_PATH: filePath,
        POPUP_TICKET_RUNNER_CREDENTIAL_TEMP_PATH: temporaryPath
      },
      maxBuffer: 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error('Không thể mã hóa và lưu credential CMS trên máy này.');
      error.code = 'cms-credential-save-failed';
      throw error;
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
  return { configured: true, source: 'secure-storage' };
}

function clearStoredCredentials(root, { dataDirectory } = {}) {
  const filePath = credentialPath(root, dataDirectory);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function cmsCredentialStatus(root, {
  dataDirectory,
  env = process.env,
  platform = process.platform,
  execute = execFileSync
} = {}) {
  const environment = environmentCredentials(env);
  const storedPath = credentialPath(root, dataDirectory);
  const stored = fs.existsSync(storedPath);
  let storedCredentials = null;
  let needsReconfigure = false;
  if (stored) {
    try {
      storedCredentials = readStoredCredentials(root, { dataDirectory, platform, execute });
    } catch (error) {
      if (error?.code !== 'cms-credential-decryption-failed') throw error;
      // A DPAPI blob is bound to the Windows user that encrypted it. Treat a
      // blob that cannot be decrypted as recoverable configuration state so
      // the local UI can replace it instead of returning an HTTP 500.
      needsReconfigure = true;
    }
  }
  const credentials = storedCredentials || environment;
  return {
    configured: Boolean(credentials),
    source: storedCredentials ? 'secure-storage' : (environment ? 'environment' : null),
    identifier: credentials?.email || null,
    hasPassword: Boolean(credentials?.password),
    needsReconfigure,
    canSave: platform === 'win32'
  };
}

function readStoredCredentials(root, {
  dataDirectory,
  platform = process.platform,
  execute = execFileSync
} = {}) {
  const filePath = credentialPath(root, dataDirectory);
  if (!fs.existsSync(filePath)) return null;
  if (platform !== 'win32') {
    const error = new Error('CMS credential file can only be decrypted by the Windows user who saved it.');
    error.code = 'cms-credential-platform';
    throw error;
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$encrypted = [IO.File]::ReadAllText($env:POPUP_TICKET_RUNNER_CREDENTIAL_PATH)",
    '$secure = ConvertTo-SecureString -String $encrypted',
    '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try {',
    '  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)',
    '  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))',
    '} finally {',
    '  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)',
    '}'
  ].join('\n');

  try {
    const output = execute('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, POPUP_TICKET_RUNNER_CREDENTIAL_PATH: filePath }
    });
    const plain = Buffer.from(String(output).trim(), 'base64').toString('utf8');
    const credentials = JSON.parse(plain);
    if (typeof credentials.email !== 'string' || !credentials.email.trim()
      || typeof credentials.password !== 'string' || !credentials.password) {
      throw new Error('Invalid credentials payload.');
    }
    return { email: credentials.email.trim(), password: credentials.password };
  } catch (cause) {
    const error = new Error('Không thể giải mã credential CMS đã lưu bằng tài khoản Windows hiện tại.');
    error.code = 'cms-credential-decryption-failed';
    error.cause = cause;
    throw error;
  }
}

function getCmsCredentials(root, options = {}) {
  const fromEnvironment = environmentCredentials(options.env || process.env);
  try {
    const stored = readStoredCredentials(root, options);
    return stored || fromEnvironment;
  } catch (error) {
    if (error?.code === 'cms-credential-decryption-failed' && fromEnvironment) {
      return fromEnvironment;
    }
    throw error;
  }
}

function saveCredentialsInteractively(root, {
  dataDirectory,
  platform = process.platform,
  execute = spawnSync
} = {}) {
  if (platform !== 'win32') {
    const error = new Error('CMS credential setup requires Windows DPAPI.');
    error.code = 'cms-credential-platform';
    throw error;
  }

  const filePath = credentialPath(root, dataDirectory);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$email = (Read-Host 'NewZenSite email').Trim()",
    "if ([string]::IsNullOrWhiteSpace($email)) { throw 'Email is required.' }",
    "$securePassword = Read-Host 'NewZenSite password' -AsSecureString",
    '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)',
    'try {',
    '  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)',
    '  $payload = @{ email = $email; password = $password } | ConvertTo-Json -Compress',
    '  $securePayload = ConvertTo-SecureString -String $payload -AsPlainText -Force',
    '  $encrypted = ConvertFrom-SecureString -SecureString $securePayload',
    '  $directory = [IO.Path]::GetDirectoryName($env:POPUP_TICKET_RUNNER_CREDENTIAL_PATH)',
    '  [IO.Directory]::CreateDirectory($directory) | Out-Null',
    '  [IO.File]::WriteAllText($env:POPUP_TICKET_RUNNER_CREDENTIAL_PATH, $encrypted)',
    "  Write-Output 'CMS credentials encrypted and saved for this Windows user.'",
    '} finally {',
    '  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)',
    '  $password = $null',
    '  $payload = $null',
    '}'
  ].join('\n');

  const result = execute('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedPowerShell(script)
  ], {
    stdio: 'inherit',
    windowsHide: false,
    env: { ...process.env, POPUP_TICKET_RUNNER_CREDENTIAL_PATH: filePath }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error('CMS credential setup did not complete.');
    error.code = 'cms-credential-setup-failed';
    throw error;
  }
  return filePath;
}

module.exports = {
  CREDENTIAL_FILENAME,
  credentialPath,
  clearStoredCredentials,
  cmsCredentialStatus,
  environmentCredentials,
  getCmsCredentials,
  readStoredCredentials,
  saveCredentialsInteractively,
  saveStoredCredentials,
  validateCredentials
};
