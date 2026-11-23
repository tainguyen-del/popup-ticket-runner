'use strict';

const { normalizeExpiry } = require('../ticket-parser');

function stableImageUrl(raw) {
  try {
    const value = String(raw || '').trim();
    // Some CMS previews wrap the final media URL as a blob URL. When the
    // wrapped part is itself an absolute URL, compare that stable asset URL.
    const url = new URL(/^blob:https?:\/\//i.test(value) ? value.slice(5) : value);
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
    const tz = typeof timezone === 'string' ? timezone : timezone?.iana;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
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

function verifyPersistedPopupItem({ afterItems, targetIndex, expectedCount, schedule, timezone, previewImageUrl = null }) {
  const items = Array.isArray(afterItems) ? afterItems : [];

  // When a verified uploaded image URL is present, match the persisted item directly by image and schedule
  if (previewImageUrl) {
    const resolved = resolvePopupItemByImageAndSchedule(items, previewImageUrl, schedule, timezone);
    if (resolved.item) {
      return { ok: true, reason: null, item: resolved.item, index: resolved.index };
    }
  }

  // Older/migrated sections can expose a wider list than the card count that
  // was observed when the target was opened. Without a usable preview URL,
  // accept only one uniquely scheduled configured item or a matching item at targetIndex.
  if (!previewImageUrl && Number.isInteger(expectedCount) && items.length > expectedCount) {
    const scheduled = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => String(item?.image || '').trim() && popupItemScheduleMatches(item, schedule, timezone));
    if (scheduled.length === 1) {
      return { ok: true, reason: null, item: scheduled[0].item, index: scheduled[0].index };
    }
    if (Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < items.length) {
      const targetItem = items[targetIndex];
      if (String(targetItem?.image || '').trim() && popupItemScheduleMatches(targetItem, schedule, timezone)) {
        return { ok: true, reason: null, item: targetItem, index: targetIndex };
      }
    }
  }

  // Fallback to strict expectedCount check if image resolution is not available or hasn't matched yet
  if (Number.isInteger(expectedCount) && items.length !== expectedCount) {
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

function isEmptyPopupItem(item) {
  if (!item || typeof item !== 'object') return true;
  if (!String(item.image || '').trim()) return true;
  return ['time_start', 'time_end', 'image', 'image_alt', 'link', 'html_code']
    .every((key) => !String(item?.[key] || '').trim());
}

function popupItemsForReport(items, timezone) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    index,
    image: typeof item?.image === 'string' && item.image.trim() ? stableImageUrl(item.image) : null,
    start: popupDateFromCmsValue(item?.time_start, timezone),
    end: popupDateFromCmsValue(item?.time_end, timezone),
    empty: isEmptyPopupItem(item)
  }));
}

module.exports = {
  stableImageUrl,
  popupDateFromCmsValue,
  popupItemScheduleMatches,
  resolvePopupItemByImageAndSchedule,
  verifyPersistedPopupItem,
  popupItemsForReport,
  isEmptyPopupItem
};
