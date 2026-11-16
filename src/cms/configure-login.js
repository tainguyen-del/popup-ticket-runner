#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { saveCredentialsInteractively } = require('./credential-store');

try {
  const savedPath = saveCredentialsInteractively(path.resolve(__dirname, '..', '..'));
  console.log(`Encrypted CMS credentials saved at ${savedPath}`);
  console.log('The password is protected with Windows DPAPI and is readable only by this Windows user.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
