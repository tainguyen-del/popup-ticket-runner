'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planPopupPosition, verifyPopupPosition } = require('../src/cms/popup-order-policy');
const { findDuplicatePopupImages, findDuplicatePopupImagesWithVision } = require('../src/cms/popup-image-policy');

function item(image, end = '') {
  return { image, time_start: '', time_end: end, image_alt: '', link: '', html_code: '' };
}

test('plans a prepended ticket popup at the last position', () => {
  const ticket = item('https://cdn.example/ticket.webp', '2026-12-31');
  const legacy = item('https://cdn.example/legacy.webp', '2026-11-30');
  const plan = planPopupPosition([ticket, legacy], [ticket.image], 'last');
  assert.equal(plan.ok, true);
  assert.equal(plan.needsMove, true);
  assert.deepEqual(plan.desiredIndexes, [1, 0]);
});

test('verifies ticket posters at the end while preserving all other items', () => {
  const legacyA = item('https://cdn.example/legacy-a.webp');
  const legacyB = item('https://cdn.example/legacy-b.webp');
  const ticketA = item('https://cdn.example/ticket-a.webp');
  const ticketB = item('https://cdn.example/ticket-b.webp');
  const before = [ticketB, legacyA, ticketA, legacyB];
  const after = [legacyA, legacyB, ticketA, ticketB];
  assert.deepEqual(verifyPopupPosition(before, after, [ticketA.image, ticketB.image], 'last'), { ok: true, reason: null });
  assert.equal(verifyPopupPosition(before, [legacyB, legacyA, ticketA, ticketB], [ticketA.image, ticketB.image], 'last').ok, false);
});

test('detects duplicate CMS popup images by hash or reliable filename identity when one hash is unavailable', () => {
  const tickets = [
    { filename: 'Holiday Poster 11.png', sha256: 'a'.repeat(64) },
    { filename: 'Special Poster 22.png', sha256: 'b'.repeat(64) }
  ];
  const cms = [
    { sourceImageUrl: 'https://cdn.example/random.webp', sha256: 'a'.repeat(64) },
    { sourceImageUrl: 'https://cdn.example/index-Special_Poster_22-12345.webp' }
  ];
  const matches = findDuplicatePopupImages(tickets, cms);
  assert.deepEqual(matches.map((match) => match.method), ['sha256', 'filename-identity']);
});

test('does not call generic poster filenames duplicates without matching bytes', () => {
  assert.deepEqual(findDuplicatePopupImages(
    [{ filename: 'poster.png', sha256: 'a'.repeat(64) }],
    [{ sourceImageUrl: 'https://cdn.example/poster.png', sha256: 'b'.repeat(64) }]
  ), []);
});

test('does not call reused filenames duplicates when both image hashes exist and differ', () => {
  assert.deepEqual(findDuplicatePopupImages(
    [{ filename: 'Holiday Poster 11.png', sha256: 'a'.repeat(64) }],
    [{ sourceImageUrl: 'https://cdn.example/index-Holiday_Poster_11-12345.webp', sha256: 'b'.repeat(64) }]
  ), []);
});

test('recognizes a transformed CMS upload by the hash embedded in its sanitized URL', () => {
  const hash = '12ab34cd56ef'.repeat(5) + '1234';
  const matches = findDuplicatePopupImages(
    [{ filename: 'Holiday #Poster 11.png', sha256: hash }],
    [{
      sourceImageUrl: `https://cdn.example/index-popup-Holiday%20Poster%2011-${hash.slice(0, 12)}-12345.webp`,
      sha256: 'f'.repeat(64)
    }]
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].method, 'upload-hash-suffix');
});

test('findDuplicatePopupImagesWithVision returns direct matches when hash or filename matches', async () => {
  const hash = 'a'.repeat(64);
  const matches = await findDuplicatePopupImagesWithVision(null,
    [{ filename: 'test.png', sha256: hash }],
    [{ sourceImageUrl: 'https://cdn.example/test.webp', sha256: hash }]
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].method, 'sha256');
});
