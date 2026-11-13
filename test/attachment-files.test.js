const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  imageFiles,
  validateDownloadedImage,
  cmsSafeUploadFilename,
  stageCmsUploadImage,
  geminiVisionMimeType,
  visionCandidatesFromDownloads,
  visionCandidateFromLocalImage,
  preparePopupRemovalVision
} = require('../src/crm/attachment-files');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9lQAAAABJRU5ErkJggg==',
  'base64'
);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-ticket-attachment-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const poster = path.join(directory, 'Poster #50%.PNG');
  fs.writeFileSync(poster, PNG);
  return { directory, poster };
}

test('discovers and validates supported image files recursively', (t) => {
  const { directory, poster } = fixture(t);
  const nested = path.join(directory, 'nested');
  fs.mkdirSync(nested);
  const second = path.join(nested, 'second.jpg');
  fs.writeFileSync(second, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  fs.writeFileSync(path.join(nested, 'note.txt'), 'not an image');

  assert.deepEqual(new Set(imageFiles(directory)), new Set([poster, second]));
  const validated = validateDownloadedImage(poster);
  assert.equal(validated.extension, 'png');
  assert.equal(validated.bytes, PNG.length);
  assert.match(validated.sha256, /^[a-f0-9]{64}$/);
});

test('creates and stages an ASCII-safe byte-identical CMS upload copy', (t) => {
  const { directory, poster } = fixture(t);
  const attachment = validateDownloadedImage(poster);
  const safeName = cmsSafeUploadFilename('Æ¯u đãi #50%?.PNG', attachment.sha256, 'png');
  assert.match(safeName, /^popup-[a-z0-9-]+-[a-f0-9]{12}\.png$/);
  assert.equal(/[\s#%?&/\\'"<>:|]/.test(safeName), false);

  const staged = stageCmsUploadImage(attachment, directory);
  assert.equal(fs.existsSync(staged.uploadPath), true);
  assert.notEqual(staged.uploadPath, poster);
  assert.equal(validateDownloadedImage(staged.uploadPath).sha256, attachment.sha256);
});

test('builds local Gemini candidates with attachment context only', (t) => {
  const { poster } = fixture(t);
  assert.equal(geminiVisionMimeType(poster), 'image/png');
  assert.equal(geminiVisionMimeType('poster.gif'), null);
  const download = { ...validateDownloadedImage(poster), candidateIndex: 2 };
  const prepared = visionCandidatesFromDownloads([download], [
    { index: 2, context: 'Popup requested in this comment.' }
  ]);
  assert.equal(prepared.warnings.length, 0);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].index, 2);
  assert.equal(prepared.candidates[0].context, 'Popup requested in this comment.');
  assert.equal(Buffer.from(prepared.candidates[0].base64, 'base64').equals(PNG), true);
});

test('prepares a local ticket reference and CMS popup set for removal Vision', (t) => {
  const { poster } = fixture(t);
  const reference = visionCandidateFromLocalImage({ path: poster }, 0, 'reference');
  assert.equal(reference.index, 0);
  assert.equal(reference.mimeType, 'image/png');

  const prepared = preparePopupRemovalVision(
    { path: poster, filename: 'ticket.png' },
    [{ imagePath: poster, filename: 'cms.png', bytes: PNG.length, visionIndex: 1, sectionId: 'announcement-1038', itemIndex: 0 }]
  );
  assert.ok(prepared.reference);
  assert.equal(prepared.complete, true);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].index, 1);
  assert.equal(prepared.warnings.length, 0);
});

test('marks a removal Vision set incomplete when any CMS popup cannot be compared', (t) => {
  const { poster } = fixture(t);
  const prepared = preparePopupRemovalVision(
    { path: poster, filename: 'ticket.png' },
    [
      { imagePath: poster, filename: 'cms.png', bytes: PNG.length, visionIndex: 1, sectionId: 'announcement-1038', itemIndex: 0 },
      { imagePath: path.join(path.dirname(poster), 'unsupported.gif'), filename: 'cms.gif', bytes: 100, visionIndex: 2, sectionId: 'announcement-1038', itemIndex: 1 }
    ]
  );
  assert.equal(prepared.complete, false);
  assert.equal(prepared.candidates.length, 1);
  assert.match(prepared.warnings.join(' '), /could not be used/);
});
