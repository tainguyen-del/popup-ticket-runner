const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableImageUrl,
  popupDateFromCmsValue,
  popupItemScheduleMatches,
  resolvePopupItemByImageAndSchedule,
  verifyPersistedPopupItem,
  popupItemsForReport
} = require('../src/cms/popup-verification');
const { setPopupImageLink } = require('../src/run');

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

test('resolves poster when entry has its own vision-derived schedule', () => {
  const entrySchedule = { start: null, end: { date: '2026-11-30' } };
  const cmsItem = {
    image: 'https://cdn.example/vision-poster.webp',
    time_start: null,
    time_end: '2026-11-30'
  };
  const resolved = resolvePopupItemByImageAndSchedule(
    [cmsItem],
    'https://cdn.example/vision-poster.webp',
    entrySchedule,
    timezone
  );
  assert.equal(resolved.index, 0);
  assert.equal(resolved.matches, 1);
  assert.equal(resolved.item, cmsItem);
});

test('verifies persistence when salon already has multiple popups (e.g. 4 items, expectedCount 1)', () => {
  const schedule = { start: null, end: { date: '2026-11-30' } };
  const existing1 = { image: 'https://cdn.example/1.webp', time_start: '', time_end: '2026-10-31' };
  const existing2 = { image: 'https://cdn.example/2.webp', time_start: '', time_end: '2026-12-31' };
  const existing3 = { image: 'https://cdn.example/3.webp', time_start: '', time_end: '2027-01-01' };
  const newPoster = { image: 'https://cdn.example/1599478-poster.png', time_start: '', time_end: '2026-11-30' };

  // Case A: verified with previewImageUrl
  const resultA = verifyPersistedPopupItem({
    afterItems: [existing1, existing2, existing3, newPoster],
    targetIndex: 0,
    expectedCount: 1,
    schedule,
    timezone,
    previewImageUrl: 'blob:https://cdn.example/1599478-poster.png'
  });
  assert.equal(resultA.ok, true);
  assert.equal(resultA.item, newPoster);

  // Case B: verified without previewImageUrl (by schedule match on lastItem)
  const resultB = verifyPersistedPopupItem({
    afterItems: [existing1, existing2, existing3, newPoster],
    targetIndex: 0,
    expectedCount: 1,
    schedule,
    timezone
  });
  assert.equal(resultB.ok, true);
  assert.equal(resultB.item, newPoster);
});

test('accurately locates removal target items by stableImageUrl', () => {
  const currentList = [
    { image: 'https://cdn.example/red-light.webp?t=1', time_start: null, time_end: null },
    { image: 'https://cdn.example/autumn-pedicure.webp?t=2', time_start: null, time_end: '2026-12-31' },
    { image: 'https://cdn.example/fall-special.webp?t=3', time_start: null, time_end: '2026-11-30' },
    { image: 'https://cdn.example/bestie-date.webp?t=4', time_start: null, time_end: null }
  ];
  const removalMatches = [
    { cmsIndex: 3, cmsItem: { sourceImageUrl: 'https://cdn.example/bestie-date.webp' } },
    { cmsIndex: 1, cmsItem: { sourceImageUrl: 'https://cdn.example/autumn-pedicure.webp' } }
  ];

  let list = [...currentList];
  for (const match of removalMatches) {
    const targetUrl = match?.cmsItem?.sourceImageUrl ? stableImageUrl(match.cmsItem.sourceImageUrl) : null;
    const targetIndex = list.findIndex((item) => stableImageUrl(item?.image) === targetUrl);
    assert.ok(targetIndex >= 0);
    list.splice(targetIndex, 1);
  }

  assert.equal(list.length, 2);
  assert.equal(stableImageUrl(list[0].image), 'https://cdn.example/red-light.webp');
  assert.equal(stableImageUrl(list[1].image), 'https://cdn.example/fall-special.webp');
});

test('setPopupImageLink returns null when no link is provided', async () => {
  assert.equal(await setPopupImageLink(null, null), null);
  assert.equal(await setPopupImageLink(null, ''), null);
  assert.equal(await setPopupImageLink(null, '   '), null);
});

test('setPopupImageLink locates and fills the Image link control', async () => {
  let filledValue = '';
  const mockControl = {
    fill: async (val) => { filledValue = val; },
    evaluate: async () => {},
    inputValue: async () => filledValue,
    getAttribute: async (name) => name === 'id' ? 'input-link-123' : null
  };
  const mockLabel = {
    getAttribute: async (name) => name === 'for' ? 'input-link-123' : null,
    innerText: async () => 'Image link',
    isVisible: async () => true
  };
  const mockPage = {
    locator: (selector) => {
      if (selector === 'label') {
        return {
          count: async () => 1,
          nth: () => mockLabel
        };
      }
      if (selector === '[id="input-link-123"]') {
        return {
          isVisible: async () => true,
          getAttribute: async (name) => name === 'id' ? 'input-link-123' : null,
          fill: mockControl.fill,
          evaluate: mockControl.evaluate,
          inputValue: mockControl.inputValue
        };
      }
      return { isVisible: async () => false, count: async () => 0 };
    },
    waitForTimeout: async () => {}
  };

  const result = await setPopupImageLink(mockPage, 'http://booking.gocheckin.net/v2/16675');
  assert.equal(result, 'http://booking.gocheckin.net/v2/16675');
  assert.equal(filledValue, 'http://booking.gocheckin.net/v2/16675');
});

test('popupItemsForReport maps CMS items safely for error reporting', () => {
  const items = [
    { image: 'https://cdn.example/pic.webp?cache=1', time_start: '2026-11-20', time_end: '2026-12-30' },
    { image: '', time_start: '', time_end: '' }
  ];
  const report = popupItemsForReport(items, timezone);
  assert.equal(report.length, 2);
  assert.equal(report[0].image, 'https://cdn.example/pic.webp');
  assert.equal(report[0].empty, false);
  assert.equal(report[1].image, null);
  assert.equal(report[1].empty, true);
});
