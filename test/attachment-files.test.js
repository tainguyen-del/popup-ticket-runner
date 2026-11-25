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
  isImageContainerComplete,
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

test('creates and stages an ASCII-safe byte-identical CMS upload copy', async (t) => {
  const { directory, poster } = fixture(t);
  const attachment = validateDownloadedImage(poster);
  const safeName = cmsSafeUploadFilename('Ưu đãi #50%?.PNG', attachment.sha256, 'png');
  assert.match(safeName, /^popup-[a-z0-9-]+-[a-f0-9]{12}\.png$/);
  assert.equal(/[\s#%?&/\\'"<>:|]/.test(safeName), false);

  const staged = await stageCmsUploadImage(attachment, directory);
  assert.equal(fs.existsSync(staged.uploadPath), true);
  assert.notEqual(staged.uploadPath, poster);
  assert.equal(validateDownloadedImage(staged.uploadPath).sha256, attachment.sha256);
});

test('builds local Gemini candidates with attachment context only', async (t) => {
  const { poster } = fixture(t);
  assert.equal(geminiVisionMimeType(poster), 'image/png');
  assert.equal(geminiVisionMimeType('poster.gif'), null);
  const download = { ...validateDownloadedImage(poster), candidateIndex: 2 };
  const prepared = await visionCandidatesFromDownloads([download], [
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

test('builds local Gemini candidates with attachment context, kind, and removal flags', async (t) => {
  const { poster } = fixture(t);
  const download = { ...validateDownloadedImage(poster), candidateIndex: 2 };
  const prepared = await visionCandidatesFromDownloads([download], [
    {
      index: 2,
      context: '1/ gỡ poster này xuống',
      precedingText: '1/ gỡ poster này xuống',
      kind: 'inline-image',
      isRemovalReference: true
    }
  ]);
  assert.equal(prepared.warnings.length, 0);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].index, 2);
  assert.equal(prepared.candidates[0].kind, 'inline-image');
  assert.equal(prepared.candidates[0].precedingText, '1/ gỡ poster này xuống');
  assert.equal(prepared.candidates[0].isRemovalReference, true);
});

test('compresses and stages an oversized image for CMS upload when page is available', async (t) => {
  const { directory, poster } = fixture(t);
  const attachment = validateDownloadedImage(poster);
  // Simulate an oversized image (> 2.8MB)
  attachment.bytes = 5 * 1024 * 1024;

  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const mockPage = {
    evaluate: async () => ({
      base64: fakeJpeg.toString('base64'),
      extension: 'jpg',
      mime: 'image/jpeg',
      width: 1000,
      height: 1000
    })
  };

  const staged = await stageCmsUploadImage(attachment, directory, { page: mockPage });
  assert.equal(staged.optimized, true);
  assert.equal(staged.originalBytes, 5 * 1024 * 1024);
  assert.equal(staged.extension, 'jpg');
  assert.match(staged.uploadFilename, /\.jpg$/);
  assert.equal(fs.existsSync(staged.uploadPath), true);
});

test('creates a vision preview when a candidate exceeds MAX_IMAGE_BYTES and page is provided', async (t) => {
  const { poster } = fixture(t);
  const download = {
    ...validateDownloadedImage(poster),
    candidateIndex: 1,
    bytes: 6 * 1024 * 1024 // 6MB
  };

  const mockPage = {
    evaluate: async () => ({
      base64: PNG.toString('base64'),
      mimeType: 'image/jpeg'
    })
  };

  const prepared = await visionCandidatesFromDownloads([download], [{ index: 1, context: 'New poster' }], { page: mockPage });
  assert.equal(prepared.warnings.length, 0);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].index, 1);
  assert.equal(prepared.candidates[0].mimeType, 'image/jpeg');
});

test('isImageContainerComplete detects valid vs truncated PNG and repairs truncated PNG via preview when page is provided', async (t) => {
  const { directory, poster } = fixture(t);
  assert.equal(isImageContainerComplete(PNG, 'image/png'), true);
  // Truncate the last 10 bytes (removes IEND)
  const truncatedPng = path.join(directory, 'truncated-chat.png');
  fs.writeFileSync(truncatedPng, PNG.subarray(0, PNG.length - 10));
  assert.equal(isImageContainerComplete(fs.readFileSync(truncatedPng), 'image/png'), false);

  const download = { ...validateDownloadedImage(truncatedPng), candidateIndex: 5 };
  let previewCalled = false;
  const mockPage = {
    evaluate: async () => {
      previewCalled = true;
      return { base64: PNG.toString('base64'), mimeType: 'image/jpeg' };
    }
  };

  const prepared = await visionCandidatesFromDownloads([download], [{ index: 5, context: 'Chat screenshot' }], { page: mockPage });
  assert.equal(previewCalled, true);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].mimeType, 'image/jpeg');
  assert.equal(prepared.warnings.length, 0);
});
