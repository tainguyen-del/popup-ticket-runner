'use strict';

const IMAGE_ACTIONS = new Set(['create', 'replace', 'remove-one']);
const WRITE_POSTER_ACTIONS = new Set(['create', 'replace']);

function normalizeAttachmentCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError('attachmentCount must be a non-negative integer.');
  }
  return count;
}

function validAttachmentIndex(value, attachmentCount) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 1 && index <= attachmentCount
    ? index
    : null;
}

function validAttachmentIndexes(values, attachmentCount) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => validAttachmentIndex(value, attachmentCount))
    .filter(Boolean))];
}

/**
 * Decide how CRM image attachments must be handled before any CMS mutation.
 *
 * The planner intentionally does not download files or guess which image is a
 * poster. A caller must provide an already verified index (or index set) when
 * a ticket contains more than one image.
 */
function attachmentPlanForTicket({
  popupAction,
  attachmentCount = 0,
  popupAttachmentIndex = null,
  popupAttachmentIndexes = []
} = {}) {
  const action = String(popupAction || '').trim().toLowerCase();
  const count = normalizeAttachmentCount(attachmentCount);
  const selectedIndex = validAttachmentIndex(popupAttachmentIndex, count);
  const selectedIndexes = validAttachmentIndexes(popupAttachmentIndexes, count);
  const requiresImage = IMAGE_ACTIONS.has(action);

  if (!requiresImage) {
    return {
      mode: 'none',
      required: false,
      ready: true,
      attachmentCount: count,
      selectedIndex: null,
      selectedIndexes: [],
      reason: 'popup-action-does-not-require-ticket-image'
    };
  }

  if (count === 0) {
    return {
      mode: 'none',
      required: true,
      ready: false,
      attachmentCount: 0,
      selectedIndex: null,
      selectedIndexes: [],
      reason: 'ticket-has-no-image-attachment'
    };
  }

  if (action === 'remove-one') {
    const referenceIndex = count === 1 ? 1 : selectedIndex;
    return {
      mode: 'removal-reference',
      required: true,
      ready: Boolean(referenceIndex),
      attachmentCount: count,
      selectedIndex: referenceIndex,
      selectedIndexes: referenceIndex ? [referenceIndex] : [],
      reason: referenceIndex
        ? 'removal-reference-selected'
        : 'removal-reference-needs-selection'
    };
  }

  if (WRITE_POSTER_ACTIONS.has(action) && count === 1) {
    return {
      mode: 'single',
      required: true,
      ready: true,
      attachmentCount: 1,
      selectedIndex: 1,
      selectedIndexes: [1],
      reason: 'only-visible-image'
    };
  }

  if (WRITE_POSTER_ACTIONS.has(action)) {
    return {
      mode: 'multi-set',
      required: true,
      ready: selectedIndexes.length > 0,
      attachmentCount: count,
      selectedIndex: null,
      selectedIndexes,
      reason: selectedIndexes.length > 0
        ? 'verified-poster-set-selected'
        : 'poster-set-needs-selection'
    };
  }

  return {
    mode: 'none',
    required: false,
    ready: true,
    attachmentCount: count,
    selectedIndex: null,
    selectedIndexes: [],
    reason: 'popup-action-does-not-require-ticket-image'
  };
}

module.exports = {
  attachmentPlanForTicket,
  validAttachmentIndex,
  validAttachmentIndexes
};
