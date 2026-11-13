const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableImageUrl,
  popupDateFromCmsValue,
  popupItemScheduleMatches,
  resolvePopupItemByImageAndSchedule,
  verifyPersistedPopupItem
} = require('../src/cms/popup-verification');

const timezone = { iana: 'America/Los_Angeles' };

test('normalizes CMS image URLs and date values', () => {
  assert.equal(
    stableImageUrl('https://cdn.example/poster.webp?version=2#preview'),
    'https://cdn.example/poster.webp'
  );
  assert.equal(popupDateFromCmsValue('2026-11-30', timezone), '2026-11-30');
  assert.equal(popupDateFromCmsValue('', timezone), null);
});

test('requires the exact requested schedule including a blank start', () => {
  const schedule = { start: null, end: { date: '2026-11-30' } };
  assert.equal(
    popupItemScheduleMatches({ time_start: '', time_end: '2026-11-30' }, schedule, timezone),
    true
  );
  assert.equal(
    popupItemScheduleMatches({ time_start: '2026-11-01', time_end: '2026-11-30' }, schedule, timezone),
    false
  );
});

test('resolves a popup after CMS prepends or appends other cards', () => {
  const schedule = { start: null, end: { date: '2026-11-30' } };
  const posterA = { image: 'https://cdn.example/a.webp?cache=1', time_start: '', time_end: '2026-11-30' };
  const posterB = { image: 'https://cdn.example/b.webp', time_start: '', time_end: '2026-11-30' };
  const legacy = { image: 'https://cdn.example/legacy.webp', time_start: '', time_end: '2026-12-31' };
  const result = resolvePopupItemByImageAndSchedule(
    [posterB, legacy, posterA],
    'https://cdn.example/a.webp?cache=2',
    schedule,
    timezone
  );
  assert.equal(result.index, 2);
  assert.equal(result.item, posterA);
  assert.equal(result.matches, 1);
});

test('refuses duplicate image-and-schedule matches', () => {
  const schedule = { start: null, end: { date: '2026-11-30' } };
  const poster = { image: 'https://cdn.example/a.webp', time_start: '', time_end: '2026-11-30' };
  const result = resolvePopupItemByImageAndSchedule([poster, { ...poster }], poster.image, schedule, timezone);
  assert.equal(result.item, null);
  assert.equal(result.index, -1);
  assert.equal(result.matches, 2);
});

test('verifies the persisted target card before Build', () => {
  const schedule = { start: null, end: { date: '2026-11-30' } };
  const poster = { image: 'https://cdn.example/a.webp', time_start: '', time_end: '2026-11-30' };
  assert.equal(verifyPersistedPopupItem({
    afterItems: [poster],
    targetIndex: 0,
    expectedCount: 1,
    schedule,
    timezone
  }).ok, true);
  assert.equal(verifyPersistedPopupItem({
    afterItems: [poster],
    targetIndex: 0,
    expectedCount: 2,
    schedule,
    timezone
  }).reason, 'list-count-1-expected-2');
});
