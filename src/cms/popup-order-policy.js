'use strict';

const { stableImageUrl } = require('./popup-verification');

function popupItemSignature(item) {
  return JSON.stringify({
    time_start: String(item?.time_start || '').trim(),
    time_end: String(item?.time_end || '').trim(),
    image: stableImageUrl(item?.image || ''),
    image_alt: String(item?.image_alt || '').trim(),
    link: String(item?.link || '').trim(),
    html_code: String(item?.html_code || '').trim(),
    open_new_tab: item?.open_new_tab === undefined ? null : Boolean(item.open_new_tab)
  });
}

function normalizedTargetUrls(values) {
  if (!Array.isArray(values)) return [];
  return values.map(stableImageUrl).filter(Boolean);
}

function planPopupPosition(items, targetImageUrls, position = null) {
  const current = Array.isArray(items) ? items : [];
  if (position !== 'first' && position !== 'last') {
    return { ok: true, needsMove: false, position: null, targetIndexes: [], desiredIndexes: current.map((_, index) => index), reason: null };
  }
  const targets = normalizedTargetUrls(targetImageUrls);
  if (!targets.length || new Set(targets).size !== targets.length) {
    return { ok: false, needsMove: false, position, targetIndexes: [], desiredIndexes: [], reason: 'invalid-or-duplicate-target-images' };
  }
  const targetIndexes = [];
  for (const target of targets) {
    const matches = current
      .map((item, index) => (stableImageUrl(item?.image) === target ? index : -1))
      .filter((index) => index >= 0);
    if (matches.length !== 1) {
      return {
        ok: false,
        needsMove: false,
        position,
        targetIndexes,
        desiredIndexes: [],
        reason: `target-image-match-count-${matches.length}`
      };
    }
    targetIndexes.push(matches[0]);
  }
  const targetSet = new Set(targetIndexes);
  const otherIndexes = current.map((_, index) => index).filter((index) => !targetSet.has(index));
  const desiredIndexes = position === 'last'
    ? [...otherIndexes, ...targetIndexes]
    : [...targetIndexes, ...otherIndexes];
  const needsMove = desiredIndexes.some((sourceIndex, desiredIndex) => sourceIndex !== desiredIndex);
  return { ok: true, needsMove, position, targetIndexes, desiredIndexes, reason: null };
}

function verifyPopupPosition(beforeItems, afterItems, targetImageUrls, position) {
  const before = Array.isArray(beforeItems) ? beforeItems : [];
  const after = Array.isArray(afterItems) ? afterItems : [];
  if (before.length !== after.length) return { ok: false, reason: 'item-count-changed' };
  const plan = planPopupPosition(after, targetImageUrls, position);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  if (plan.needsMove) return { ok: false, reason: 'target-position-not-persisted' };

  const beforeSignatures = before.map(popupItemSignature).sort();
  const afterSignatures = after.map(popupItemSignature).sort();
  if (beforeSignatures.some((signature, index) => signature !== afterSignatures[index])) {
    return { ok: false, reason: 'popup-content-changed' };
  }

  const targetSet = new Set(normalizedTargetUrls(targetImageUrls));
  const nonTargetSignatures = (items) => items
    .filter((item) => !targetSet.has(stableImageUrl(item?.image)))
    .map(popupItemSignature);
  const beforeOthers = nonTargetSignatures(before);
  const afterOthers = nonTargetSignatures(after);
  if (beforeOthers.some((signature, index) => signature !== afterOthers[index])) {
    return { ok: false, reason: 'non-target-order-changed' };
  }
  return { ok: true, reason: null };
}

module.exports = {
  popupItemSignature,
  planPopupPosition,
  verifyPopupPosition
};
