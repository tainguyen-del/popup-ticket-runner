const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateDownloadedImage,
  cmsSafeUploadFilename,
  stageCmsUploadImage
} = require('../src/run');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9lQAAAABJRU5ErkJggg==',
  'base64'
);

test('creates an ASCII-safe CMS upload filename for special-character posters', () => {
  const filename = cmsSafeUploadFilename('Ưu đãi #50% (final)?!.PNG', 'a'.repeat(64), 'png');
  assert.match(filename, /^popup-[a-z0-9-]+-aaaaaaaaaaaa\.png$/);
  assert.equal(/[\s#%?&/\\'"<>:|]/.test(filename), false);
});

test('stages a CMS-safe copy without modifying the downloaded ticket poster', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-runner-upload-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'Poster #50% (Final).PNG');
  fs.writeFileSync(originalPath, PNG);
  const attachment = validateDownloadedImage(originalPath);
  const staged = stageCmsUploadImage(attachment, directory);

  assert.equal(fs.existsSync(originalPath), true);
  assert.equal(fs.existsSync(staged.uploadPath), true);
  assert.notEqual(staged.uploadPath, originalPath);
  assert.equal(/[\s#%?&/\\'"<>:|]/.test(staged.uploadFilename), false);
  assert.equal(validateDownloadedImage(staged.uploadPath).sha256, attachment.sha256);
});
