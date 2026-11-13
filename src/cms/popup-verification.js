'use strict';

const { normalizeExpiry } = require('../ticket-parser');

function stableImageUrl(raw) {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(raw || '').trim();
  }
}

function popupDateFromCmsValue(value, timezone) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^20\d{2}-\d{2}-\d{2}$/.test(raw)) return raw;
  const instant = new Date(raw);
  if (!Number.isNaN(instant.getTime())) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone.iana,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(instant);
    const result = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    );
    return `${result.year}-${result.month}-${result.day}`;
  }
  return normalizeExpiry(raw);
}

function popupItemScheduleMatches(item, schedule, timezone) {
  const rawStart = String(item?.time_start || '').trim();
  const rawEnd = String(item?.time_end || '').trim();
  if (schedule?.start?.date) {
    if (popupDateFromCmsValue(rawStart, timezone) !== schedule.start.date) return false;
  } else if (rawStart) {
    return false;
  }
  if (schedule?.end?.date) {
    if (popupDateFromCmsValue(rawEnd, timezone) !== schedule.end.date) return false;
  } else if (rawEnd) {
    return false;
  }
  return true;
}

function resolvePopupItemByImageAndSchedule(items, imageUrl, schedule, timezone) {
  const expectedUrl = stableImageUrl(imageUrl);
  if (!expectedUrl) return { item: null, index: -1, matches: 0 };
  const matches = (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (
      stableImageUrl(item?.image) === expectedUrl
      && popupItemScheduleMatches(item, schedule, timezone)
    ));
  return matches.length === 1
    ? { ...matches[0], matches: 1 }
    : { item: null, index: -1, matches: matches.length };
}

function verifyPersistedPopupItem({ afterItems, targetIndex, expectedCount, schedule, timezone }) {
  const items = Array.isArray(afterItems) ? afterItems : [];
  if (items.length !== expectedCount) {
    return { ok: false, reason: `list-count-${items.length}-expected-${expectedCount}`, item: null };
  }
  const item = items[targetIndex];
  if (!item) return { ok: false, reason: 'target-item-missing', item: null };
  if (!String(item.image || '').trim()) return { ok: false, reason: 'target-image-empty', item };
  if (!popupItemScheduleMatches(item, schedule, timezone)) {
    return { ok: false, reason: 'target-schedule-mismatch', item };
  }
  return { ok: true, reason: null, item };
}

module.exports = {
  stableImageUrl,
  popupDateFromCmsValue,
  popupItemScheduleMatches,
  resolvePopupItemByImageAndSchedule,
  verifyPersistedPopupItem
};
