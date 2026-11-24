#!/usr/bin/env node
// Safe discovery phase: never installs plugins, uploads files, or publishes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runDirectoryRoots } = require('./app-paths');
const { launchToolBrowser, closeToolBrowser } = require('./browser-session');
const {
  resolveTicketSemantics,
  resolveTicketVision,
  resolveTicketPopupVisionSet,
  resolveTicketPopupRemovalVision
} = require('./semantic-ticket');
const {
  foldTicketText,
  normalizeExpiry,
  findTicketDate,
  endOfMonthExpiryFromTicket,
  ticketData,
  isPopupRemovalAction,
  popupActionNeedsTicketImage,
  hasMultiPosterIntent,
  resolveRemovalScopeFromAttachments,
  popupScheduleFromTicket
} = require('./ticket-parser');
const { attachmentPlanForTicket } = require('./attachment-plan');
const {
  browserProblem,
  ticketNumberFromUrl,
  ticketMarkerPattern,
  activeTicketRoot,
  allAttachmentsDownloadButton,
  revealTicketAttachmentArea,
  isInlineTicketImageUrl,
  filenameFromImageUrl,
  ticketAttachmentDescriptors,
  readFullTicketContext,
  ticketAttachmentItems,
  openTicketDetails,
  isElementDisplayed
} = require('./crm/ticket-reader');
const {
  imageFiles,
  validateDownloadedImage,
  cmsSafeUploadFilename,
  stageCmsUploadImage,
  geminiVisionMimeType,
  visionCandidatesFromDownloads,
  visionCandidateFromLocalImage,
  preparePopupRemovalVision
} = require('./crm/attachment-files');
const {
  projectDomainsFromText,
  isPreviewProjectDomain,
  chooseProjectCandidate,
  projectBaseUrl
} = require('./cms/project-selector');
const {
  announcementPluginVersionFromText,
  announcementSectionVersionToken,
  mustCreateFreshAnnouncementSection
} = require('./cms/plugin-policy');
const {
  stableImageUrl,
  popupDateFromCmsValue,
  popupItemScheduleMatches,
  resolvePopupItemByImageAndSchedule,
  verifyPersistedPopupItem
} = require('./cms/popup-verification');
const {
  planPopupPosition,
  verifyPopupPosition
} = require('./cms/popup-order-policy');
const {
  popupImageIdentity,
  findDuplicatePopupImages,
  findDuplicatePopupImagesWithVision
} = require('./cms/popup-image-policy');
const {
  visibleMatch,
  waitForVisibleMatch,
  visibleLabel,
  controlForLabel,
  ensureDesktopViewport
} = require('./cms/dom-utils');
const {
  setProgressHandler: setPopupProgressHandler,
  expiryAriaLabel,
  todayInTimezone,
  calendarMonthStart,
  popupInputValues,
  trySetPopupDateInput,
  popupCalendar,
  calendarHeading,
  calendarMoveControl,
  calendarMonthDistance,
  popupCalendarDay,
  waitForCalendarMonthChange,
  setPopupDate,
  setPopupDateValue,
  setPopupStart,
  setPopupExpiry,
  clearPopupDateControl,
  clearPopupStartDate,
  clearPopupEndDate,
  isPopupItemEditorOpen,
  popupListItemEditorIsOpen,
  isPopupListItemsViewOpen,
  popupListItemsPanel,
  waitForPopupListItemsPanel,
  popupListItemCards,
  openPopupListCard,
  readPopupListItems,
  waitForPopupListItemCount,
  isEmptyPopupItem,
  planPopupItemTarget,
  popupItemSignature,
  samePopupItemSequence,
  resolveAddedPopupItemTarget,
  openPopupListItem,
  openConfiguredPopupListItem,
  popupImageUploadControl,
  popupImageUrls,
  waitForPopupImageUpload,
  setPopupImageLink,
  configurePopupListItem,
  backToPopupSettings,
  waitForPersistedPopupItem,
  deletePopupItemAtIndex,
  deleteOneEmptyPopupItem,
  repairExistingPopupSettings,
  normalizeTicketPopupEntries,
  buildPopupEntriesForTickets,
  buildPopupEntries,
  setTimeDelaySlider
} = require('./cms/popup-editor');

function progress(stage, message, details = {}) {
  process.stdout.write(`PROGRESS ${JSON.stringify({ stage, message, ...details })}\n`);
}
setPopupProgressHandler(progress);

const value = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : process.argv[index + 1];
};
const httpsUrl = (raw, label) => {
  if (!raw) throw new Error(`Missing ${label}.`);
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must be an HTTPS URL.`);
  return parsed.href;
};

function popupTicketEntriesFromDownloads(downloadedAttachments, schedule, posterSchedules = []) {
  const attachments = Array.isArray(downloadedAttachments) ? downloadedAttachments : [];
  const artworkSchedules = new Map((Array.isArray(posterSchedules) ? posterSchedules : [])
    .filter((item) => Number.isInteger(item?.attachmentIndex))
    .map((item) => [item.attachmentIndex, item]));
  const seenCandidates = new Set();
  const seenHashes = new Set();
  const entries = [];
  for (const attachment of attachments) {
    const candidateIndex = Number(attachment?.candidateIndex);
    const imagePath = attachment?.uploadPath || attachment?.path || null;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 1 || !imagePath) {
      throw new Error('A requested popup poster was not downloaded and staged locally.');
    }
    if (seenCandidates.has(candidateIndex)) {
      const error = new Error(`Popup attachment #${candidateIndex} was selected more than once (duplicate image).`);
      error.stage = 'popup-image-duplicate';
      throw error;
    }
    if (attachment.sha256 && seenHashes.has(attachment.sha256)) {
      const error = new Error('Two requested popup attachments have identical image data (duplicate image). The duplicate was not uploaded and CMS Build was not started.');
      error.stage = 'popup-image-duplicate';
      throw error;
    }
    seenCandidates.add(candidateIndex);
    if (attachment.sha256) seenHashes.add(attachment.sha256);
    const isIndefinite = Boolean(schedule?.isIndefinite);
    const artworkSchedule = !isIndefinite ? (artworkSchedules.get(candidateIndex) || null) : null;
    // Ticket/comment dates and the explicit CLI expiry override are stronger
    // evidence than poster OCR. When the ticket requests an indefinite / open-ended schedule
    // ("đến khi khách tắt"), poster OCR must not invent dates. Otherwise, fall back to
    // the validated artwork schedule independently for missing expiry. Per user requirements,
    // do NOT adopt artwork startDate — popups display immediately unless the ticket note
    // explicitly requests a scheduled start date.
    const startDate = schedule?.start?.date || null;
    const endDate = schedule?.end?.date || artworkSchedule?.endDate || null;
    entries.push({
      ticketIndex: entries.length,
      candidateIndex,
      imagePath,
      filename: attachment.filename || path.basename(imagePath),
      schedule: {
        start: startDate ? { date: startDate } : null,
        end: endDate ? { date: endDate } : null
      }
    });
  }
  if (!entries.length) throw new Error('No validated ticket poster was available for Popup settings.');
  return entries;
}

function applyArtworkSchedulePrecedence(ticket, visionPosterSchedules, targetIndex = null) {
  const schedules = Array.isArray(visionPosterSchedules) ? visionPosterSchedules : [];
  if (!schedules.length || !ticket) return;
  const preferredIndex = targetIndex
    || ticket.popupAttachmentIndex
    || (Array.isArray(ticket.popupAttachmentIndexes) ? ticket.popupAttachmentIndexes[0] : null);
  const matched = schedules.find((s) => s?.attachmentIndex === preferredIndex) || schedules[0];
  if (!matched) return;

  if (matched.endDate) {
    ticket.artworkExpiryDate = matched.endDate;
    // Precedence rule: explicit note in ticket > expiry in popup image.
    // If ticket text did NOT specify an expiry date, adopt the expiry date from Gemini Vision:
    if (!ticket.expiryDate && !ticket.isIndefinite) {
      ticket.expiryDate = matched.endDate;
      ticket.expiry = matched.evidence || matched.endDate;
      ticket.scheduleSource = 'poster-artwork';
      ticket.scheduleEvidence = matched.evidence;
    }
  }
  if (matched.startDate) {
    ticket.artworkStartDate = matched.startDate;
    // Per user requirement: Do NOT adopt startDate from artwork poster schedule.
    // Popups display immediately unless the ticket note explicitly requested a start date.
  }
}

function shouldUseTicketVision(popupAction, attachmentCount) {
  return ['create', 'replace'].includes(String(popupAction || '').trim().toLowerCase())
    && Number.isInteger(Number(attachmentCount))
    && Number(attachmentCount) > 0;
}

function attachmentReport(attachment) {
  return {
    filename: attachment.filename,
    bytes: attachment.bytes,
    sha256: attachment.sha256,
    cmsUploadFilename: attachment.uploadFilename || null,
    source: attachment.source,
    candidateIndex: attachment.candidateIndex || null,
    optimized: Boolean(attachment.optimized),
    originalBytes: attachment.originalBytes || null
  };
}


function bootstrapMessage(body) {
  return /^no internet connection\. check your network and retry\.?$/i.test(body.replace(/\s+/g, ' ').trim());
}

function browserProfileLocked(error) {
  const detail = `${error?.message || ''}\n${error?.stack || ''}`;
  return /ProcessSingleton|profile directory.*(?:in use|lock)|Lock file.*access is denied/i.test(detail);
}

function createRunDirectory(root) {
  const runName = new Date().toISOString().replace(/[:.]/g, '-');
  const candidates = runDirectoryRoots(root).map((directory, index) => ({
    directory: path.join(directory, runName),
    storage: index === 0 ? 'app-data' : (index === 1 ? 'project' : 'temporary')
  }));
  let lastError = null;
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate.directory, { recursive: true });
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`Could not create a local report directory: ${lastError?.message || 'unknown error'}`);
  error.status = 'run-storage-unavailable';
  throw error;
}


async function openFastboy(page) {
  for (const locator of [page.getByText('fastboy', { exact: true }), page.locator('text=fastboy').first()]) {
    try { await locator.click({ timeout: 5000 }); await page.waitForLoadState('domcontentloaded'); return; } catch { /* next selector */ }
  }
  throw new Error('Could not open organization fastboy.');
}


async function projectSearchCandidates(page, siteId) {
  const titles = page.getByText(siteId, { exact: true });
  const candidates = [];
  for (let index = 0; index < await titles.count(); index += 1) {
    const title = titles.nth(index);
    if (!await title.isVisible().catch(() => false)) continue;
    const domains = await title.evaluate((node) => {
      const pattern = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
      let current = node;
      let nearest = [];
      while (current && current !== document.body) {
        const text = current.innerText || '';
        const matches = text.match(pattern) || [];
        if (matches.length && !nearest.length) nearest = [...new Set(matches.map((domain) => domain.toLowerCase()))];
        if (matches.length && /\bTemplate\b/i.test(text) && /\bStatus\b/i.test(text)) {
          return [...new Set(matches.map((domain) => domain.toLowerCase()))];
        }
        current = current.parentElement;
      }
      return nearest;
    });
    candidates.push({ locatorIndex: index, domains });
  }
  return candidates;
}


async function announcementRow(page) {
  const row = page.locator('tr').filter({ has: page.getByText('Announcement', { exact: true }) }).first();
  await row.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  return await row.isVisible().catch(() => false) ? row : null;
}


async function readAnnouncementPlugin(page) {
  const row = await announcementRow(page);
  if (!row) return { state: 'missing', version: null, enabled: false, updateAvailable: false };
  const metadata = await row.evaluate((element) => {
    const cells = [...element.querySelectorAll('td')];
    const switchControl = element.querySelector('[role="switch"]');
    const buttonMarkup = [...element.querySelectorAll('button')].map((button) => `${button.className} ${button.innerHTML}`.toLowerCase()).join(' ');
    const cellText = cells.map((cell) => cell.innerText.trim());
    return {
      // Return plain text here; Playwright evaluates this callback inside the
      // CMS page, where Node-side helper functions are not available.
      versionText: [...cellText, element.innerText],
      enabled: ['true', '1'].includes(switchControl?.getAttribute('aria-checked')),
      updateAvailable: /arrow[^\s"']*up|update|upgrade/.test(buttonMarkup),
      updating: /\b(?:updating|installing|processing|pending)\b/i.test([...cellText, element.innerText].join(' '))
    };
  });
  const version = metadata.versionText.map(announcementPluginVersionFromText).find(Boolean) || null;
  return {
    state: metadata.updating ? 'updating' : (metadata.updateAvailable ? 'outdated' : 'current'),
    ...metadata,
    version
  };
}

async function announcementUpdateControl(page) {
  const row = await announcementRow(page);
  if (!row) return null;
  const buttons = row.locator('button');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    const isUpdate = await button.evaluate((element) => {
      const attributes = ['aria-label', 'title', 'data-original-title']
        .map((name) => element.getAttribute(name) || '')
        .join(' ');
      const markup = `${element.className} ${attributes} ${element.innerHTML}`.toLowerCase();
      return /arrow[^\s"']*up|update|upgrade/.test(markup);
    }).catch(() => false);
    if (isUpdate) return button;
  }
  return null;
}

async function confirmPluginActionIfNeeded(page) {
  // NewZen's confirmation has appeared as both an ARIA dialog and a plain
  // modal during different releases.  Scope the button search to the visible
  // overlay first, but retain an exact global Confirm fallback immediately
  // after the update action.
  const confirmationName = /^(?:Confirm(?:\s+update)?|Update|Upgrade|Yes)$/i;
  const dialogs = page.locator('[role="dialog"], .modal, .modal-dialog, .swal2-popup, .v-dialog, [class*="modal"], [class*="swal"]');
  const count = await dialogs.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!await dialog.isVisible().catch(() => false)) continue;
    const confirmation = dialog.getByRole('button', { name: confirmationName }).last();
    if (await confirmation.isVisible().catch(() => false)) {
      try {
        await confirmation.click({ timeout: 5000 });
        return true;
      } catch { /* try the next visible confirmation container */ }
    }
  }
  const pageConfirmation = page.getByRole('button', { name: /^Confirm(?:\s+update)?$/i }).last();
  if (await pageConfirmation.isVisible().catch(() => false)) {
    try {
      await pageConfirmation.click({ timeout: 5000 });
      return true;
    } catch { /* the short polling loop will try again if needed */ }
  }
  return false;
}

async function waitForAnnouncementPluginState(page, expectedState, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (Date.now() < deadline) {
    await confirmPluginActionIfNeeded(page);
    lastState = await readAnnouncementPlugin(page).catch(() => null);
    if (lastState?.state === expectedState) return lastState;
    await page.waitForTimeout(500);
  }
  return lastState;
}

async function reloadPlugins(page, baseUrl) {
  await page.goto(`${baseUrl}/plugins`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByText('Plugins', { exact: true }).last().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return readAnnouncementPlugin(page);
}

async function installAnnouncementPlugin(page, baseUrl) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const state = await readAnnouncementPlugin(page);
    if (state.state !== 'missing') return state;
    await page.getByRole('button', { name: 'Add Plugin', exact: true }).click();
    await page.waitForTimeout(500);
    const titles = page.getByText('Announcement', { exact: true });
    let installButton = null;
    for (let index = await titles.count() - 1; index >= 0; index -= 1) {
      const card = titles.nth(index).locator('xpath=ancestor::div[.//button[normalize-space()="Install"]][1]');
      const candidate = card.getByRole('button', { name: 'Install', exact: true });
      if (await candidate.isVisible().catch(() => false)) { installButton = candidate; break; }
    }
    if (!installButton) throw new Error('Announcement install control was not found in Plugin Store.');
    await installButton.click();
    const settled = await waitForAnnouncementPluginState(page, 'current', 12000);
    if (settled?.state === 'current' || settled?.state === 'outdated') return settled;
    const reloaded = await reloadPlugins(page, baseUrl);
    if (reloaded.state !== 'missing') return reloaded;
    if (attempt < 2) await page.waitForTimeout(1000);
  }
  throw new Error('Announcement plugin installation did not finish after 2 attempts.');
}

async function updateAnnouncementPlugin(page, baseUrl) {
  let lastState = await readAnnouncementPlugin(page);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (lastState.state !== 'outdated') return lastState;
    const updateButton = await announcementUpdateControl(page);
    if (updateButton) {
      await updateButton.click({ timeout: 10000 });
      const settled = await waitForAnnouncementPluginState(page, 'current', 90000);
      if (settled?.state === 'current') {
        // The update row can briefly disappear before the server-side update
        // is complete. Reload once so the next step never creates a section
        // from stale plugin metadata.
        const reloaded = await reloadPlugins(page, baseUrl);
        if (reloaded.state === 'current') return reloaded;
        lastState = reloaded;
      }
    }
    lastState = await reloadPlugins(page, baseUrl);
    if (lastState.state === 'current') return lastState;
    if (attempt < 2) await page.waitForTimeout(1000);
  }
  throw new Error(`Announcement plugin update did not finish after 2 attempts (still ${lastState.version || 'an unknown version'}).`);
}


async function savePlaywrightDownload(download, assetDir) {
  const failure = await download.failure();
  if (failure) throw new Error(`CRM attachment download failed: ${failure}`);
  const target = path.join(assetDir, path.basename(download.suggestedFilename()));
  await download.saveAs(target);
  return target;
}

async function clickAndSaveDownload(page, button, assetDir) {
  const pendingDownload = page.waitForEvent('download', { timeout: 10000 });
  try {
    await button.evaluate((el) => el.click()).catch(() => button.click({ force: true }));
    return await savePlaywrightDownload(await pendingDownload, assetDir);
  } catch (error) {
    pendingDownload.catch(() => {});
    throw error;
  }
}

async function downloadInlineTicketImage(page, item, assetDir, candidateIndex) {
  const sourceUrl = item?.sourceUrl
    || await item?.locator?.evaluate((image) => image.currentSrc || image.getAttribute('src') || '').catch(() => '');
  if (!isInlineTicketImageUrl(sourceUrl)) {
    throw new Error(`Ticket image #${candidateIndex} is not a supported CRM inline attachment.`);
  }
  const response = await page.request.get(sourceUrl, { timeout: 30000 });
  if (!response.ok()) throw new Error(`CRM inline image #${candidateIndex} could not be downloaded (${response.status()}).`);
  const contentType = response.headers()['content-type'] || '';
  const extension = legacyImageExtension(sourceUrl, contentType);
  const filename = filenameFromImageUrl(sourceUrl, `ticket-inline-${candidateIndex}.${extension}`);
  const target = path.join(assetDir, filename);
  fs.writeFileSync(target, await response.body());
  return target;
}


async function downloadTicketCandidateImages(page, ticketUrl, runDir, { expectedAttachmentCount = null } = {}) {
  const assetDir = path.join(runDir, 'attachment-candidates');
  fs.mkdirSync(assetDir, { recursive: true });
  try {
    const { root, items } = await ticketAttachmentItems(page, ticketUrl, { reveal: true });
    if (!root) throw new Error('CRM did not expose the selected ticket panel for Vision attachment download.');
    if (Number.isInteger(expectedAttachmentCount) && expectedAttachmentCount !== items.length) {
      if (items.length > 0) {
        progress('attachment-candidates-discovered', `Đã tìm thấy ${items.length} ảnh đính kèm (ban đầu phát hiện ${expectedAttachmentCount})`);
      } else {
        throw new Error(`The visible attachment list changed from ${expectedAttachmentCount} to ${items.length}; Vision did not guess an image.`);
      }
    }
    if (!items.length) throw new Error('No visible image attachment was available for Gemini Vision.');
    const downloads = [];
    for (let index = 0; index < items.length; index += 1) {
      const candidateDir = path.join(assetDir, String(index + 1));
      fs.mkdirSync(candidateDir, { recursive: true });
      const item = items[index];
      let downloadPath = null;
      let downloadSource = item.kind === 'inline-image' ? 'inline-ticket-image' : 'vision-candidate-download';

      const directUrl = item.sourceUrl
        || await item.locator?.evaluate((card) => {
          const link = card.querySelector('a.ant-upload-list-item-thumbnail, a[href*="storage.fastboy.dev"], a.ant-upload-list-item-name');
          if (link && link.href) return link.href;
          const img = card.querySelector('img[src*="storage.fastboy.dev"]');
          return img?.currentSrc || img?.src || null;
        }).catch(() => null);

      if (directUrl && isInlineTicketImageUrl(directUrl)) {
        try {
          downloadPath = await downloadInlineTicketImage(page, { ...item, sourceUrl: directUrl }, candidateDir, index + 1);
          downloadSource = item.kind === 'inline-image' ? 'inline-ticket-image' : 'direct-url-candidate-download';
        } catch {
          downloadPath = null;
        }
      }

      if (!downloadPath) {
        if (item.kind === 'inline-image') {
          downloadPath = await downloadInlineTicketImage(page, item, candidateDir, index + 1);
        } else {
          await item.locator.hover({ force: true, timeout: 5000 });
          const button = await visibleMatch(item.locator.locator('button[title="Download file"]'), null, true);
          if (!button) throw new Error(`Attachment #${index + 1} did not expose its Download file control.`);
          downloadPath = await clickAndSaveDownload(page, button, candidateDir);
        }
      }
      downloads.push({
        ...validateDownloadedImage(downloadPath),
        source: downloadSource,
        candidateIndex: index + 1
      });
    }
    return downloads;
  } catch (error) {
    error.stage = 'attachment-vision-download';
    throw error;
  }
}


async function downloadTicketImage(page, ticketUrl, runDir, {
  selectedAttachmentIndex = null,
  expectedAttachmentCount = null
} = {}) {
  const assetDir = path.join(runDir, 'attachment');
  fs.mkdirSync(assetDir, { recursive: true });
  try {
    const currentTicketNumber = ticketNumberFromUrl(page.url());
    if (currentTicketNumber !== ticketNumberFromUrl(ticketUrl) || !await activeTicketRoot(page, ticketUrl)) {
      await openTicketDetails(page, ticketUrl);
    }
    // Scope discovery to the selected ticket. CRM keeps previous ticket tabs
    // mounted, which previously let a new ticket borrow another tab's poster.
    progress('attachment-comment-scan', 'Checking ticket body and comments for the poster');
    const { root, items } = await ticketAttachmentItems(page, ticketUrl, { reveal: true });
    if (!root) throw new Error('CRM did not expose the selected ticket panel for attachment download.');
    if (Number.isInteger(expectedAttachmentCount) && expectedAttachmentCount !== items.length) {
      if (expectedAttachmentCount === 0 && items.length === 1 && (!selectedAttachmentIndex || selectedAttachmentIndex === 1)) {
        progress('attachment-discovered', 'Đã tìm thấy poster đính kèm sau khi tải xong nội dung');
      } else if (items.length > 1 && selectedAttachmentIndex && selectedAttachmentIndex <= items.length) {
        progress('attachment-count-settled', `CRM hiển thị ${items.length} ảnh đính kèm; tải poster đã chọn #${selectedAttachmentIndex}`);
      } else if (items.length === 1 && (!selectedAttachmentIndex || selectedAttachmentIndex === 1)) {
        progress('attachment-discovered', 'Đã tìm thấy 1 poster đính kèm duy nhất');
      } else {
        throw new Error(`The visible attachment list changed from ${expectedAttachmentCount} to ${items.length}; the poster was not guessed.`);
      }
    }
    let selectedItem = null;
    let selectedIndex = null;
    if (items.length > 0) {
      selectedIndex = items.length === 1 ? 1 : selectedAttachmentIndex;
      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > items.length) {
        throw new Error(`Found ${items.length} image attachments but the ticket did not identify one unambiguous popup poster.`);
      }
      selectedItem = items[selectedIndex - 1];
    }
    let downloadPath = null;
    let downloadSource = 'all-attachments';
    let individualDownloadError = null;
    if (selectedItem) {
      const directUrl = selectedItem.sourceUrl
        || await selectedItem.locator?.evaluate((card) => {
          const link = card.querySelector('a.ant-upload-list-item-thumbnail, a[href*="storage.fastboy.dev"], a.ant-upload-list-item-name');
          if (link && link.href) return link.href;
          const img = card.querySelector('img[src*="storage.fastboy.dev"]');
          return img?.currentSrc || img?.src || null;
        }).catch(() => null);

      if (directUrl && isInlineTicketImageUrl(directUrl)) {
        try {
          progress('attachment-direct-download', 'Downloading ticket attachment directly from storage');
          downloadPath = await downloadInlineTicketImage(page, { ...selectedItem, sourceUrl: directUrl }, assetDir, selectedIndex);
          downloadSource = 'direct-url';
        } catch (error) {
          individualDownloadError = error;
        }
      } else if (selectedItem.kind === 'inline-image') {
        // Rich-text CRM posts render their attachment as a full inline image
        // instead of a hover card. Fetch it through the authenticated browser
        // context, validate it locally, and never pass the CRM URL to CMS.
        progress('attachment-inline-download', 'Downloading the inline ticket image locally');
        downloadPath = await downloadInlineTicketImage(page, selectedItem, assetDir, selectedIndex);
        downloadSource = 'inline-ticket-image';
      } else {
        // CRM renders the per-file action only while its own thumbnail is hovered.
        progress('attachment-hover', 'Hovering the ticket/comment poster to reveal Download file');
        try {
          await selectedItem.locator.hover({ force: true, timeout: 5000 });
          const perFileButton = await visibleMatch(selectedItem.locator.locator('button[title="Download file"]'), null, true);
          if (perFileButton) {
            progress('attachment-click', 'Clicking Download file');
            downloadPath = await clickAndSaveDownload(page, perFileButton, assetDir);
            downloadSource = 'hover-file';
          }
        } catch (error) {
          individualDownloadError = error;
        }
      }
    }
    if (!downloadPath) {
      // A Download-all archive cannot safely be mapped back to a Gemini-picked
      // thumbnail when several images are present. Do not guess the poster.
      if (items.length > 1) {
        const detail = individualDownloadError ? ` Download file failed: ${individualDownloadError.message}` : '';
        throw new Error(`The selected popup attachment #${selectedIndex} could not be downloaded individually.${detail}`);
      }
      progress('attachment-archive-fallback', 'Falling back to Download all attachments');
      const allAttachments = allAttachmentsDownloadButton(root);
      try {
        await allAttachments.waitFor({ state: 'visible', timeout: 5000 });
        downloadPath = await clickAndSaveDownload(page, allAttachments, assetDir);
      } catch (archiveError) {
        const individualDetail = individualDownloadError ? ` Download file failed first: ${individualDownloadError.message}` : '';
        if (items.length === 0) {
          throw new Error(`No image attachment was found in the selected ticket or its comments. CRM did not expose a downloadable poster.${individualDetail}`);
        }
        throw new Error(`CRM did not create a poster download.${individualDetail} Download all attachments also failed: ${archiveError.message}`);
      }
    }
    if (downloadSource === 'hover-file' || downloadSource === 'direct-url') return { ...validateDownloadedImage(downloadPath), source: downloadSource, candidateIndex: selectedIndex };
    if (!/\.zip$/i.test(downloadPath)) return { ...validateDownloadedImage(downloadPath), source: downloadSource, candidateIndex: selectedIndex };
    execFileSync('tar', ['-xf', downloadPath, '-C', assetDir], { windowsHide: true });
    const files = imageFiles(assetDir);
    if (files.length === 0) throw new Error('The selected ticket attachment archive contains no PNG, JPEG, GIF, or WebP poster image.');
    if (files.length > 1) throw new Error(`The selected ticket attachment archive contains ${files.length} image files; a popup ticket must have exactly one poster.`);
    return { ...validateDownloadedImage(files[0]), source: downloadSource, candidateIndex: selectedIndex };
  } catch (error) {
    error.stage = 'attachment-download';
    throw error;
  }
}

async function ensureAnnouncementPlugin(page, baseUrl) {
  let state = await reloadPlugins(page, baseUrl);
  let updated = false;
  if (state.state === 'missing') {
    state = await installAnnouncementPlugin(page, baseUrl);
  }
  if (state.state === 'outdated') {
    state = await updateAnnouncementPlugin(page, baseUrl);
    updated = true;
  }
  if (state.state === 'updating') {
    // A previous run may have initiated Update and stopped while CMS was
    // still working. Do not touch Page editor until that update settles.
    state = await waitForAnnouncementPluginState(page, 'current', 90000);
    if (state?.state !== 'current') state = await reloadPlugins(page, baseUrl);
    if (state.state !== 'current') throw new Error('Announcement plugin is still updating; popup section creation was skipped.');
    updated = true;
  }
  if (!state.enabled) {
    const row = await announcementRow(page);
    const toggle = row.locator('[role="switch"]').first();
    await toggle.click();
    await page.waitForTimeout(600);
    state = await readAnnouncementPlugin(page);
    if (!state.enabled) throw new Error('Announcement plugin did not become active.');
  }
  return { ...state, updated };
}

async function openPageEditor(page, baseUrl) {
  await page.goto(`${baseUrl}/pages`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByText('index.yml', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await page.getByText('index.yml', { exact: true }).first().click();
  await page.getByText('Content blocks', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
}

async function visiblePopupSection(page, description = null) {
  return visibleMatch(page.getByText(/^(?:Annoucement|Announcement) Popup$/), description, true);
}

async function popupSectionCards(page, { includeCorrupted = false } = {}) {
  const cards = page.locator('div[id^="item_block_section#"]');
  const validCards = [];
  const corruptedCards = [];
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    if (!await card.isVisible().catch(() => false)) continue;
    const text = (await card.innerText().catch(() => '')).trim();
    if (/(?:^|\n)(?:Annoucement|Announcement) Popup(?:\n|$)/.test(text)) validCards.push(card);
    else if (/^N\/?A[\s\n]+N\/?A$/i.test(text) || text === 'N/A') corruptedCards.push(card);
  }
  if (includeCorrupted) {
    return [...validCards, ...corruptedCards];
  }
  // When valid Announcement sections exist, ignore corrupted N/A sections
  return validCards.length > 0 ? validCards : corruptedCards;
}

async function popupSectionCardById(page, sectionId) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const cards = await popupSectionCards(page);
    if (sectionId) {
      for (const card of cards) {
        if (await card.getAttribute('id') === sectionId) return card;
      }
    }
    // If exact sectionId is not found or changed, but valid Announcement Popup cards exist:
    if (cards.length === 1) return cards[0];
    if (cards.length > 1) {
      // Prefer card explicitly showing Announcement Popup and not N/A
      for (const card of cards) {
        const text = await card.innerText().catch(() => '');
        if (/(?:Annoucement|Announcement) Popup/i.test(text) && !/^N\/?A/i.test(text)) {
          return card;
        }
      }
      return cards.at(-1);
    }
    await page.waitForTimeout(200);
  }
  return null;
}


async function inspectAnnouncementSectionVersions(page, baseUrl, pluginVersion) {
  await openPageEditor(page, baseUrl);
  const expectedToken = announcementSectionVersionToken(pluginVersion);
  const sections = [];
  for (const card of await popupSectionCards(page)) {
    const text = await card.innerText().catch(() => '');
    const marker = /\bANNOUNCEMENT\s+(\d{3,})\b/i.exec(text)?.[1] || null;
    const isCurrent = Boolean(expectedToken && marker && marker === expectedToken);
    sections.push({
      id: await card.getAttribute('id'),
      marker,
      legacy: !isCurrent
    });
  }
  return {
    expectedToken,
    sections,
    legacySectionIds: sections.filter((section) => section.legacy && section.id).map((section) => section.id)
  };
}

async function waitForPopupSectionCardCount(page, expected) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const cards = await popupSectionCards(page);
    if (cards.length === expected) return cards;
    await page.waitForTimeout(200);
  }
  throw new Error(`Announcement section count did not reach ${expected}.`);
}

async function popupSectionCardForVersion(cards, expectedToken) {
  for (const card of cards) {
    if (!expectedToken) return card;
    const text = await card.innerText().catch(() => '');
    const marker = /\bANNOUNCEMENT\s+(\d{3,})\b/i.exec(text)?.[1] || null;
    if (marker === expectedToken) return card;
  }
  return null;
}

async function deleteSectionCard(page, card) {
  const menuButton = await visibleMatch(card.locator('button.button-drag'), 'Section menu', true);
  if (!menuButton) return false;
  await menuButton.click();
  const menu = await waitForVisibleMatch(page.getByRole('menu'), 'Section menu', true, 3000);
  const remove = await visibleMatch(
    menu.getByRole('menuitem', { name: 'Delete item', exact: true }),
    'Section Delete item control',
    true
  );
  if (!remove) return false;
  await remove.click();
  const confirm = await waitForVisibleMatch(
    page.getByRole('button', { name: /^(?:Confirm|Delete|Yes)$/i }),
    'Section delete confirmation',
    true,
    1800
  ).catch(() => null);
  if (confirm) await confirm.click();
  await card.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

async function deleteLegacyPopupSections(page, targetSectionIds = []) {
  let removedCount = 0;
  const targetIds = new Set((Array.isArray(targetSectionIds) ? targetSectionIds : []).filter(Boolean));

  // 1. Delete sections by target ID recorded before plugin update (even if CMS renamed them to N/A)
  for (const id of targetIds) {
    const card = page.locator(`div#${id}`);
    if (await card.isVisible().catch(() => false)) {
      const deleted = await deleteSectionCard(page, card).catch(() => false);
      if (deleted) removedCount += 1;
    }
  }

  // 2. Delete any sections that still match Announcement popup cards
  let cards = await popupSectionCards(page, { includeCorrupted: true });
  while (cards.length) {
    const card = cards.at(-1);
    const deleted = await deleteSectionCard(page, card).catch(() => false);
    if (!deleted) break;
    removedCount += 1;
    cards = await popupSectionCards(page, { includeCorrupted: true });
  }

  // 3. Delete any orphaned N/A section cards in the editor left behind by plugin upgrade
  const allCards = page.locator('div[id^="item_block_section#"]');
  for (let i = (await allCards.count()) - 1; i >= 0; i -= 1) {
    const card = allCards.nth(i);
    if (!await card.isVisible().catch(() => false)) continue;
    const text = (await card.innerText().catch(() => '')).trim();
    if (/^N\/?A[\s\n]+N\/?A$/i.test(text) || text === 'N/A') {
      const deleted = await deleteSectionCard(page, card).catch(() => false);
      if (deleted) removedCount += 1;
    }
  }

  return removedCount;
}

async function ensurePopupSection(page, baseUrl, { replaceExisting = false, expectedPluginVersion = null, targetSectionIds = [] } = {}) {
  await openPageEditor(page, baseUrl);
  // This checks the active editor UI only. index.yml is written by CMS Build,
  // so it is not used as a source of truth for the popup workflow.
  const expectedToken = announcementSectionVersionToken(expectedPluginVersion);
  const existing = await popupSectionCards(page);
  let removedCount = 0;
  if (replaceExisting) removedCount = await deleteLegacyPopupSections(page, targetSectionIds);
  else if (existing.length) {
    const currentCard = await popupSectionCardForVersion(existing, expectedToken);
    if (!currentCard) {
      throw new Error(`Existing Announcement section does not match plugin ${expectedPluginVersion || 'version unknown'}; it was not reused.`);
    }
    return {
      exists: true,
      sectionId: await currentCard.getAttribute('id'),
      created: false,
      replaced: false,
      removedCount: 0
    };
  }
  // The menu wrapper also has role=button. Target the native button inside it
  // so Playwright does not treat the pair as an ambiguous control.
  const addSection = await visibleMatch(
    page.locator('button').filter({ hasText: /^Add new section$/ }),
    'Add new section control',
    true
  );
  await addSection.click();
  const choice = await visiblePopupSection(page, 'Annoucement Popup in Add new section');
  await choice.click();
  await choice.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  // CMS stages the new section in its editor; index.yml is only updated at Build.
  let createdCard = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const createdCards = await waitForPopupSectionCardCount(page, 1);
    createdCard = await popupSectionCardForVersion(createdCards, expectedToken);
    if (createdCard) break;
    await page.waitForTimeout(300);
  }
  if (!createdCard) {
    throw new Error(`CMS did not render a new Announcement section for plugin ${expectedPluginVersion || 'version unknown'}.`);
  }
  // Clean up any remaining orphaned N/A section cards in the editor
  const orphanCards = page.locator('div[id^="item_block_section#"]');
  for (let i = (await orphanCards.count()) - 1; i >= 0; i -= 1) {
    const card = orphanCards.nth(i);
    if (!await card.isVisible().catch(() => false)) continue;
    const text = (await card.innerText().catch(() => '')).trim();
    if (/^N\/?A[\s\n]+N\/?A$/i.test(text) || text === 'N/A') {
      await deleteSectionCard(page, card).catch(() => false);
    }
  }
  return {
    exists: true,
    sectionId: await createdCard.getAttribute('id'),
    created: true,
    replaced: removedCount > 0,
    removedCount
  };
}

// A duration-only ticket changes settings on an existing popup. It must never
// use the creation path, otherwise a missing section becomes a new empty block.
async function existingPopupSection(page, baseUrl, { expectedPluginVersion = null } = {}) {
  await openPageEditor(page, baseUrl);
  const existing = await popupSectionCards(page);
  if (!existing.length) {
    const error = new Error('No existing Announcement Popup section was found. A duration-only ticket cannot create a new popup section.');
    error.stage = 'popup-section-not-found';
    throw error;
  }

  const expectedToken = announcementSectionVersionToken(expectedPluginVersion);
  let card = await popupSectionCardForVersion(existing, expectedToken);
  // An older but unique popup is still a safe target. Multiple unmatched
  // sections are ambiguous and must not be changed automatically.
  if (!card && existing.length === 1) card = existing[0];
  if (!card) {
    const error = new Error(`Found ${existing.length} Announcement Popup sections but could not identify a unique section for the duration-only update.`);
    error.stage = 'popup-section-ambiguous';
    throw error;
  }
  return {
    exists: true,
    sectionId: await card.getAttribute('id'),
    created: false,
    replaced: false,
    removedCount: 0
  };
}

async function isPopupSectionEditorAlreadyOpen(page) {
  return page.evaluate(() => {
    // 1. Check for Add block button in DOM
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], .el-button'));
    if (buttons.some((b) => /Add\s*block/i.test(b.textContent || ''))) return true;

    // 2. Check for check-all list items input
    if (document.querySelector('input[name^="check-all-list_items-"], input[type="checkbox"][name*="list_items"]')) return true;

    // 3. Check for section setting headers/labels
    const elements = Array.from(document.querySelectorAll('span, div, p, label, h3, h4'));
    if (elements.some((el) => {
      const text = el.textContent || '';
      return /Popup[\s_]setting/i.test(text)
        || /Slide direction style/i.test(text)
        || /Time delay slider/i.test(text)
        || /List\s*items/i.test(text);
    })) return true;

    return false;
  }).catch(() => false);
}

async function openPopupSection(page, sectionId = null) {
  // If Announcement Popup editor is already open (Preview / Slide direction style / Add block / Popup_setting),
  // do not re-click the background section card in the page editor. Clicking the background card while
  // the section drawer is open causes Playwright to fail with a 30s timeout because the drawer overlay
  // (absolute inset-0 z-10) intercepts pointer events.
  if (await isPopupSectionEditorAlreadyOpen(page)) {
    const settingsCard = await visibleMatch(page.getByText(/Popup[\s_]setting/i), null, true).catch(() => null)
      || await visibleMatch(page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")'), null, true).catch(() => null)
      || page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")').first();
    return settingsCard;
  }

  // Ensure section cards are present
  let card = await popupSectionCardById(page, sectionId);
  if (!card) {
    await returnToPageEditor(page);
    card = await popupSectionCardById(page, sectionId);
  }

  if (card) {
    const section = await visibleMatch(card.getByText(/^(?:Annoucement|Announcement) Popup$/), 'Announcement section', true)
      || await visibleMatch(card.locator('span, div, p').filter({ hasText: /^N\/A$/ }), 'Announcement section', true)
      || card;
    if (section) {
      await section.click();
      await page.waitForTimeout(400);
    }
  }

  // Wait for drawer to open without spamming clicks in a loop!
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isPopupSectionEditorAlreadyOpen(page)) {
      const settingsCard = await visibleMatch(page.getByText(/Popup[\s_]setting/i), null, true).catch(() => null)
        || await visibleMatch(page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")'), null, true).catch(() => null)
        || page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")').first();
      return settingsCard;
    }
    await page.waitForTimeout(250);
  }

  // If still not open after 10s, attempt a single fallback click
  const retrySection = await visiblePopupSection(page, null);
  if (retrySection) {
    await retrySection.click().catch(() => {});
    const retryDeadline = Date.now() + 5000;
    while (Date.now() < retryDeadline) {
      if (await isPopupSectionEditorAlreadyOpen(page)) {
        return page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")').first();
      }
      await page.waitForTimeout(250);
    }
  }

  throw new Error('Popup section editor did not open after the section was added.');
}

async function openPopupSettings(page, sectionId = null) {
  await openPopupSection(page, sectionId);
  const isAddBlockVisible = async () => {
    return isElementDisplayed(page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")').first());
  };
  if (await isAddBlockVisible()) return;

  const popupSetting = await visibleMatch(page.getByText('Popup_setting', { exact: true }), null)
    || await visibleMatch(page.getByText(/Popup[\s_]setting/i), null);

  if (!popupSetting) {
    if (await isAddBlockVisible()) return;
    return;
  }

  // Check if the accordion item is already expanded/active before clicking
  const isExpanded = await popupSetting.evaluate((el) => {
    const item = el.closest('.el-collapse-item') || el.closest('[role="tab"]') || el.parentElement;
    if (item && (item.classList.contains('is-active') || item.classList.contains('active'))) return true;
    if (el.getAttribute('aria-expanded') === 'true' || el.closest('[aria-expanded="true"]')) return true;
    return false;
  }).catch(() => false);

  if (!isExpanded) {
    await popupSetting.click();
  }

  const appeared = await waitForVisibleMatch(
    page.getByRole('button', { name: /Add\s*block/i }),
    null,
    true,
    4000
  ).catch(() => null) || await waitForVisibleMatch(
    page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")'),
    null,
    true,
    4000
  ).catch(() => null);

  if (!appeared) {
    // If clicking closed an already open accordion or if the transition was delayed,
    // retry clicking Popup_setting once to re-open the panel.
    await popupSetting.click().catch(() => {});
    await waitForVisibleMatch(
      page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")'),
      'Popup Add block control',
      true,
      8000
    );
  }
}

async function waitForSaveEnabled(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const save = await visibleMatch(page.getByRole('button', { name: 'Save', exact: true }), null, true);
    if (save && !await save.isDisabled()) return save;
    await page.waitForTimeout(200);
  }
  throw new Error('Popup Save control did not become enabled.');
}


function legacyImageExtension(rawUrl, contentType = '') {
  const pathname = (() => {
    try { return new URL(rawUrl).pathname; } catch { return rawUrl; }
  })();
  const extension = path.extname(pathname).replace(/^\./, '').toLowerCase();
  if (/^(?:png|jpe?g|webp|gif)$/.test(extension)) return extension === 'jpeg' ? 'jpg' : extension;
  if (/image\/png/i.test(contentType)) return 'png';
  if (/image\/jpe?g/i.test(contentType)) return 'jpg';
  if (/image\/gif/i.test(contentType)) return 'gif';
  return 'webp';
}

async function downloadLegacyPopupImage(page, rawUrl, assetDir, index) {
  const dataUri = /^data:(image\/(?:png|jpe?g|webp|gif))(;base64)?,([\s\S]+)$/i.exec(rawUrl || '');
  let bytes;
  let contentType = '';
  let sourceUrl = rawUrl;
  if (dataUri) {
    contentType = dataUri[1];
    bytes = dataUri[2] ? Buffer.from(dataUri[3], 'base64') : Buffer.from(decodeURIComponent(dataUri[3]));
  } else {
    sourceUrl = new URL(rawUrl, page.url()).href;
    const response = await page.request.get(sourceUrl, { timeout: 30000 });
    if (!response.ok()) throw new Error(`Could not download active legacy popup image (${response.status()}) from ${sourceUrl}.`);
    contentType = response.headers()['content-type'] || '';
    bytes = await response.body();
  }
  const target = path.join(assetDir, `legacy-popup-${index + 1}.${legacyImageExtension(sourceUrl, contentType)}`);
  fs.writeFileSync(target, bytes);
  return validateDownloadedImage(target);
}

async function snapshotActiveLegacyPopups(page, baseUrl, timezone, runDir, { preserveActive = true } = {}) {
  await openPageEditor(page, baseUrl);
  const cards = await popupSectionCards(page);
  const targetSectionIds = [];
  for (const card of cards) {
    const sectionId = await card.getAttribute('id');
    if (sectionId && !targetSectionIds.includes(sectionId)) {
      targetSectionIds.push(sectionId);
    }
  }
  const sectionIds = [];
  const preserved = [];
  const scannedItems = [];
  const warnings = [];
  let expiredCount = 0;
  const assetDir = path.join(runDir, preserveActive ? 'legacy-popup' : 'popup-image-scan');
  fs.mkdirSync(assetDir, { recursive: true });
  for (let sIdx = 0; sIdx < targetSectionIds.length; sIdx += 1) {
    const sectionId = targetSectionIds[sIdx];
    if (sIdx > 0) {
      await openPageEditor(page, baseUrl);
      await waitForVisibleMatch(
        page.locator(`div#${sectionId}`),
        `Legacy announcement section ${sectionId}`,
        true,
        8000
      ).catch(() => {});
    }
    sectionIds.push(sectionId);
    await openPopupSettings(page, sectionId);
    const sectionDefaults = await page.evaluate(() => {
      const findVal = (field) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const input of inputs) {
          const name = (input.getAttribute('name') || '').toLowerCase();
          const id = (input.getAttribute('id') || '').toLowerCase();
          if (name.includes('list_items') || id.includes('list_items')) continue;
          if (name === field || id === field || name.endsWith(`[${field}]`) || name.includes(`setting-${field}`) || name.includes(`setting_${field}`)) {
            if (input.value && input.value.trim()) return input.value.trim();
          }
        }
        const labels = Array.from(document.querySelectorAll('label, .el-form-item__label'));
        for (const label of labels) {
          const text = (label.innerText || '').trim().toLowerCase();
          if ((field === 'time_start' && text === 'time start') || (field === 'time_end' && text === 'time end')) {
            const forId = label.getAttribute('for');
            if (forId) {
              const input = document.getElementById(forId);
              if (input && input.value && input.value.trim()) return input.value.trim();
            }
            const parent = label.closest('.el-form-item') || label.parentElement;
            const input = parent?.querySelector('input');
            if (input && input.value && input.value.trim()) return input.value.trim();
          }
        }
        return null;
      };
      return {
        time_start: findVal('time_start'),
        time_end: findVal('time_end')
      };
    }).catch(() => ({ time_start: null, time_end: null }));

    const { items } = await readPopupListItems(page);
    for (const item of items) {
      if (isEmptyPopupItem(item)) continue;
      const rawStart = item?.time_start || sectionDefaults.time_start;
      const rawEnd = item?.time_end || sectionDefaults.time_end;
      const start = popupDateFromCmsValue(rawStart, timezone);
      const end = popupDateFromCmsValue(rawEnd, timezone);
      if (rawStart && !start && preserveActive) throw new Error(`Could not read the start date of a popup in legacy Announcement section ${sectionId}. Old section was kept.`);
      if (rawEnd && !end && preserveActive) throw new Error(`Could not read the expiry date of a popup in legacy Announcement section ${sectionId}. Old section was kept.`);
      if (!item?.image || typeof item.image !== 'string') {
        throw new Error(preserveActive
          ? `An active popup in legacy Announcement section ${sectionId} has no readable image. Old section was kept.`
          : `Duplicate check could not read an image from configured popup section ${sectionId}. CMS was not changed and Build was not started.`);
      }
      let image;
      try {
        image = await downloadLegacyPopupImage(page, item.image, assetDir, scannedItems.length);
      } catch (error) {
        throw new Error(preserveActive
          ? error.message
          : `Duplicate check could not download one current CMS popup image: ${error.message} CMS was not changed and Build was not started.`);
      }
      const scanned = {
        imagePath: image.path,
        filename: image.filename,
        bytes: image.bytes,
        sha256: image.sha256,
        sourceImageUrl: item.image,
        start: start ? { date: start } : null,
        end: end ? { date: end } : null,
        imageLink: item?.link ? String(item.link).trim() : null
      };
      scannedItems.push(scanned);
      if (end && end < todayInTimezone(timezone.iana)) {
        expiredCount += 1;
        continue;
      }
      if (preserveActive) preserved.push(scanned);
    }
  }
  return { sectionIds, items: preserved, scannedItems, expiredCount, warnings };
}

function writeLegacyPopupSnapshot(runDir, snapshot) {
  // Keep the exact local assets and dates before deleting an old section.
  // If a browser/UI interruption happens afterwards, the next run can resume
  // the migration instead of deleting the replacement section or losing a
  // still-active popup.
  const payload = {
    version: 1,
    recordedAt: new Date().toISOString(),
    items: snapshot.items.map((item) => ({
      asset: path.relative(runDir, item.imagePath),
      filename: item.filename,
      sourceImageUrl: item.sourceImageUrl,
      start: item.start,
      end: item.end,
      imageLink: item.imageLink || null
    }))
  };
  fs.writeFileSync(path.join(runDir, 'legacy-popup-snapshot.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function priorRunRecords(root, currentRunDir) {
  const records = [];
  for (const runsRoot of runDirectoryRoots(root)) {
    let entries = [];
    try { entries = fs.readdirSync(runsRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(runsRoot, entry.name);
      if (path.resolve(directory) === path.resolve(currentRunDir)) continue;
      const planPath = path.join(directory, 'plan.json');
      const plan = readJsonFile(planPath);
      if (!plan) continue;
      let modifiedAt = 0;
      try { modifiedAt = fs.statSync(planPath).mtimeMs; } catch { /* ignore unreadable report */ }
      records.push({ directory, plan, modifiedAt });
    }
  }
  return records.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function scheduleFromPlanPopup(popup) {
  return {
    start: popup?.start ? { date: popup.start } : null,
    end: popup?.expiry ? { date: popup.expiry } : null
  };
}

function recoverInterruptedLegacyMigration(root, {
  siteId,
  ticketUrl,
  attachmentFilename,
  timezone,
  currentRunDir
}) {
  // This is deliberately narrow: only resume a fresh, unfinished section
  // replacement for this exact website from the current work session.
  const cutoff = Date.now() - (12 * 60 * 60 * 1000);
  const records = priorRunRecords(root, currentRunDir);
  const interrupted = records.find(({ plan, modifiedAt, directory }) => {
    if (modifiedAt < cutoff) return false;
    const planSiteId = plan.cms?.siteId || plan.ticket?.siteId;
    if (String(planSiteId || '') !== String(siteId || '')) return false;
    if (plan.ticketUrl !== ticketUrl) return false;
    if (plan.popupSection?.replaced !== true || plan.popupSection?.created !== true) return false;
    const hasSnapshot = fs.existsSync(path.join(directory, 'legacy-popup-snapshot.json'));
    if (!hasSnapshot) return false;
    const snapshot = readJsonFile(path.join(directory, 'legacy-popup-snapshot.json'));
    const snapshotCount = Array.isArray(snapshot?.items) ? snapshot.items.length : 0;
    if (snapshotCount === 0) return false;
    const actualCmsCount = Array.isArray(plan.popup?.cmsImageUrls) ? plan.popup.cmsImageUrls.length : (plan.popup?.cmsImageUrl ? 1 : 0);
    const incompleteMigration = snapshotCount > 1 && actualCmsCount < snapshotCount;
    const isFailed = /(?:section-apply|popup-settings|popup-item|popup-ticket|popup-position).*failed$/i.test(plan.status || '')
      || (!completedPopupRun(plan) && !plan.build?.completed);
    const missingMigration = plan.popup?.imageConfigured && (Number(plan.popup?.migratedLegacyPopups || 0) === 0 || incompleteMigration);
    return isFailed || missingMigration || incompleteMigration;
  });
  if (!interrupted) return null;

  const snapshot = readJsonFile(path.join(interrupted.directory, 'legacy-popup-snapshot.json'));
  const snapshotCount = Array.isArray(snapshot?.items) ? snapshot.items.length : 0;

  // Once a later run has successfully configured this same ticket WITH migrated
  // popups, an older interrupted migration is no longer resumable state.
  const laterSuccessfulRun = records.find(({ plan, modifiedAt }) => {
    const planSiteId = plan.cms?.siteId || plan.ticket?.siteId;
    if (modifiedAt <= interrupted.modifiedAt) return false;
    if (!completedPopupRun(plan)) return false;
    if (String(planSiteId || '') !== String(siteId || '')) return false;
    if (plan.ticketUrl !== ticketUrl) return false;
    const cmsCount = Array.isArray(plan.popup?.cmsImageUrls) ? plan.popup.cmsImageUrls.length : (plan.popup?.cmsImageUrl ? 1 : 0);
    return cmsCount >= snapshotCount && Number(plan.popup?.migratedLegacyPopups || 0) >= (snapshotCount - 1);
  });
  if (laterSuccessfulRun) return null;

  let items = [];
  if (Array.isArray(snapshot?.items)) {
    items = snapshot.items.map((item) => ({
      imagePath: path.resolve(interrupted.directory, item.asset || ''),
      filename: item.filename || null,
      sourceImageUrl: item.sourceImageUrl || item.filename || null,
      start: item.start || null,
      end: item.end || null,
      imageLink: item.imageLink || null
    })).filter((item) => item.imagePath.startsWith(`${path.resolve(interrupted.directory)}${path.sep}`) && fs.existsSync(item.imagePath));
  }

  // Reports made before the journal existed can still be resumed safely when
  // the same ticket previously published the same named poster.  This covers
  // an interrupted upgrade without guessing an image or its date range.
  if (!items.length) {
    const assets = fs.readdirSync(interrupted.directory)
      .filter((name) => /^legacy-popup-\d+\.(?:png|jpe?g|webp|gif)$/i.test(name))
      .map((name) => path.join(interrupted.directory, name));
    const priorPopup = records.find(({ plan, directory }) => (
      directory !== interrupted.directory
      && plan.cms?.siteId === siteId
      && plan.ticketUrl === ticketUrl
      && plan.attachment?.filename === attachmentFilename
      && plan.popup?.imageConfigured === true
    ));
    if (assets.length === 1 && priorPopup) {
      const schedule = scheduleFromPlanPopup(priorPopup.plan.popup);
      items = [{
        imagePath: assets[0],
        filename: attachmentFilename,
        sourceImageUrl: attachmentFilename,
        start: schedule.start,
        end: schedule.end
      }];
    }
  }

  const today = todayInTimezone(timezone.iana);
  items = items.filter((item) => !item.end?.date || item.end.date >= today);
  if (!items.length) return null;
  return { sourceDirectory: interrupted.directory, items };
}


function attachmentMatchEvidence(previous, current) {
  if (!previous || !current) return null;
  if (previous.sha256 && current.sha256) {
    return previous.sha256 === current.sha256 ? 'sha256' : null;
  }
  // Older reports did not yet contain a hash.  A same-ticket fallback is
  // allowed only when both the name and exact byte length agree.
  return previous.filename && current.filename
    && previous.filename === current.filename
    && Number(previous.bytes) > 0
    && Number(previous.bytes) === Number(current.bytes)
    ? 'legacy-filename-and-size'
    : null;
}

function completedPopupRun(plan) {
  if (!plan?.popup?.imageConfigured) return false;
  return ['popup-live', 'awaiting-build-approval', 'build-unconfirmed'].includes(plan.status)
    // A CMS URL is only read after the item editor has accepted the image.
    // Keep that mapping after an interrupted Build so a retry cannot upload
    // the same poster a second time.
    || Boolean(plan.popup.cmsImageUrl);
}

function findTicketPopupInHistory(root, currentRunDir, { siteId, ticketUrl, attachment, items }) {
  const matchingRuns = priorRunRecords(root, currentRunDir).filter(({ plan, directory }) => {
    if (!completedPopupRun(plan)) return false;
    if (plan.popup?.ticketPosterVerified !== true) return false;
    const planSiteId = plan.cms?.siteId || plan.ticket?.siteId;
    if (String(planSiteId || '') !== String(siteId || '')) return false;
    if (plan.ticketUrl !== ticketUrl) return false;
    if (!attachmentMatchEvidence(plan.attachment, attachment)) return false;
    // An incomplete migration run whose snapshot had more items than were actually uploaded
    // should not block recovery of the missing popups.
    const snapshotPath = path.join(directory, 'legacy-popup-snapshot.json');
    if (fs.existsSync(snapshotPath)) {
      const snap = readJsonFile(snapshotPath);
      const snapCount = Array.isArray(snap?.items) ? snap.items.length : 0;
      const actualCount = Array.isArray(plan.popup?.cmsImageUrls) ? plan.popup.cmsImageUrls.length : (plan.popup?.cmsImageUrl ? 1 : 0);
      if (snapCount > 1 && actualCount < snapCount) return false;
    }
    return true;
  });
  if (!matchingRuns.length) return { item: null, method: null, ambiguous: false };

  const configured = items.filter((item) => typeof item?.image === 'string' && item.image.trim());
  const mappedUrls = new Set(matchingRuns
    .map(({ plan }) => stableImageUrl(plan.popup?.cmsImageUrl))
    .filter(Boolean));
  const mappedItems = mappedUrls.size
    ? configured.filter((item) => mappedUrls.has(stableImageUrl(item.image)))
    : [];
  if (mappedItems.length === 1) {
    const evidence = attachmentMatchEvidence(matchingRuns[0].plan.attachment, attachment);
    return { item: mappedItems[0], method: `history-url-${evidence}`, ambiguous: false };
  }
  if (mappedItems.length > 1) return { item: null, method: null, ambiguous: true };
  if (mappedUrls.size) return { item: null, method: null, ambiguous: false };

  // Compatibility path for reports made before URL mapping existed.  It is
  // intentionally limited to one configured CMS popup, so it cannot merge a
  // new ticket into an arbitrary image among several active popups.
  if (configured.length === 1) {
    const evidence = attachmentMatchEvidence(matchingRuns[0].plan.attachment, attachment);
    return { item: configured[0], method: `history-single-item-${evidence}`, ambiguous: false };
  }
  return { item: null, method: null, ambiguous: configured.length > 1 };
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

async function removeSingleExistingPopup(page) {
  const before = await readPopupListItems(page);
  if (before.items.length === 0) return { removed: false, previous: null };
  if (before.items.length !== 1 || !before.chooseAll) {
    const error = new Error(`Ticket asks to replace the old popup, but CMS has ${before.items.length} popup items. No item was removed because the target is ambiguous.`);
    error.stage = 'popup-replacement-ambiguous';
    throw error;
  }
  const previous = before.items[0];
  await before.chooseAll.check({ force: true });
  await page.waitForFunction(() => /Selected\s*Items\s*Count\s*:\s*1\b/i.test(document.body?.innerText || ''), null, { timeout: 5000 });
  const remove = await visibleMatch(page.getByRole('button', { name: 'Delete', exact: true }), 'Popup Delete control', true);
  await remove.click();
  const confirmationText = 'Are you sure you want to delete 1 items?';
  await waitForVisibleMatch(page.getByText(confirmationText, { exact: true }), 'Popup delete confirmation', true, 5000);
  const confirm = await visibleMatch(page.getByRole('button', { name: 'Confirm', exact: true }), 'Popup delete Confirm control', true);
  await confirm.click();
  await waitForPopupListItemCount(page, 0);
  await page.waitForTimeout(600);
  return { removed: true, previous };
}

async function popupPositionPersisted(page, beforeItems, imageUrl, position, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = { ok: false, reason: 'not-observed' };
  while (Date.now() < deadline) {
    const { items } = await readPopupListItems(page);
    last = verifyPopupPosition(beforeItems, items, [imageUrl], position);
    if (last.ok) return { ok: true, items };
    await page.waitForTimeout(180);
  }
  return { ok: false, reason: last.reason };
}

async function dragPopupImageToPosition(page, imageUrl, position) {
  const before = await readPopupListItems(page);
  const plan = planPopupPosition(before.items, [imageUrl], position);
  if (!plan.ok) {
    const error = new Error(`Popup image position is ambiguous (${plan.reason}). CMS Build was not started.`);
    error.stage = 'popup-position-verification';
    throw error;
  }
  if (!plan.needsMove) return false;

  const sourceIndex = plan.targetIndexes[0];
  const destinationIndex = position === 'first' ? 0 : before.items.length - 1;
  const cards = await popupListItemCards(page, before.items.length);
  const sourceCard = cards[sourceIndex];
  const destinationCard = cards[destinationIndex];

  // Primary Strategy: Move using the card's native context menu ("Move to top" / "Move to bottom")
  try {
    const menuButton = await visibleMatch(
      sourceCard.locator('button.button-drag, [class*="button-drag"], [class*="drag-handle"], button[class*="drag"], button:has([class*="bars"]), svg.cursor-grab, svg.cursor-move, [role="button"]:has(svg)'),
      null,
      true
    ).catch(() => null) || await visibleMatch(sourceCard.locator('button, [role="button"]').last(), null, true).catch(() => null);

    if (menuButton) {
      await sourceCard.evaluate((el) => {
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
      }).catch(() => {});
      await menuButton.click({ force: true });
      const menu = await waitForVisibleMatch(page.getByRole('menu'), null, true, 2500).catch(() => null);
      if (menu) {
        const movePattern = position === 'first'
          ? /^(?:Move\s+to\s+top|Chuyển\s+lên\s+đầu|Lên\s+đầu)$/i
          : /^(?:Move\s+to\s+bottom|Chuyển\s+xuống\s+dưới|Xuống\s+dưới)$/i;
        const fallbackPattern = position === 'first' ? /Move\s+to\s+top|top/i : /Move\s+to\s+bottom|bottom/i;
        const moveOption = await visibleMatch(
          menu.getByRole('menuitem', { name: movePattern }),
          null,
          true
        ).catch(() => null) || await visibleMatch(
          menu.locator('button, [role="menuitem"], a, div, span').filter({ hasText: fallbackPattern }),
          null,
          true
        ).catch(() => null);
        if (moveOption) {
          await moveOption.click({ force: true });
          const persistedByMenu = await popupPositionPersisted(page, before.items, imageUrl, position, 3500);
          if (persistedByMenu.ok) return true;
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch {}

  const sourceHandle = await visibleMatch(
    sourceCard.locator('button.button-drag, [class*="button-drag"], [class*="drag-handle"], button[class*="drag"], button:has([class*="bars"]), svg.cursor-grab, svg.cursor-move, [role="button"]:has(svg)'),
    'Popup position drag handle',
    true
  ) || await visibleMatch(sourceCard.locator('button, [role="button"]').last(), 'Popup position drag handle', true);
  await sourceCard.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' })).catch(() => {});
  await destinationCard.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' })).catch(() => {});
  const destinationBox = await destinationCard.boundingBox();
  if (!destinationBox) {
    const error = new Error('Popup destination card was not visible for reordering. CMS Build was not started.');
    error.stage = 'popup-position-verification';
    throw error;
  }
  const targetPosition = {
    x: Math.max(8, Math.floor(destinationBox.width / 2)),
    y: position === 'first' ? 2 : Math.max(2, destinationBox.height - 2)
  };
  await sourceHandle.dragTo(destinationCard, { targetPosition, force: true, timeout: 7000 }).catch(() => {});
  let persisted = await popupPositionPersisted(page, before.items, imageUrl, position, 3500);
  if (!persisted.ok) {
    await page.keyboard.press('Escape').catch(() => {});
    const refreshed = await readPopupListItems(page);
    const refreshedPlan = planPopupPosition(refreshed.items, [imageUrl], position);
    if (refreshedPlan.ok && refreshedPlan.needsMove) {
      const refreshedCards = await popupListItemCards(page, refreshed.items.length);
      const refreshedSource = refreshedCards[refreshedPlan.targetIndexes[0]];
      const refreshedDestination = refreshedCards[position === 'first' ? 0 : refreshed.items.length - 1];
      const handleLocator = refreshedSource.locator('button.button-drag, [class*="button-drag"], [class*="drag-handle"], button[class*="drag"], button:has([class*="bars"]), svg.cursor-grab, svg.cursor-move, [role="button"]:has(svg)');
      const handleBox = await (handleLocator.first().boundingBox().catch(() => null)) || await refreshedSource.locator('button, [role="button"]').last().boundingBox().catch(() => null);
      const targetBox = await refreshedDestination.boundingBox();
      if (handleBox && targetBox) {
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          targetBox.x + targetBox.width / 2,
          position === 'first' ? targetBox.y + 2 : targetBox.y + targetBox.height - 2,
          { steps: 12 }
        );
        await page.mouse.up();
        // Always verify against the original pre-drag list. A failed first
        // attempt must never redefine a reordered/corrupted list as the new
        // baseline for the fallback attempt.
        persisted = await popupPositionPersisted(page, before.items, imageUrl, position, 5000);
      }
    }
  }
  if (!persisted.ok) {
    const error = new Error(`Popup image could not be moved to the requested ${position} position (${persisted.reason || 'not-persisted'}). CMS Build was not started.`);
    error.stage = 'popup-position-verification';
    throw error;
  }
  return true;
}

async function movePopupImagesToPosition(page, imageUrls, position) {
  if (position !== 'first' && position !== 'last') return { applied: false, moved: false };
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  const ordered = position === 'last' ? urls : [...urls].reverse();
  let moved = false;
  for (const imageUrl of ordered) {
    moved = await dragPopupImageToPosition(page, imageUrl, position) || moved;
  }
  const finalItems = (await readPopupListItems(page)).items;
  const finalPlan = planPopupPosition(finalItems, urls, position);
  if (!finalPlan.ok || finalPlan.needsMove) {
    const error = new Error(`Ticket popup order was not verified at the requested ${position} position. CMS Build was not started.`);
    error.stage = 'popup-position-verification';
    throw error;
  }
  return { applied: true, moved };
}

function popupOrderMatches(items, orderedImageUrls) {
  const actual = (Array.isArray(items) ? items : [])
    .map((item) => stableImageUrl(item?.image))
    .filter(Boolean);
  const expected = (Array.isArray(orderedImageUrls) ? orderedImageUrls : [])
    .map(stableImageUrl)
    .filter(Boolean);
  return actual.length === expected.length
    && expected.every((url, index) => actual[index] === url);
}

// NewZen can prepend or append every newly added card. During migration we
// restore the exact saved list order, unless the ticket explicitly requests a
// new first/last position for the ticket poster.
async function restoreMigratedPopupOrder(page, orderedImageUrls) {
  const expected = (Array.isArray(orderedImageUrls) ? orderedImageUrls : [])
    .map(stableImageUrl)
    .filter(Boolean);
  if (expected.length < 2) return { applied: false, moved: false };

  const before = await readPopupListItems(page);
  if (popupOrderMatches(before.items, expected)) return { applied: true, moved: false };

  // Apply Move to top from the last expected item backward. This produces the
  // complete target sequence using NewZen's stable native action.
  let moved = false;
  for (const imageUrl of [...expected].reverse()) {
    moved = await dragPopupImageToPosition(page, imageUrl, 'first') || moved;
  }
  const after = await readPopupListItems(page);
  if (!popupOrderMatches(after.items, expected)) {
    const error = new Error('Migrated popup order did not match the original section order. CMS Build was not started.');
    error.stage = 'popup-position-verification';
    throw error;
  }
  return { applied: true, moved };
}

async function returnToPageEditor(page) {
  const isDrawerOpen = await isPopupSectionEditorAlreadyOpen(page);
  if (!isDrawerOpen) return;

  // Find the Back button scoped strictly to the drawer or slideover
  const backBtn = page.locator(
    '.el-drawer:visible button:has-text("Back"), [role="dialog"]:visible button:has-text("Back"), div[class*="overflow-y-auto"]:visible button:has-text("Back"), div.absolute.inset-0:visible button:has-text("Back"), .el-page-header__left button, [class*="icon-back"]'
  ).first();

  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  } else {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

async function collectPopupRemovalCandidates(page, baseUrl, runDir) {
  await openPageEditor(page, baseUrl);
  const cards = await popupSectionCards(page);
  const assetDir = path.join(runDir, 'popup-removal-candidates');
  fs.mkdirSync(assetDir, { recursive: true });
  const items = [];
  let visionIndex = 1;
  for (let cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
    const card = cards[cardIndex];
    const sectionId = await card.getAttribute('id');
    if (!sectionId) continue;
    await openPopupSettings(page, sectionId);
    const { items: popupItems } = await readPopupListItems(page);
    for (let itemIndex = 0; itemIndex < popupItems.length; itemIndex += 1) {
      const popupItem = popupItems[itemIndex];
      if (!String(popupItem?.image || '').trim()) continue;
      const image = await downloadLegacyPopupImage(page, popupItem.image, assetDir, items.length);
      items.push({
        sectionId,
        itemIndex,
        sourceImageUrl: popupItem.image,
        imagePath: image.path,
        filename: image.filename,
        bytes: image.bytes,
        visionIndex
      });
      visionIndex += 1;
    }
    // Keep drawer open for the subsequent removal if this was the last card
    if (cardIndex < cards.length - 1) {
      await returnToPageEditor(page);
    }
  }
  return { sectionCount: cards.length, items };
}

async function removeAllPopupItems(page, baseUrl) {
  await openPageEditor(page, baseUrl);
  const sectionIds = [];
  for (const card of await popupSectionCards(page)) {
    const sectionId = await card.getAttribute('id');
    if (sectionId) sectionIds.push(sectionId);
  }
  let removedCount = 0;
  for (const sectionId of sectionIds) {
    await openPopupSettings(page, sectionId);
    let { items } = await readPopupListItems(page);
    while (items.length) {
      await deletePopupItemAtIndex(page, items.length - 1, items.length - 1, 'Popup item for removal');
      removedCount += 1;
      ({ items } = await readPopupListItems(page));
    }
    await returnToPageEditor(page);
  }
  return { sectionCount: sectionIds.length, removedCount, changed: removedCount > 0 };
}

async function removeOnePopupItem(page, baseUrl, target) {
  await openPageEditor(page, baseUrl);
  await openPopupSettings(page, target.sectionId);
  const before = await readPopupListItems(page);
  const expectedImage = stableImageUrl(target.sourceImageUrl);
  const matchingIndexes = before.items
    .map((item, index) => (stableImageUrl(item?.image) === expectedImage ? index : -1))
    .filter((index) => index >= 0);
  if (matchingIndexes.length !== 1) {
    const error = new Error(matchingIndexes.length === 0
      ? 'The popup image selected for removal is no longer present in CMS. No popup was removed and CMS Build was not started.'
      : `The Gemini-selected popup image maps to more than one CMS item (found ${matchingIndexes.length}). No popup was removed.`);
    error.stage = matchingIndexes.length === 0 ? 'popup-removal-not-found' : 'popup-removal-ambiguous';
    throw error;
  }
  const targetIndex = matchingIndexes[0];
  const expectedRemaining = before.items
    .filter((_, index) => index !== targetIndex)
    .map(popupItemSignature);
  await deletePopupItemAtIndex(page, targetIndex, before.items.length - 1, 'Gemini-matched popup item');
  const after = await readPopupListItems(page);
  // Every non-target item must remain in the same order after the delete.
  const afterSignatures = after.items.map(popupItemSignature);
  if (afterSignatures.length !== expectedRemaining.length || afterSignatures.some((signature, index) => signature !== expectedRemaining[index])) {
    const error = new Error('CMS deleted a popup item, but the remaining popup list could not be verified unchanged. CMS Build was not started.');
    error.stage = 'popup-removal-verification';
    throw error;
  }
  await returnToPageEditor(page);
  return { sectionId: target.sectionId, itemIndex: targetIndex, imageUrl: target.sourceImageUrl, removedCount: 1, changed: true };
}

async function removeMatchingPopupItems(page, baseUrl, targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { sectionCount: 0, removedCount: 0, changed: false };
  }
  const isDrawerOpen = await isPopupSectionEditorAlreadyOpen(page);
  const hasCards = (await page.locator('div[id^="item_block_section#"]').count().catch(() => 0)) > 0;
  if (!isDrawerOpen && !hasCards) {
    await openPageEditor(page, baseUrl);
  }
  if (!isDrawerOpen) {
    await waitForPopupSectionCardCount(page, 1).catch(() => {});
  }
  const targetsBySection = new Map();
  for (const target of targets) {
    if (!targetsBySection.has(target.sectionId)) {
      targetsBySection.set(target.sectionId, []);
    }
    targetsBySection.get(target.sectionId).push(target);
  }
  let totalRemoved = 0;
  for (const [sectionId, sectionTargets] of targetsBySection) {
    await openPopupSettings(page, sectionId);
    let { items } = await readPopupListItems(page);

    // Map targets with their current index in CMS items list
    const targetsWithIndices = sectionTargets.map((target) => {
      const targetImage = stableImageUrl(target.sourceImageUrl);
      const initialIndex = items.findIndex((item) => stableImageUrl(item?.image) === targetImage);
      return { target, targetImage, initialIndex };
    });

    // CRITICAL: Sort descending by initial index so higher-index popups are deleted first.
    // Deleting higher-index items first guarantees that lower-index items do NOT shift!
    targetsWithIndices.sort((a, b) => b.initialIndex - a.initialIndex);

    for (const { target, targetImage } of targetsWithIndices) {
      // Re-ensure the popup settings drawer is open and ready before EACH deletion
      await openPopupSettings(page, sectionId);
      await waitForPopupListItemsPanel(page, 4000).catch(() => {});

      // Re-read fresh items before each deletion to reflect exact current state
      let fresh = await readPopupListItems(page).catch(() => ({ items: [] }));
      if (fresh.items.length === 0) {
        await page.waitForTimeout(300);
        await openPopupSettings(page, sectionId);
        fresh = await readPopupListItems(page).catch(() => ({ items: [] }));
      }
      items = fresh.items;
      let currentIndex = items.findIndex((item) => stableImageUrl(item?.image) === targetImage);
      const remainingCount = items.length > 0 ? items.length - 1 : Math.max(0, targetsWithIndices.length - 1 - totalRemoved);
      await deletePopupItemAtIndex(
        page,
        currentIndex >= 0 ? currentIndex : 0,
        remainingCount,
        `Gemini-matched popup item #${target.visionIndex}`,
        target.sourceImageUrl
      );
      totalRemoved += 1;
      await page.waitForTimeout(300);
      ({ items } = await readPopupListItems(page).catch(() => ({ items: [] })));
    }
    await returnToPageEditor(page);
  }
  return {
    sectionId: targets[0]?.sectionId || null,
    itemIndex: targets[0]?.visionIndex ? targets[0].visionIndex - 1 : 0,
    imageUrl: targets[0]?.sourceImageUrl || null,
    removedCount: totalRemoved,
    changed: totalRemoved > 0
  };
}

async function removePopupForTicket(page, baseUrl, runDir, ticketText, action, referenceImage) {
  if (action === 'remove-all') {
    progress('popup-removal-all', 'Removing every current popup item requested by the ticket');
    return { scope: 'all', ...(await removeAllPopupItems(page, baseUrl)), vision: null };
  }
  if (action !== 'remove-one') {
    const error = new Error('A popup removal ticket requires remove-one or remove-all.');
    error.stage = 'popup-removal-ambiguous';
    throw error;
  }
  progress('popup-removal-scan', 'Downloading current CMS popup images for Gemini Vision inspection');
  const available = await collectPopupRemovalCandidates(page, baseUrl, runDir);
  if (!available.items.length) {
    const error = new Error('No configured CMS popup image exists that matches the ticket removal request. Nothing was removed and CMS Build was not started.');
    error.stage = 'popup-removal-not-found';
    throw error;
  }
  const prepared = preparePopupRemovalVision(referenceImage, available.items);
  if (!prepared.candidates.length || prepared.complete !== true || prepared.candidates.length !== available.items.length) {
    const error = new Error(prepared.warnings.join(' ') || 'CMS popup images could not be prepared for Gemini Vision comparison.');
    error.stage = 'popup-removal-ambiguous';
    throw error;
  }
  progress('popup-removal-vision', referenceImage
    ? 'Gemini Vision is matching the ticket image to the current CMS popup'
    : 'Gemini Vision đang đọc nội dung các popup trên CMS để xác định popup thông báo cần gỡ');
  const resolution = await resolveTicketPopupRemovalVision(ticketText, prepared.reference, prepared.candidates);
  if (!resolution.selection) {
    const notFound = resolution.audit?.status === 'not-found';
    const auditWarning = resolution.audit?.warnings?.join(' ') || '';
    const error = new Error(notFound
      ? 'No current CMS popup matches the ticket request. No popup was removed and CMS Build was not started.'
      : (auditWarning ? `The tool could not identify CMS popups matching the ticket request (${auditWarning}). No popup was removed and CMS Build was not started.` : 'The tool could not identify CMS popups matching the ticket request. No popup was removed and CMS Build was not started.'));
    error.stage = notFound ? 'popup-removal-not-found' : 'popup-removal-ambiguous';
    error.vision = resolution.audit;
    throw error;
  }
  const targetIndices = Array.isArray(resolution.selection.indices) && resolution.selection.indices.length > 0
    ? resolution.selection.indices
    : [resolution.selection.index];
  const targets = targetIndices
    .map((idx) => available.items.find((item) => item.visionIndex === idx))
    .filter(Boolean);
  if (!targets.length) {
    const error = new Error('Gemini Vision selected CMS popups that were not in the local candidate set. No popup was removed.');
    error.stage = 'popup-removal-ambiguous';
    throw error;
  }
  progress('popup-removal-apply', `Đang gỡ ${targets.length} popup được Gemini Vision xác nhận: ${targets.map((t) => '#' + t.visionIndex).join(', ')}`);
  const removal = await removeMatchingPopupItems(page, baseUrl, targets);
  return {
    scope: targets.length > 1 ? 'multiple' : 'one',
    ...removal,
    vision: resolution.audit,
    visionRationale: resolution.selection.rationale,
    warnings: prepared.warnings
  };
}

async function configurePopup(page, imagePath, schedule, timezone, {
  replaceExisting = false,
  sectionId = null,
  legacyPopups = [],
  repairOnly = false,
  ticketFilename = null,
  ticketEntries = null,
  popupPosition = null,
  duplicateMatches = [],
  removalMatches = [],
  imageLink = null,
  popupDuration = null
} = {}) {
  await ensureDesktopViewport(page);
  await openPopupSection(page, sectionId);
  const timezoneControl = await setPopupTimezone(page, timezone);
  await openPopupSettings(page, sectionId);
  if (repairOnly) {
    const repaired = await repairExistingPopupSettings(page, schedule, timezone);
    return { ...repaired, timezoneControl };
  }
  const normalizedTicketEntries = normalizeTicketPopupEntries(ticketEntries, imagePath, schedule, ticketFilename);
  const before = await readPopupListItems(page);
  let duplicateTargetIndex = -1;
  let duplicateMatch = null;
  if (duplicateMatches.length > 0) {
    duplicateMatch = duplicateMatches[0];
    if (duplicateMatch?.cms?.sourceImageUrl) {
      const targetUrl = stableImageUrl(duplicateMatch.cms.sourceImageUrl);
      const matches = before.items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => stableImageUrl(item.image) === targetUrl);
      if (matches.length > 0) {
        const configuredMatch = matches.find(({ item }) => item.time_end);
        duplicateTargetIndex = configuredMatch ? configuredMatch.idx : matches[0].idx;
      }
    }
    if (duplicateTargetIndex < 0 && legacyPopups.length === 0 && Number.isInteger(duplicateMatch?.cmsIndex) && before.items[duplicateMatch.cmsIndex]) {
      duplicateTargetIndex = duplicateMatch.cmsIndex;
    }
  }

  // A replace ticket must be idempotent: it may update one existing configured
  // card, but it must never fall through to the create/placeholder path. Empty
  // cards left by older failed runs do not make the replacement target ambiguous.
  if (replaceExisting && legacyPopups.length === 0 && duplicateTargetIndex < 0) {
    const configuredIndexes = before.items
      .map((item, index) => (!isEmptyPopupItem(item) ? index : -1))
      .filter((index) => index >= 0);
    if (configuredIndexes.length === 1) {
      duplicateTargetIndex = configuredIndexes[0];
      duplicateMatch = {
        ticketIndex: normalizedTicketEntries[0]?.ticketIndex ?? 0,
        cmsIndex: duplicateTargetIndex,
        cms: { sourceImageUrl: before.items[duplicateTargetIndex]?.image || null },
        method: 'sole-configured-replacement-target'
      };
    } else if (removalMatches.length === 1 && Number.isInteger(removalMatches[0]?.cmsIndex)) {
      duplicateTargetIndex = removalMatches[0].cmsIndex;
      duplicateMatch = {
        ticketIndex: normalizedTicketEntries[0]?.ticketIndex ?? 0,
        cmsIndex: duplicateTargetIndex,
        cms: { sourceImageUrl: before.items[duplicateTargetIndex]?.image || null },
        method: 'removal-match-replacement-target'
      };
      removalMatches = [];
    } else {
      const error = new Error(
        `Replacement target is ambiguous (${configuredIndexes.length} configured popup cards). `
        + 'Add block and placeholder reuse were not allowed.'
      );
      error.stage = 'popup-item-target';
      error.popupItems = popupItemsForReport(before.items, timezone);
      throw error;
    }
  }

  // Mixed add+remove or replacement: when a specific old popup is targeted for removal
  // and there is 1 new ticket poster, replace that exact card in-place to preserve its position completely.
  if (duplicateTargetIndex < 0 && legacyPopups.length === 0 && removalMatches.length === 1 && normalizedTicketEntries.length === 1) {
    const targetIdx = removalMatches[0].cmsIndex;
    if (Number.isInteger(targetIdx) && targetIdx >= 0 && targetIdx < before.items.length) {
      duplicateTargetIndex = targetIdx;
      duplicateMatch = {
        ticketIndex: normalizedTicketEntries[0]?.ticketIndex ?? 0,
        cmsIndex: targetIdx,
        cms: { sourceImageUrl: before.items[targetIdx]?.image || null },
        method: 'removal-match-in-place-replacement'
      };
      removalMatches = [];
    }
  }

  const shouldRemoveSingle = replaceExisting && duplicateMatches.length === 0 && before.items.length === 1;
  const replacement = shouldRemoveSingle ? await removeSingleExistingPopup(page) : { removed: false, previous: null };
  // Default popup position: ticket poster should ALWAYS be at the first position
  // unless the ticket explicitly requested another position (such as 'last').
  const effectivePosition = popupPosition === 'last' ? 'last' : 'first';
  const { entries, matchingLegacyIndex, matchingLegacyIndexes } = buildPopupEntriesForTickets(
    normalizedTicketEntries,
    legacyPopups,
    duplicateMatches,
    { replaceExisting, popupPosition: effectivePosition, replacementMatches: removalMatches }
  );
  const emptyItemsBefore = before.items.filter(isEmptyPopupItem);
  const configuredItemsBefore = before.items.filter((item) => !isEmptyPopupItem(item));
  const hasReusablePlaceholder = emptyItemsBefore.length > 0;
  const ticketItems = new Map();
  const configuredEntryItems = new Map();
  let lastConfiguredItem = null;

  if (legacyPopups.length === 0 && duplicateTargetIndex >= 0 && duplicateMatch) {
    const targetItem = before.items[duplicateTargetIndex];
    const ticketEntry = normalizedTicketEntries.find((t) => t.ticketIndex === duplicateMatch.ticketIndex) || normalizedTicketEntries[0];
    const isIndefinite = Boolean(ticketEntry?.schedule?.isIndefinite);
    const targetSchedule = isIndefinite
      ? { start: null, end: null, isIndefinite: true }
      : {
          start: ticketEntry?.schedule?.start || (targetItem?.time_start ? { date: popupDateFromCmsValue(targetItem.time_start, timezone) } : null),
          end: ticketEntry?.schedule?.end || (targetItem?.time_end ? { date: popupDateFromCmsValue(targetItem.time_end, timezone) } : null)
        };
    if (ticketEntry) ticketEntry.schedule = targetSchedule;
    progress('popup-replace', isIndefinite
      ? `Thay thế poster vào block hiện có tại vị trí #${duplicateTargetIndex + 1} (xóa lịch cũ, hiển thị ngay đến khi khách tắt)`
      : `Thay thế poster vào block hiện có tại vị trí #${duplicateTargetIndex + 1} (giữ nguyên lịch hiển thị cũ nếu ticket không đổi)`
    );
    const configured = await configurePopupListItem(
      page,
      ticketEntry.uploadPath || ticketEntry.path || ticketEntry.imagePath,
      targetSchedule,
      timezone,
      {
        replaceTargetIndex: duplicateTargetIndex,
        replaceTargetImageUrl: targetItem?.image || duplicateMatch.cms?.sourceImageUrl || null,
        isReplacement: true,
        allowAddBlock: false,
        imageLink: imageLink || null
      }
    );
    await backToPopupSettings(page);
    const item = await waitForPersistedPopupItem(page, configured, targetSchedule, timezone);
    lastConfiguredItem = item;
    for (const ticketIndex of [ticketEntry.ticketIndex]) ticketItems.set(ticketIndex, item);

    try {
      let { items: afterItems } = await readPopupListItems(page);
      const keptUrl = stableImageUrl(item.imageUrl);
      const ticketIdentity = popupImageIdentity(item.imageUrl || duplicateMatch.cms?.sourceImageUrl || '');
      while (true) {
        const duplicateIndex = afterItems.findIndex((candidate) => {
          const candidateUrl = stableImageUrl(candidate?.image);
          if (!candidateUrl || candidateUrl === keptUrl) return false;
          const sameIdentity = ticketIdentity && popupImageIdentity(candidate?.image) === ticketIdentity;
          return sameIdentity && !String(candidate?.time_end || '').trim();
        });
        if (duplicateIndex < 0) break;
        progress('popup-cleanup', `Xóa block ảnh trùng lặp chưa cấu hình (Not configured) tại vị trí #${duplicateIndex + 1}`);
        await deletePopupItemAtIndex(page, duplicateIndex, afterItems.length - 1, 'Unconfigured duplicate popup item');
        ({ items: afterItems } = await readPopupListItems(page));
      }
    } catch {
      // Non-blocking cleanup
    }
  } else {
    const effectiveMaxAllowedBlocks = legacyPopups.length > 0
      ? entries.length
      : (configuredItemsBefore.length + entries.length);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const configured = await configurePopupListItem(page, entry.imagePath, entry.schedule, timezone, {
        forceNewBlock: false,
        imageLink: entry.isTicket !== false ? (imageLink || null) : (entry.imageLink || null),
        maxAllowedBlocks: effectiveMaxAllowedBlocks,
        itemIndex: index
      });
      await backToPopupSettings(page);
      const item = await waitForPersistedPopupItem(page, configured, entry.schedule, timezone);
      lastConfiguredItem = item;
      configuredEntryItems.set(index, item);
      for (const ticketIndex of entry.ticketIndexes || []) {
        ticketItems.set(ticketIndex, item);
        const ticketEntry = normalizedTicketEntries.find((t) => t.ticketIndex === ticketIndex);
        if (ticketEntry && entry.schedule) ticketEntry.schedule = entry.schedule;
      }
    }
  }

  // After all new ticket posters are added and configured, remove any existing
  // popup poster that the ticket explicitly requested to remove.
  // Adding new images first prevents CMS from duplicating the old deleted image into new blocks.
  let itemsRemovedAfterAdd = 0;
  if (Array.isArray(removalMatches) && removalMatches.length > 0) {
    let { items: currentList } = await readPopupListItems(page);
    const processedUrls = new Set();
    const newlyUploadedUrls = new Set(
      Array.from(ticketItems.values())
        .map((item) => stableImageUrl(item?.imageUrl))
        .filter(Boolean)
    );

    for (const match of removalMatches) {
      const targetUrl = match?.cmsItem?.sourceImageUrl ? stableImageUrl(match.cmsItem.sourceImageUrl) : null;
      if (targetUrl && (processedUrls.has(targetUrl) || newlyUploadedUrls.has(targetUrl))) continue;
      let targetIndex = -1;
      if (targetUrl) {
        targetIndex = currentList.findIndex((item) => {
          const itemUrl = stableImageUrl(item?.image);
          return itemUrl === targetUrl && !newlyUploadedUrls.has(itemUrl);
        });
      } else if (Number.isInteger(match?.cmsIndex) && match.cmsIndex >= 0 && match.cmsIndex < currentList.length) {
        const itemUrl = stableImageUrl(currentList[match.cmsIndex]?.image);
        if (!newlyUploadedUrls.has(itemUrl)) {
          targetIndex = match.cmsIndex;
        }
      }
      if (targetIndex >= 0 && targetIndex < currentList.length) {
        if (targetUrl) processedUrls.add(targetUrl);
        progress('popup-item-removal', `Gỡ bỏ popup cũ #${targetIndex + 1} (${currentList[targetIndex]?.image || 'popup'}) theo yêu cầu của ticket`);
        try {
          await deletePopupItemAtIndex(page, targetIndex, currentList.length - 1, 'Ticket-requested removal popup');
          itemsRemovedAfterAdd += 1;
          const updated = await readPopupListItems(page);
          currentList = updated.items;
        } catch (err) {
          progress('popup-item-removal-warning', `Không thể gỡ popup #${targetIndex + 1}: ${err.message}`);
        }
      }
    }
  }

  // After all planned entries are configured and removals are processed,
  // clean up any remaining empty / unconfigured popup items (Not configured).
  // These occur when CMS adds an initial default blank item or when earlier runs were interrupted.
  try {
    let { items: currentList } = await readPopupListItems(page);
    while (true) {
      const emptyIndex = currentList.findIndex(isEmptyPopupItem);
      if (emptyIndex < 0) break;
      progress('popup-cleanup', `Xóa block trống chưa cấu hình (Not configured) tại vị trí #${emptyIndex + 1}`);
      await deletePopupItemAtIndex(page, emptyIndex, currentList.length - 1, 'Empty unconfigured popup item');
      const updated = await readPopupListItems(page);
      currentList = updated.items;
    }
  } catch (err) {
    progress('popup-cleanup-warning', `Không thể tự động xóa block trống: ${err.message}`);
  }

  let positionResult = { applied: false, moved: false };
  if (legacyPopups.length > 0) {
    const originalOrderUrls = entries.map((_, index) => configuredEntryItems.get(index)?.imageUrl || null);
    if (originalOrderUrls.some((url) => !url)) {
      const error = new Error('A migrated popup item could not be resolved for order verification. CMS Build was not started.');
      error.stage = 'popup-position-verification';
      throw error;
    }
    progress('popup-position', 'Sắp xếp thứ tự popup: popup mới ở vị trí đầu tiên, các popup cũ giữ nguyên thứ tự');
    positionResult = await restoreMigratedPopupOrder(page, originalOrderUrls);
  } else if (ticketItems.size > 0 && configuredItemsBefore.length > 0) {
    const ticketImageUrls = normalizedTicketEntries
      .map((ticket) => ticketItems.get(ticket.ticketIndex)?.imageUrl || null)
      .filter(Boolean);
    if (ticketImageUrls.length > 0) {
      progress('popup-position', `Sắp xếp poster ticket theo vị trí ${effectivePosition}`);
      positionResult = await movePopupImagesToPosition(page, ticketImageUrls, effectivePosition);
    }
  }
  const after = await readPopupListItems(page);
  // The last exact target is the authoritative count.  This also handles a
  // replacement ticket, where the original single popup was intentionally
  // removed before adding the new one.
  const expectedConfiguredCount = legacyPopups.length > 0
    ? entries.length
    : (duplicateTargetIndex >= 0
        ? Math.max(1, configuredItemsBefore.length)
        : Math.max(1, configuredItemsBefore.length + entries.length - itemsRemovedAfterAdd)
      );
  const expectedItemCount = expectedConfiguredCount;
  const configuredItems = after.items.filter((item) => typeof item?.image === 'string' && item.image.trim());
  const emptyItems = after.items.filter(isEmptyPopupItem);
  const verifiedTicketItems = normalizedTicketEntries.map((ticket) => {
    const configured = ticketItems.get(ticket.ticketIndex) || null;
    const resolved = resolvePopupItemByImageAndSchedule(
      after.items,
      configured?.imageUrl,
      ticket.schedule,
      timezone
    );
    const target = resolved.item;
    const imageUrl = target?.image || null;
    return {
      ticketIndex: ticket.ticketIndex,
      attachmentIndex: ticket.candidateIndex || null,
      imageUrl,
      start: configured?.start || null,
      end: configured?.end || null
    };
  });
  const ticketCmsImageUrls = verifiedTicketItems.map((item) => item.imageUrl).filter(Boolean);
  const normalizedTicketUrls = ticketCmsImageUrls.map(stableImageUrl);
  const ticketUrlCounts = new Map();
  for (const item of after.items) {
    const url = stableImageUrl(item?.image);
    if (url) ticketUrlCounts.set(url, (ticketUrlCounts.get(url) || 0) + 1);
  }
  const ticketImagesVerifiedOnce = normalizedTicketUrls.length === normalizedTicketEntries.length
    && new Set(normalizedTicketUrls).size === normalizedTicketEntries.length
    && normalizedTicketUrls.every((url) => ticketUrlCounts.get(url) === 1);
  // Build is prohibited unless every planned entry exists and the ticket
  // poster occupies its own verified CMS item. This catches a Vue re-render
  // that opened the migrated legacy row instead of the blank ticket row.
  if (after.items.length !== expectedItemCount
    || configuredItems.length !== expectedItemCount
    || emptyItems.length > 0
    || !ticketImagesVerifiedOnce) {
    const error = new Error(
      `Ticket poster was not verified in Popup settings (expected ${expectedItemCount} configured item${expectedItemCount === 1 ? '' : 's'}, found ${configuredItems.length}; empty: ${emptyItems.length}). CMS Build was not started.`
    );
    error.stage = 'popup-ticket-verification';
    error.popupItems = popupItemsForReport(after.items, timezone);
    throw error;
  }
  let delaySliderResult = null;
  if (popupDuration?.delaySliderSeconds) {
    progress('popup-delay-slider', `Cài đặt Time delay slider: ${popupDuration.delaySliderSeconds}s (thời gian yêu cầu ${popupDuration.requestedSeconds}s + 3s thời gian mở popup)`);
    try {
      delaySliderResult = await setTimeDelaySlider(page, popupDuration.delaySliderSeconds);
      if (delaySliderResult.applied !== true) {
        const error = new Error(`Time delay slider was not verified at ${popupDuration.delaySliderSeconds}s (reported value: ${delaySliderResult.value || 'empty'}). CMS Build was not started.`);
        error.stage = 'popup-delay-slider-verification';
        throw error;
      }
      progress('popup-delay-slider-applied', `Đã cài Time delay slider = ${delaySliderResult.value}s`, { delaySliderResult });
    } catch (err) {
      err.stage ||= 'popup-delay-slider-verification';
      throw err;
    }
  }
  return {
    imageConfigured: true,
    ticketPosterVerified: true,
    start: verifiedTicketItems[0]?.start || null,
    end: verifiedTicketItems[0]?.end || null,
    ticketItems: verifiedTicketItems,
    replacement,
    migratedCount: entries.filter((entry) => entry.isTicket === false).length,
    ticketMergedWithLegacy: matchingLegacyIndexes.length > 0 || matchingLegacyIndex >= 0,
    deduplicated: false,
    deduplicationMethod: null,
    cmsImageUrl: ticketCmsImageUrls[0] || null,
    cmsImageUrls: ticketCmsImageUrls,
    ticketPosterCount: normalizedTicketEntries.length,
    popupPosition: positionResult.applied ? effectivePosition : null,
    positionMoved: positionResult.moved,
    link: imageLink || null,
    delaySlider: delaySliderResult,
    delaySliderSeconds: popupDuration?.delaySliderSeconds || null,
    timezoneControl
  };
}

async function websiteInfo(page, baseUrl) {
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const toUrl = (raw) => {
      try { return new URL(raw).href; } catch { return null; }
    };
    const urls = [
      ...[...document.querySelectorAll('a[href]')].map((link) => link.href),
      ...[...document.querySelectorAll('[aria-label^="Open "]')].map((element) => {
        const match = /^Open\s+(.+?)\s+in a new tab$/i.exec(element.getAttribute('aria-label') || '');
        return match ? `https://${match[1].replace(/^https?:\/\//, '')}` : null;
      })
    ].map(toUrl).filter(Boolean);
    const external = [...new Set(urls)].filter((url) => {
      const host = new URL(url).hostname;
      return host !== 'apps.newzensite.com';
    });
    const previewUrl = external.find((url) => /\.newzensite\.online$/i.test(new URL(url).hostname)) || null;
    const liveUrl = external.find((url) => !/\.newzensite\.online$/i.test(new URL(url).hostname)) || previewUrl;
    return { liveUrl, previewUrl };
  });
}

class BuildWorkflowError extends Error {
  constructor(message) {
    super(message);
    this.status = 'build-failed';
  }
}

function readBuildState(text, baseline = '') {
  const current = String(text || '').replace(/\s+/g, ' ').trim();
  const before = String(baseline || '').replace(/\s+/g, ' ').trim();
  const values = [...current.matchAll(/\b(\d{1,3})\s*%/g)].map((match) => Number(match[1])).filter((value) => value >= 0 && value <= 100);
  const highestPercent = values.length ? Math.max(...values) : null;
  const isActivelyBuilding = (highestPercent === null || highestPercent < 100) && /\b(?:building|deploying|publishing|(?:dang|đang)\s*build)\b/i.test(current);
  const successMatch = current.match(/\b(?:build|publish|deploy|(?:xuat|xuất)\s*(?:ban|bản))\s*(?:is\s*)?(?:success(?:ful(?:ly)?)?|completed|complete|finished|(?:thanh|thành)\s*(?:cong|công))\b|\b(?:success(?:ful(?:ly)?)?|completed|complete|(?:thanh|thành)\s*(?:cong|công))\s*(?:build|publish|deploy|(?:xuat|xuất)\s*(?:ban|bản))\b/i)?.[0] || null;
  const failure = current.match(/(?:build|publish|deploy).{0,100}(?:failed|failure|error|cancelled|canceled)|(?:failed|failure|error|cancelled|canceled).{0,100}(?:build|publish|deploy)|(?:build|(?:xuat|xuất)\s*(?:ban|bản)).{0,100}(?:(?:loi|lỗi)|(?:that|thất)\s*(?:bai|bại))|(?:(?:loi|lỗi)|(?:that|thất)\s*(?:bai|bại)).{0,100}(?:build|(?:xuat|xuất)\s*(?:ban|bản))/i)?.[0] || null;
  return {
    percent: highestPercent,
    isActivelyBuilding,
    success: (!isActivelyBuilding && successMatch && !before.toLowerCase().includes(successMatch.toLowerCase())) ? successMatch : null,
    failure: failure && !before.toLowerCase().includes(failure.toLowerCase()) ? failure : null
  };
}

async function readCmsBuildStatus(page, projectId) {
  if (!projectId) return { ok: false, statusBuild: null, logIdLast: null, projectStatus: null, domain: null, name: null };
  try {
    // Use the already-authenticated CMS page to ask its authoritative project
    // endpoint. The token stays inside the browser context and is never logged.
    return await page.evaluate(async (id) => {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
      const session = sessionResponse.ok ? await sessionResponse.json() : null;
      const token = session?.user?.token || null;
      const response = await fetch(
        `https://api.newzensite.online/api/v1/web_portal/project/site/view?id=${encodeURIComponent(id)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      const payload = await response.json().catch(() => null);
      const project = payload?.data?.project || payload?.project || null;
      return {
        ok: response.ok && project !== null,
        statusBuild: project?.status_build ?? null,
        logIdLast: project?.log_id_last ?? project?.logIdLast ?? null,
        projectStatus: project?.status ?? project?.status_text ?? null,
        domain: project?.domain || project?.custom_domain || null,
        name: project?.name || null
      };
    }, projectId);
  } catch {
    return { ok: false, statusBuild: null, logIdLast: null, projectStatus: null, domain: null, name: null };
  }
}

async function verifyFinalCmsStatus(page, baseUrl, projectId, fallbackDomain = null, progress = () => {}) {
  progress('cms-status-check', 'Đang kiểm tra trạng thái cuối cùng của CMS...');
  let cmsBuild = await readCmsBuildStatus(page, projectId);
  // If CMS build is still in progress (statusBuild = 0), wait briefly for it to settle
  if (cmsBuild.ok && Number(cmsBuild.statusBuild) === 0) {
    const settleDeadline = Date.now() + 30000;
    while (Date.now() < settleDeadline) {
      await page.waitForTimeout(2000);
      cmsBuild = await readCmsBuildStatus(page, projectId);
      if (Number(cmsBuild.statusBuild) !== 0) break;
    }
  }

  const website = await websiteInfo(page, baseUrl);
  const rawLiveUrl = website.liveUrl
    || (cmsBuild.domain ? `https://${cmsBuild.domain.replace(/^https?:\/\//, '')}` : null)
    || (fallbackDomain ? `https://${fallbackDomain.replace(/^https?:\/\//, '')}` : null);
  const liveUrl = rawLiveUrl ? rawLiveUrl.replace(/\/+$/, '') : null;
  const previewUrl = website.previewUrl ? website.previewUrl.replace(/\/+$/, '') : null;

  let httpStatus = null;
  let websiteHealthy = false;
  const targetProbe = liveUrl || previewUrl;
  if (targetProbe) {
    try {
      const probeResponse = await page.request.get(targetProbe, { timeout: 10000, ignoreHTTPSErrors: true }).catch(() => null);
      if (probeResponse) {
        httpStatus = probeResponse.status();
        websiteHealthy = httpStatus >= 200 && httpStatus < 400;
      }
    } catch {}
  }

  const statusBuildNum = Number.isFinite(Number(cmsBuild.statusBuild)) ? Number(cmsBuild.statusBuild) : null;
  const statusBuildLabel = statusBuildNum === 1
    ? 'COMPLETE (Thành công)'
    : (statusBuildNum === 0 ? 'PROCESSING (Đang chạy)' : (statusBuildNum === 2 ? 'ERROR (Lỗi)' : 'Chưa xác nhận'));

  const projectStatusLabel = cmsBuild.projectStatus !== null && cmsBuild.projectStatus !== undefined
    ? String(cmsBuild.projectStatus)
    : 'Active';

  const parts = [`Build: ${statusBuildLabel}`, `Project: ${projectStatusLabel}`];
  if (httpStatus) {
    parts.push(`Website: HTTP ${httpStatus} ${websiteHealthy ? 'OK' : 'Error'}`);
  } else if (liveUrl || previewUrl) {
    parts.push(`Website: ${liveUrl || previewUrl}`);
  }
  const summary = parts.join(' · ');

  return {
    ok: statusBuildNum === 1 || websiteHealthy,
    statusBuild: statusBuildNum,
    statusBuildLabel,
    projectStatus: projectStatusLabel,
    projectName: cmsBuild.name || null,
    domain: cmsBuild.domain || fallbackDomain || null,
    liveUrl,
    previewUrl,
    httpStatus,
    websiteHealthy,
    summary,
    verifiedAt: new Date().toISOString()
  };
}

async function buildWebsite(page, baseUrl, { fallbackDomain = null, progress = () => {} } = {}) {
  const projectId = baseUrl.match(/\/projects\/(\d+)/)?.[1] || null;
  const buildControl = page.locator('button').filter({ hasText: /^Build(?:\.\.\.|\b)/i })
    .or(page.getByRole('button', { name: /^Build(?:\.\.\.|\b)/i }))
    .or(page.locator('button:has-text("Build")'));
  // The editor has the global Build action in its upper-right corner. Use it
  // without leaving the popup editor so the just-uploaded item stays in the
  // current CMS editing state. Older CMS layouts expose it only on Dashboard.
  let buildButton = await visibleMatch(buildControl, null, true);
  if (!buildButton) {
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    buildButton = await visibleMatch(buildControl, 'CMS Build control', true);
  }
  const beforeBuild = await page.locator('body').innerText();
  const baseline = readBuildState(beforeBuild);
  const initialCmsBuild = await readCmsBuildStatus(page, projectId);
  const initialLogId = initialCmsBuild.logIdLast === null || initialCmsBuild.logIdLast === undefined
    ? null
    : String(initialCmsBuild.logIdLast);
  // Reset any horizontal scroll before triggering Build
  await page.evaluate(() => {
    try {
      window.scrollTo({ left: 0 });
      if (document.documentElement) document.documentElement.scrollLeft = 0;
      if (document.body) document.body.scrollLeft = 0;
    } catch {}
  }).catch(() => {});

  progress('build-start', 'Đang click nút Build website');
  await buildButton.click({ force: true });

  // NewZen may present confirmation dialogs after clicking Build:
  // Step 1: "Save all" or "Save changes" commits pending editor changes.
  // Step 2: "Confirm build" or "Confirm" queues the build.
  // We wait up to 5000ms for each dialog step so animations can render.
  const saveControl = page.getByRole('button', { name: /^Save\s*(?:all)?(?:\s*changes)?$/i })
    .or(page.locator('button:has-text("Save all"), button:has-text("Save changes")'));
  const saveBtn = await waitForVisibleMatch(saveControl, null, true, 5000).catch(() => null);
  if (saveBtn) {
    progress('build-save-all', 'Đang Save all thay đổi trước khi Build');
    await saveBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
  }

  const confirmControl = page.getByRole('button', { name: /^Confirm(?:\s*build)?$/i })
    .or(page.locator('button:has-text("Confirm")'));
  const confirmBtn = await waitForVisibleMatch(confirmControl, null, true, 5000).catch(() => null);
  if (confirmBtn) {
    progress('build-confirm', 'Đang xác nhận Build');
    await confirmBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
  }

  progress('build-wait', 'CMS đang chạy Build');
  let highest = baseline.percent ?? -1;
  let sawBuildProgress = false;
  let sawCmsProcessing = false;
  let sawNewCmsLog = false;
  let lastCmsStatus = null;
  let lastCmsCheckAt = 0;
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    const state = readBuildState(await page.locator('body').innerText(), beforeBuild);
    if (state.percent !== null && state.percent > highest) {
      highest = state.percent;
      sawBuildProgress = true;
      progress('build-progress', `CMS đang Build: ${highest}%`, { percent: highest });
    }
    if (state.failure) throw new BuildWorkflowError(`CMS Build thất bại: ${state.failure}`);
    if (Date.now() - lastCmsCheckAt >= 1000) {
      lastCmsCheckAt = Date.now();
      const cmsBuild = await readCmsBuildStatus(page, projectId);
      const statusBuild = Number(cmsBuild.statusBuild);
      if (cmsBuild.ok && cmsBuild.statusBuild !== null && cmsBuild.statusBuild !== undefined && Number.isFinite(statusBuild)) {
        const currentLogId = cmsBuild.logIdLast === null || cmsBuild.logIdLast === undefined
          ? null
          : String(cmsBuild.logIdLast);
        if (initialLogId !== null && currentLogId !== null && currentLogId !== initialLogId) sawNewCmsLog = true;
        // NewZen's authoritative enum is PROCESSING=0, COMPLETE=1, ERROR=2.
        if (statusBuild !== lastCmsStatus) {
          lastCmsStatus = statusBuild;
          if (statusBuild === 0) progress('build-status', 'CMS xác nhận Build đang chạy');
        }
        if (statusBuild === 0) sawCmsProcessing = true;
        if (statusBuild === 2 && (sawCmsProcessing || sawBuildProgress)) {
          throw new BuildWorkflowError('CMS Build thất bại theo trạng thái dự án.');
        }
        if (statusBuild === 1 && (sawCmsProcessing || sawNewCmsLog || (sawBuildProgress && highest >= 100))) {
          const cmsStatus = await verifyFinalCmsStatus(page, baseUrl, projectId, fallbackDomain, progress);
          progress('cms-status-verified', `Xác nhận trạng thái CMS: ${cmsStatus.summary}`, cmsStatus);
          return {
            status: cmsStatus.statusBuild === 2 ? 'failed' : (cmsStatus.ok ? 'success' : 'unconfirmed'),
            website: {
              liveUrl: cmsStatus.liveUrl,
              previewUrl: cmsStatus.previewUrl
            },
            cmsStatus,
            evidence: `Trạng thái CMS: ${cmsStatus.summary}`,
            completedAt: new Date().toISOString(),
            progress: highest >= 0 ? highest : null
          };
        }
      }
    }
    // CMS versions differ: some leave the progress number below 100 but show
    // a success message, while others reach 100 without a separate message.
    // Either newly-observed completion signal is sufficient after Build began.
    const completed = Boolean(state.success) || (sawBuildProgress && highest >= 100);
    if (completed) {
      const cmsStatus = await verifyFinalCmsStatus(page, baseUrl, projectId, fallbackDomain, progress);
      progress('cms-status-verified', `Xác nhận trạng thái CMS: ${cmsStatus.summary}`, cmsStatus);
      return {
        status: cmsStatus.statusBuild === 2 ? 'failed' : (cmsStatus.ok ? 'success' : 'unconfirmed'),
        website: {
          liveUrl: cmsStatus.liveUrl,
          previewUrl: cmsStatus.previewUrl
        },
        cmsStatus,
        evidence: `Trạng thái CMS: ${cmsStatus.summary}`,
        completedAt: new Date().toISOString(),
        progress: highest
      };
    }
    await page.waitForTimeout(1000);
  }
  const cmsStatus = await verifyFinalCmsStatus(page, baseUrl, projectId, fallbackDomain, progress);
  return {
    status: cmsStatus.statusBuild === 1 ? 'success' : 'unconfirmed',
    website: {
      liveUrl: cmsStatus.liveUrl,
      previewUrl: cmsStatus.previewUrl
    },
    cmsStatus,
    evidence: `Trạng thái CMS: ${cmsStatus.summary}`,
    completedAt: cmsStatus.statusBuild === 1 ? new Date().toISOString() : null,
    progress: highest >= 0 ? highest : null
  };
}

const US_TIMEZONE_BY_STATE = {
  AL: ['America/Chicago', 'Chicago (UTC-06:00)'], AK: ['America/Anchorage', 'Anchorage (UTC-09:00)'],
  AZ: ['America/Phoenix', 'Phoenix (UTC-07:00)'], AR: ['America/Chicago', 'Chicago (UTC-06:00)'],
  CA: ['America/Los_Angeles', 'Los Angeles (UTC-08:00)'], CO: ['America/Denver', 'Denver (UTC-07:00)'],
  CT: ['America/New_York', 'New York (UTC-05:00)'], DE: ['America/New_York', 'New York (UTC-05:00)'],
  DC: ['America/New_York', 'New York (UTC-05:00)'], FL: ['America/New_York', 'New York (UTC-05:00)'],
  GA: ['America/New_York', 'New York (UTC-05:00)'], HI: ['Pacific/Honolulu', 'Honolulu (UTC-10:00)'],
  IA: ['America/Chicago', 'Chicago (UTC-06:00)'], ID: ['America/Denver', 'Denver (UTC-07:00)'],
  IL: ['America/Chicago', 'Chicago (UTC-06:00)'], IN: ['America/New_York', 'New York (UTC-05:00)'],
  KS: ['America/Chicago', 'Chicago (UTC-06:00)'], KY: ['America/New_York', 'New York (UTC-05:00)'],
  LA: ['America/Chicago', 'Chicago (UTC-06:00)'], MA: ['America/New_York', 'New York (UTC-05:00)'],
  MD: ['America/New_York', 'New York (UTC-05:00)'], ME: ['America/New_York', 'New York (UTC-05:00)'],
  MI: ['America/New_York', 'New York (UTC-05:00)'], MN: ['America/Chicago', 'Chicago (UTC-06:00)'],
  MO: ['America/Chicago', 'Chicago (UTC-06:00)'], MS: ['America/Chicago', 'Chicago (UTC-06:00)'],
  MT: ['America/Denver', 'Denver (UTC-07:00)'], NC: ['America/New_York', 'New York (UTC-05:00)'],
  ND: ['America/Chicago', 'Chicago (UTC-06:00)'], NE: ['America/Chicago', 'Chicago (UTC-06:00)'],
  NH: ['America/New_York', 'New York (UTC-05:00)'], NJ: ['America/New_York', 'New York (UTC-05:00)'],
  NM: ['America/Denver', 'Denver (UTC-07:00)'], NV: ['America/Los_Angeles', 'Los Angeles (UTC-08:00)'],
  NY: ['America/New_York', 'New York (UTC-05:00)'], OH: ['America/New_York', 'New York (UTC-05:00)'],
  OK: ['America/Chicago', 'Chicago (UTC-06:00)'], OR: ['America/Los_Angeles', 'Los Angeles (UTC-08:00)'],
  PA: ['America/New_York', 'New York (UTC-05:00)'], RI: ['America/New_York', 'New York (UTC-05:00)'],
  SC: ['America/New_York', 'New York (UTC-05:00)'], SD: ['America/Chicago', 'Chicago (UTC-06:00)'],
  TN: ['America/Chicago', 'Chicago (UTC-06:00)'], TX: ['America/Chicago', 'Chicago (UTC-06:00)'],
  UT: ['America/Denver', 'Denver (UTC-07:00)'], VA: ['America/New_York', 'New York (UTC-05:00)'],
  VT: ['America/New_York', 'New York (UTC-05:00)'], WA: ['America/Los_Angeles', 'Los Angeles (UTC-08:00)'],
  WI: ['America/Chicago', 'Chicago (UTC-06:00)'], WV: ['America/New_York', 'New York (UTC-05:00)'],
  WY: ['America/Denver', 'Denver (UTC-07:00)']
};

const CA_TIMEZONE_BY_PROVINCE = {
  ON: ['America/Toronto', 'New York (UTC-05:00)'],
  QC: ['America/Montreal', 'New York (UTC-05:00)'],
  BC: ['America/Vancouver', 'Los Angeles (UTC-08:00)'],
  AB: ['America/Edmonton', 'Denver (UTC-07:00)'],
  MB: ['America/Winnipeg', 'Chicago (UTC-06:00)'],
  SK: ['America/Regina', 'Chicago (UTC-06:00)'],
  NS: ['America/Halifax', 'New York (UTC-05:00)'],
  NB: ['America/Moncton', 'New York (UTC-05:00)'],
  NL: ['America/St_Johns', 'New York (UTC-05:00)'],
  PE: ['America/Halifax', 'New York (UTC-05:00)']
};

const CA_PROVINCE_CODES_BY_NAME = {
  ontario: 'ON', quebec: 'QC', 'british columbia': 'BC', alberta: 'AB',
  manitoba: 'MB', saskatchewan: 'SK', 'nova scotia': 'NS', 'new brunswick': 'NB',
  newfoundland: 'NL', 'prince edward island': 'PE'
};

const US_STATE_CODES_BY_NAME = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC'
};

const DEFAULT_US_TIMEZONE = {
  iana: 'America/New_York',
  cmsLabel: 'New York (UTC-05:00)'
};

function flattenStrings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenStrings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => flattenStrings(item, result));
  return result;
}

function escapePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usStateFromZip(zip) {
  const match = String(zip || '').match(/\b\d{5}\b/);
  if (!match) return null;
  const num = parseInt(match[0], 10);
  if (!num) return null;
  if (num >= 35000 && num <= 36999) return 'AL';
  if (num >= 99500 && num <= 99999) return 'AK';
  if (num >= 85000 && num <= 86599) return 'AZ';
  if (num >= 71600 && num <= 72999) return 'AR';
  if (num >= 90000 && num <= 96199) return 'CA'; // West Sacramento, CA 95605
  if (num >= 80000 && num <= 81699) return 'CO';
  if (num >= 6000 && num <= 6999) return 'CT';
  if (num >= 19700 && num <= 19999) return 'DE';
  if (num >= 20000 && num <= 20599) return 'DC';
  if (num >= 32000 && num <= 34999) return 'FL';
  if (num >= 30000 && num <= 31999) return 'GA';
  if (num >= 96700 && num <= 96899) return 'HI';
  if (num >= 83200 && num <= 83899) return 'ID';
  if (num >= 60000 && num <= 62999) return 'IL';
  if (num >= 46000 && num <= 47999) return 'IN';
  if (num >= 50000 && num <= 52899) return 'IA';
  if (num >= 66000 && num <= 67999) return 'KS';
  if (num >= 40000 && num <= 42799) return 'KY';
  if (num >= 70000 && num <= 71499) return 'LA';
  if (num >= 3900 && num <= 4999) return 'ME';
  if (num >= 20600 && num <= 21999) return 'MD';
  if (num >= 1000 && num <= 2799) return 'MA';
  if (num >= 48000 && num <= 49999) return 'MI';
  if (num >= 55000 && num <= 56799) return 'MN';
  if (num >= 38600 && num <= 39799) return 'MS';
  if (num >= 63000 && num <= 65899) return 'MO';
  if (num >= 59000 && num <= 59999) return 'MT';
  if (num >= 68000 && num <= 69399) return 'NE';
  if (num >= 88900 && num <= 89899) return 'NV';
  if (num >= 3000 && num <= 3899) return 'NH';
  if (num >= 7000 && num <= 8999) return 'NJ';
  if (num >= 87000 && num <= 88499) return 'NM';
  if (num >= 10000 && num <= 14999) return 'NY';
  if (num >= 27000 && num <= 28999) return 'NC';
  if (num >= 58000 && num <= 58899) return 'ND';
  if (num >= 43000 && num <= 45999) return 'OH';
  if (num >= 73000 && num <= 74999) return 'OK';
  if (num >= 97000 && num <= 97999) return 'OR';
  if (num >= 15000 && num <= 19699) return 'PA';
  if (num >= 2800 && num <= 2999) return 'RI';
  if (num >= 29000 && num <= 29999) return 'SC';
  if (num >= 57000 && num <= 57799) return 'SD';
  if (num >= 37000 && num <= 38599) return 'TN';
  if (num >= 75000 && num <= 79999) return 'TX';
  if (num >= 84000 && num <= 84799) return 'UT';
  if (num >= 5000 && num <= 5999) return 'VT';
  if (num >= 22000 && num <= 24699) return 'VA';
  if (num >= 98000 && num <= 99499) return 'WA';
  if (num >= 24700 && num <= 26999) return 'WV';
  if (num >= 53000 && num <= 54999) return 'WI';
  if (num >= 82000 && num <= 83199) return 'WY';
  return null;
}

function usStateFromAddress(address) {
  const text = String(address || '');
  if (!text.trim()) return null;

  // Do not parse media filenames or URLs as addresses
  if (/\.(?:webp|png|jpe?g|gif|svg|ico|css|js)(?:\?.*)?$/i.test(text.trim())) {
    return null;
  }

  // 1. Check state code before zip with any delimiter: spaces, comma, dash, dot
  // e.g. "CA 95605", "CA, 95605", "CA - 95605", "CA. 95605", "CA,  95605"
  const code = /\b([A-Za-z]{2})[,\s\-.]+\d{5}(?:-\d{4})?\b/.exec(text)?.[1]?.toUpperCase() || null;
  if (code && US_TIMEZONE_BY_STATE[code]) return code;

  // 2. Check full state name before zip with any delimiter
  // e.g. "California, 95605", "California 95605", "California - 95605"
  const names = Object.entries(US_STATE_CODES_BY_NAME).sort(([left], [right]) => right.length - left.length);
  for (const [name, stateCode] of names) {
    const pattern = new RegExp(`\\b${escapePattern(name)}\\b(?=[,\\s\\-.]+\\d{5}(?:-\\d{4})?\\b)`, 'i');
    if (pattern.test(text)) return stateCode;
  }

  // 3. Check 5-digit zip code in text when accompanied by address context or state name
  const zipMatch = /\b(\d{5})(?:-\d{4})?\b/.exec(text);
  if (zipMatch) {
    const stateFromZip = usStateFromZip(zipMatch[1]);
    if (stateFromZip) {
      const hasAddressContext = /\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|hwy|highway|pkwy|parkway|way|ct|court|ln|lane|suite|ste|ste\.|unit|box|top|nail|spa|salon|west|east|north|south|sacramento|miami|dallas|houston|chicago|orlando|tampa|phoenix|denver|seattle|portland|boston|atlanta)\b/i.test(text);
      const hasStateMention = new RegExp(`\\b${stateFromZip}\\b`, 'i').test(text);
      if (hasAddressContext || hasStateMention) {
        return stateFromZip;
      }
    }
  }

  // 4. Check Canadian province code + postal code e.g. "ON L4M 5K3" or "ON, L4N 7T9"
  const caCode = /\b([A-Za-z]{2})[,\s\-.]+[A-Za-z]\d[A-Za-z][\s\-.]?\d[A-Za-z]\d\b/.exec(text)?.[1]?.toUpperCase() || null;
  if (caCode && CA_TIMEZONE_BY_PROVINCE[caCode]) return caCode;

  // 5. Check full Canadian province name e.g. "Ontario, L4N 7T9"
  for (const [name, provCode] of Object.entries(CA_PROVINCE_CODES_BY_NAME)) {
    const pattern = new RegExp(`\\b${escapePattern(name)}\\b(?=[,\\s\\-.]+[A-Za-z]\\d[A-Za-z][\\s\\-.]?\\d[A-Za-z]\\d\\b)`, 'i');
    if (pattern.test(text)) return provCode;
  }

  return null;
}

function extractJsonObject(text) {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const start = objectStart < 0 ? arrayStart : (arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart));
  if (start < 0) return null;
  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function repairWrappedJson(raw) {
  let quoted = false;
  let escaped = false;
  let result = '';
  // Editors in NewZen render indentation as non-breaking spaces. JSON only
  // accepts the ASCII whitespace set, so normalize it before parsing.
  for (const character of String(raw || '').replace(/[\u00a0\u202f\u200b]/g, ' ')) {
    if (quoted && (character === '\n' || character === '\r')) {
      result += ' ';
      continue;
    }
    result += character;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
  }
  return result;
}

function resolveTimezoneFromData(data) {
  if (!data) {
    return { address: null, state: null, iana: null, cmsLabel: null, source: null };
  }
  const strings = flattenStrings(data).map((item) => item.replace(/<br\s*\/?>/gi, ', ').replace(/\s+/g, ' ').trim());

  // 1. Check direct strings for address (handles comma, dash, full state name)
  let address = strings.find((item) => Boolean(usStateFromAddress(item))) || null;
  let state = usStateFromAddress(address);

  // 2. Check structured object fields if string search didn't find a full address
  if (!state && typeof data === 'object') {
    const scanObject = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const stateVal = (obj.state || obj.stateCode || obj.state_code || obj.province || '').toString().trim().toUpperCase();
      const zipVal = (obj.zip || obj.zipcode || obj.zip_code || obj.postalCode || obj.postal_code || '').toString().trim();

      if (stateVal && (US_TIMEZONE_BY_STATE[stateVal] || CA_TIMEZONE_BY_PROVINCE[stateVal])) {
        return {
          state: stateVal,
          address: `${obj.address || ''}, ${obj.city || ''}, ${stateVal} ${zipVal}`.replace(/^[,\s]+|[,\s]+$/g, '')
        };
      }
      if (stateVal && US_STATE_CODES_BY_NAME[stateVal.toLowerCase()]) {
        const mapped = US_STATE_CODES_BY_NAME[stateVal.toLowerCase()];
        return {
          state: mapped,
          address: `${obj.address || ''}, ${obj.city || ''}, ${mapped} ${zipVal}`.replace(/^[,\s]+|[,\s]+$/g, '')
        };
      }
      if (stateVal && CA_PROVINCE_CODES_BY_NAME[stateVal.toLowerCase()]) {
        const mapped = CA_PROVINCE_CODES_BY_NAME[stateVal.toLowerCase()];
        return {
          state: mapped,
          address: `${obj.address || ''}, ${obj.city || ''}, ${mapped} ${zipVal}`.replace(/^[,\s]+|[,\s]+$/g, '')
        };
      }
      if (zipVal && /^\d{5}/.test(zipVal)) {
        const fromZip = usStateFromZip(zipVal);
        if (fromZip) {
          return {
            state: fromZip,
            address: `${obj.address || ''}, ${obj.city || ''}, ${fromZip} ${zipVal}`.replace(/^[,\s]+|[,\s]+$/g, '')
          };
        }
      }
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') {
          const res = scanObject(val);
          if (res) return res;
        }
      }
      return null;
    };
    const structured = scanObject(data);
    if (structured) {
      state = structured.state;
      address = structured.address || address;
    }
  }

  // 3. Fallback: Check all strings for any 5-digit zip code that maps to a state
  if (!state) {
    for (const str of strings) {
      if (/\.(?:webp|png|jpe?g|gif|svg|ico|css|js)(?:\?.*)?$/i.test(str)) continue;
      const z = usStateFromZip(str);
      if (z) {
        state = z;
        address = str;
        break;
      }
    }
  }

  const mapped = state ? (US_TIMEZONE_BY_STATE[state] || CA_TIMEZONE_BY_PROVINCE[state]) : null;
  return mapped ? { address, state, iana: mapped[0], cmsLabel: mapped[1], source: 'data/setting.json' } : { address, state, iana: null, cmsLabel: null, source: null };
}

async function fetchTimezoneFromWebsite(siteUrl) {
  if (!siteUrl) return null;
  const target = siteUrl.replace(/\/+$/, '');

  // Try 1: Fetch /data/setting.json on the website
  try {
    const jsonRes = await fetch(`${target}/data/setting.json`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (jsonRes.ok) {
      const parsed = await jsonRes.json().catch(() => null);
      if (parsed) {
        const tz = resolveTimezoneFromData(parsed);
        if (tz.iana) return { ...tz, source: `${target}/data/setting.json` };
      }
    }
  } catch {}

  // Try 2: Fetch /data/footer.json on the website
  try {
    const jsonRes = await fetch(`${target}/data/footer.json`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (jsonRes.ok) {
      const parsed = await jsonRes.json().catch(() => null);
      if (parsed) {
        const tz = resolveTimezoneFromData(parsed);
        if (tz.iana) return { ...tz, source: `${target}/data/footer.json` };
      }
    }
  } catch {}

  // Try 3: Fetch website homepage HTML (Schema streetAddress or footer)
  try {
    const htmlRes = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const addressMatch = html.match(/itemprop=["']streetAddress["'][^>]*>([^<]+)<\/span>/i)
        || html.match(/\b\d{1,5}\s+[\w\s.,#-]+,\s*[A-Za-z]{2}[,\s\-.]+\d{5}\b/i);
      const addressText = addressMatch ? (addressMatch[1] || addressMatch[0]) : html;
      const state = usStateFromAddress(addressText) || usStateFromZip(html);
      if (state && US_TIMEZONE_BY_STATE[state]) {
        const mapped = US_TIMEZONE_BY_STATE[state];
        return {
          address: addressMatch ? (addressMatch[1] || addressMatch[0]) : `State detected from ${target}`,
          state,
          iana: mapped[0],
          cmsLabel: mapped[1],
          source: `${target} (website)`
        };
      }
    }
  } catch {}

  return null;
}

async function discoverProjectTimezone(page, baseUrl, { selectedDomain = null, website = null, ticketText = null } = {}) {
  let fallback = { address: null, iana: null, cmsLabel: null, source: null };
  const filenames = ['setting.json', 'settings.json', 'footer.json'];

  try {
    if (!page.url().startsWith(`${baseUrl}/files`)) {
      await page.goto(`${baseUrl}/files`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const folder = await waitForVisibleMatch(
      page.locator('text=/^\\s*(?:data|content)\\s*$/i').first(),
      'data or content folder',
      true,
      4000
    ).catch(() => null);

    if (folder) {
      await folder.dblclick().catch(() => folder.click().catch(() => {}));
      await page.waitForTimeout(300);
    }

    for (const filename of filenames) {
      const file = page.getByText(filename, { exact: true }).first();
      const isVisible = await file.isVisible().catch(() => false);
      if (!isVisible) continue;

      await file.click();
      await page.locator('.jsoneditor, .ace_editor, pre, code, [class*="editor"]').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});

      // Extract full text from Ace / Monaco / JSONEditor / textarea if available
      const editorValue = await page.evaluate(() => {
        const aceEl = document.querySelector('.ace_editor');
        if (aceEl) {
          if (aceEl.env?.editor?.getValue) return aceEl.env.editor.getValue();
          if (window.ace?.edit) {
            try { return window.ace.edit(aceEl).getValue(); } catch {}
          }
        }
        if (window.monaco?.editor?.getEditors) {
          const eds = window.monaco.editor.getEditors();
          if (eds.length > 0 && eds[0].getValue) return eds[0].getValue();
        }
        const jsonEl = document.querySelector('.jsoneditor');
        if (jsonEl?.jsoneditor?.getText) return jsonEl.jsoneditor.getText();
        const ta = document.querySelector('textarea:not(.ace_text-input)');
        if (ta && ta.value) return ta.value;
        const pre = document.querySelector('pre, code');
        if (pre && pre.innerText) return pre.innerText;
        return null;
      }).catch(() => null);

      const body = await page.locator('body').innerText();
      const marker = body.lastIndexOf(filename);
      const raw = editorValue || extractJsonObject(marker >= 0 ? body.slice(marker) : body);
      let parsed = null;
      try { parsed = JSON.parse(repairWrappedJson(raw)); } catch { /* ignore */ }

      if (parsed) {
        const timezone = { ...resolveTimezoneFromData(parsed), source: `data/${filename}` };
        if (timezone.address) fallback = timezone;
        if (timezone.iana) return timezone;
      } else if (raw) {
        // Even if JSON parsing failed, attempt to find state/zip in raw text
        const rawState = usStateFromAddress(raw) || usStateFromZip(raw);
        if (rawState && US_TIMEZONE_BY_STATE[rawState]) {
          const mapped = US_TIMEZONE_BY_STATE[rawState];
          return {
            address: `Extracted from raw ${filename}`,
            state: rawState,
            iana: mapped[0],
            cmsLabel: mapped[1],
            source: `data/${filename}`
          };
        }
      }

      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  } catch {}

  if (fallback.iana) return fallback;

  // Layer 2: Check website live URL, preview URL, or selected domain
  const siteUrls = [
    selectedDomain ? (selectedDomain.startsWith('http') ? selectedDomain : `https://${selectedDomain}`) : null,
    website?.liveUrl,
    website?.previewUrl
  ].filter(Boolean);

  for (const siteUrl of siteUrls) {
    try {
      const siteTz = await fetchTimezoneFromWebsite(siteUrl);
      if (siteTz?.iana) return siteTz;
    } catch {}
  }

  // Layer 3: Check ticket text
  if (ticketText) {
    const ticketState = usStateFromAddress(ticketText) || usStateFromZip(ticketText);
    if (ticketState && US_TIMEZONE_BY_STATE[ticketState]) {
      const mapped = US_TIMEZONE_BY_STATE[ticketState];
      return {
        address: 'Extracted from ticket notes',
        state: ticketState,
        iana: mapped[0],
        cmsLabel: mapped[1],
        source: 'ticket-text'
      };
    }
  }

  return {
    address: fallback.address,
    state: fallback.state || null,
    iana: DEFAULT_US_TIMEZONE.iana,
    cmsLabel: DEFAULT_US_TIMEZONE.cmsLabel,
    source: 'default-us-timezone'
  };
}

async function setPopupTimezone(page, timezone) {
  // Announcement 1.0.38 moved away from the per-popup Timezone selector.
  // Keep using the project-address timezone for date calculations, but do
  // not fail the workflow when this older control is absent from the new UI.
  let label = await visibleLabel(page, 'Timezone', true).catch(() => null);
  if (!label) {
    const customLabels = page.locator('label, div, span, p').filter({ hasText: /^Timezone$/i });
    const count = await customLabels.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i -= 1) {
      const c = customLabels.nth(i);
      if (await isElementDisplayed(c)) {
        label = c;
        break;
      }
    }
  }

  let control = null;
  let id = null;
  if (label) {
    id = await label.getAttribute('for').catch(() => null);
    if (id) {
      control = await visibleMatch(page.locator(`[id="${id}"]`), null, true).catch(() => null);
    }
    if (!control) {
      const container = label.locator('xpath=ancestor::div[.//button[normalize-space()="Save"] or contains(@class, "form-item")][1]');
      control = await visibleMatch(container.locator('[role="combobox"], input, .el-select, button').filter({ hasNotText: /^Save$/i }), null, true).catch(() => null);
    }
  }
  if (!control) {
    const direct = page.locator('[role="combobox"]:has-text("UTC"), input[value*="UTC"], button:has-text("UTC"), .el-select:has-text("UTC")');
    if (await direct.count().catch(() => 0) > 0) {
      control = direct.first();
    }
  }
  if (!control) return { applied: false, supported: false, cmsLabel: timezone?.cmsLabel || null };

  const currentText = (await control.innerText().catch(() => '')).trim()
    || (await control.inputValue().catch(() => '')).trim();
  if (currentText.includes(timezone.cmsLabel.split(' (')[0])) {
    return { applied: false, supported: true, cmsLabel: timezone.cmsLabel };
  }

  await control.click();
  await page.waitForTimeout(300);
  const search = await visibleMatch(page.locator('input[placeholder*="Search timezone" i], input[placeholder*="timezone" i], input[placeholder*="Search" i]'), null, true).catch(() => null);
  if (search) {
    await search.fill(timezone.cmsLabel.split(' (')[0]);
    await page.waitForTimeout(200);
  }
  const option = await visibleMatch(
    page.getByText(timezone.cmsLabel, { exact: true }),
    null,
    true
  ).catch(() => null) || await visibleMatch(
    page.locator('.el-select-dropdown__item, [role="option"], li').filter({ hasText: timezone.cmsLabel.split(' (')[0] }),
    'Timezone option',
    true
  ).catch(() => null);

  if (option) await option.click();
  await page.waitForTimeout(300);

  // Timezone is a project setting. Commit it before interacting with any date
  // picker so NewZen serializes start/end values in the intended timezone.
  const tzContainer = control.locator('xpath=ancestor::div[.//button[normalize-space()="Save"]][1]');
  const tzSave = tzContainer.locator('button', { hasText: /^Save$/ }).first();
  if (await tzSave.count() > 0 && await isElementDisplayed(tzSave)) {
    await tzSave.click();
  } else {
    const save = await waitForSaveEnabled(page).catch(() => null);
    if (save) await save.click();
  }
  await page.waitForTimeout(600);
  return { applied: true, supported: true, cmsLabel: timezone.cmsLabel };
}
async function main() {
  const ticketUrl = httpsUrl(value('--ticket-url'), '--ticket-url');
  const cmsUrl = httpsUrl(value('--cms-url', 'https://apps.newzensite.com/organizations'), '--cms-url');
  if (new URL(ticketUrl).hostname !== 'crm.fastboy.dev') {
    throw new Error('--ticket-url must be a link from crm.fastboy.dev.');
  }
  const suppliedSiteId = value('--site-id', null);
  const applyChanges = process.argv.includes('--apply');
  const downloadPoster = process.argv.includes('--download-poster');
  const buildRequested = process.argv.includes('--build');
  const repairExistingPopup = process.argv.includes('--repair-existing-popup');
  const expiryOverride = value('--expiry', null);
  const linkOverride = value('--link', null);
  if (buildRequested && !applyChanges) throw new Error('--build requires --apply.');
  if (repairExistingPopup && !applyChanges) throw new Error('--repair-existing-popup requires --apply.');
  const root = path.resolve(__dirname, '..');
  const plan = { status: 'awaiting-review', safety: 'No CMS write action was attempted.', ticketUrl, cmsUrl, organization: 'fastboy' };
  let runDir = null;
  let reportPath = null;
  let browser = null;
  let context = null;
  let profileDirectory = null;
  let cleanupProfile = false;
  let downloadedAttachment = null;
  let downloadedAttachments = [];
  let visionCandidateDownloads = null;
  let visionPosterSchedules = [];
  try {
    const reportDirectory = createRunDirectory(root);
    runDir = reportDirectory.directory;
    plan.reportStorage = reportDirectory.storage;
    progress('starting', 'Đang mở phiên Chrome riêng của tool');
    const launched = await launchToolBrowser(root, {
      headless: !process.argv.includes('--headed'),
      acceptDownloads: true
    });
    browser = launched.browser;
    context = launched.context;
    profileDirectory = launched.profileDirectory;
    cleanupProfile = Boolean(launched.cleanupProfile);
    const page = context.pages()[0] || await context.newPage();
    progress('crm', 'Đang mở ticket CRM');
    await openTicketDetails(page, ticketUrl);
    progress('crm-loaded', 'Đã tải nội dung ticket');
    const ticketContext = await readFullTicketContext(page, ticketUrl);
    const body = ticketContext.text;
    fs.writeFileSync(path.join(runDir, 'ticket.txt'), body, 'utf8');
    await page.screenshot({ path: path.join(runDir, 'ticket.png'), fullPage: false });
    plan.ticketPageUrl = page.url();
    const online = await page.evaluate(() => navigator.onLine);
    const problem = browserProblem(body, online);
    if (problem) {
      plan.status = problem;
      plan.nextAction = 'Open the Popup Ticket Runner app and sign in to CRM and CMS. If the problem remains after sign-in, check VPN/proxy/firewall. No CMS action was attempted.';
    } else if (bootstrapMessage(body)) {
      plan.status = 'ticket-not-loaded';
      plan.nextAction = 'CRM did not finish loading its ticket UI within 15 seconds. Confirm the runner Chrome profile is signed in, then retry. No CMS action was attempted.';
    } else {
      const deterministicTicket = ticketData(body, ticketUrl);
      progress('ticket-semantics', 'Reading ticket meaning with Gemini safety fallback');
      const semanticResolution = await resolveTicketSemantics(deterministicTicket, body, {
        attachmentCandidates: ticketContext.attachmentCandidates
      });
      plan.ticket = semanticResolution.ticket;
      plan.semantic = semanticResolution.audit;
      plan.ticket.attachmentAvailable = Boolean(
        ticketContext.attachmentCandidates.length
        || (ticketContext.root && await isElementDisplayed(allAttachmentsDownloadButton(ticketContext.root)))
      );
      plan.ticket.attachmentCount = ticketContext.attachmentCandidates.length;
      plan.ticket = resolveRemovalScopeFromAttachments(plan.ticket, ticketContext.attachmentCandidates);
      if (plan.ticket.actionSummary) {
        progress('ticket-plan', `Kế hoạch thực hiện: ${plan.ticket.actionSummary}`, {
          action: plan.ticket.popupAction,
          summary: plan.ticket.actionSummary,
          topic: plan.ticket.removalTopic || null
        });
      }
      if (ticketContext.attachmentCandidates.length === 1 && !plan.ticket.popupAttachmentIndex) {
        // A sole visible image attachment is unambiguous even if Gemini is
        // unavailable. Retain the numbered choice so the downloader cannot
        // silently select a different image later in the run.
        plan.ticket.popupAttachmentIndex = 1;
        plan.ticket.popupAttachmentSelection = 'only-visible-image';
      } else if (plan.ticket.popupAttachmentIndex) {
        plan.ticket.popupAttachmentSelection = 'gemini-comment-evidence';
      }
      if (suppliedSiteId) {
        if (!/^\d{3,}$/.test(suppliedSiteId)) throw new Error('--site-id must be a numeric Website ID.');
        plan.ticket.siteId = suppliedSiteId;
        plan.ticket.siteIdSource = 'command-line override';
      } else if (plan.ticket.siteId) {
        plan.ticket.siteIdSource = 'ticket text';
      }
      if (linkOverride) {
        plan.ticket.popupLink = linkOverride;
      }
      if (plan.ticket.scheduleError) {
        plan.status = 'schedule-needs-review';
        plan.nextAction = `${plan.ticket.scheduleError} No CMS change was attempted.`;
      } else if (!plan.ticket.siteId) {
        plan.status = 'needs-site-id';
        plan.nextAction = 'Review ticket.txt and add/update the Website ID extraction rule.';
      } else {
        if (plan.ticket.endYearRolledOver) {
          progress('schedule-normalized', `Đã suy luận năm kết thúc ${plan.ticket.expiryDate} từ khoảng ngày trong ticket`, {
            evidence: plan.ticket.scheduleEvidence
          });
        }
        progress('site-id', `Đã nhận diện Website ID ${plan.ticket.siteId}`, { siteId: plan.ticket.siteId });
        const actionNeedsTicketImage = popupActionNeedsTicketImage(
          plan.ticket.popupAction,
          ticketContext.attachmentCandidates.length
        );
        let attachmentDecision = attachmentPlanForTicket({
          popupAction: plan.ticket.popupAction,
          attachmentCount: ticketContext.attachmentCandidates.length,
          popupAttachmentIndex: plan.ticket.popupAttachmentIndex,
          popupAttachmentIndexes: plan.ticket.popupAttachmentIndexes
        });
        plan.attachmentPlan = attachmentDecision;
        const shouldDownloadTicketImage = actionNeedsTicketImage
          && ((applyChanges && !repairExistingPopup) || downloadPoster);
        if (shouldDownloadTicketImage) {
          const multiPosterTicket = attachmentDecision.mode === 'multi-set';
          if (multiPosterTicket) {
            // A multi-image ticket is never reduced to whichever thumbnail
            // Gemini happens to choose first. Download every visible local
            // candidate, then require Gemini Vision to identify the complete
            // poster set before plugin or CMS mutation can begin.
            progress('attachment-vision-download', 'Downloading local ticket images for Gemini Vision multi-poster selection');
            visionCandidateDownloads = await downloadTicketCandidateImages(page, ticketUrl, runDir, {
              expectedAttachmentCount: ticketContext.attachmentCandidates.length
            });
            const preparedVision = await visionCandidatesFromDownloads(visionCandidateDownloads, ticketContext.attachmentCandidates, { page });
            if (preparedVision.candidates.length < 2) {
              const error = new Error('Ticket contains multiple image attachments, but fewer than two could be validated locally. No CMS change was attempted.');
              error.stage = 'attachment-selection';
              throw error;
            }
            progress('ticket-vision', 'Using Gemini Vision to verify the complete popup-poster set');
            const visionResolution = await resolveTicketPopupVisionSet(body, preparedVision.candidates);
            plan.vision = {
              ...visionResolution.audit,
              warnings: [...preparedVision.warnings, ...(visionResolution.audit.warnings || [])]
            };
            if (!visionResolution.selection) {
              const message = visionResolution.audit.status === 'disabled'
                ? 'Gemini Vision API key is not configured on this computer. Configure Gemini in the app before running a multi-poster ticket. No CMS change was attempted.'
                : visionResolution.audit.status === 'unavailable'
                  ? 'Gemini Vision could not be reached from this computer. Check the API key and network, then retry. No CMS change was attempted.'
                  : 'Gemini Vision could not identify every requested popup poster with sufficient confidence. No CMS change was attempted.';
              const error = new Error(message);
              error.stage = 'attachment-selection';
              throw error;
            }
            const candidateMap = new Map(preparedVision.candidates.map((c) => [c.index, c]));
            const nonRemovalCandidates = preparedVision.candidates.filter((c) => !c.isRemovalReference);
            if (nonRemovalCandidates.length > 0) {
              const nonRemovalSelected = visionResolution.selection.indices.filter((idx) => {
                const c = candidateMap.get(idx);
                return c && !c.isRemovalReference;
              });
              if (nonRemovalSelected.length > 0) {
                visionResolution.selection.indices = nonRemovalSelected;
              } else {
                const uploadCard = nonRemovalCandidates.find((c) => c.kind === 'upload-card') || nonRemovalCandidates[0];
                progress('attachment-selection-corrected', `Gemini Vision đã chọn nhầm ảnh chụp màn hình cần gỡ (#${visionResolution.selection.indices.join(', ')}); tự động chuyển sang poster artwork đính kèm #${uploadCard.index} (${uploadCard.filename})`);
                visionResolution.selection.indices = [uploadCard.index];
              }
            }
            const textSelection = plan.ticket.popupAttachmentIndex || null;
            const textCandidate = candidateMap.get(textSelection);
            const validTextSelection = textSelection && textCandidate && !textCandidate.isRemovalReference ? textSelection : null;
            if (validTextSelection && !visionResolution.selection.indices.includes(validTextSelection)) {
              const rationale = String(visionResolution.audit?.rationale || visionResolution.selection?.rationale || '');
              const textSelectionWasRejected = new RegExp(String.raw`attachment\s*#?${validTextSelection}\b.*(?:remove|gỡ|xóa|old|screenshot|chụp|không\s*phải)`, 'i').test(rationale)
                || isPopupRemovalAction(plan.ticket.popupAction)
                || plan.ticket.popupAction === 'replace'
                || hasAffirmativePopupRemoval(body);

              if (textSelectionWasRejected && visionResolution.selection.indices.length > 0) {
                progress('attachment-selection-corrected', `Gemini text chọn ảnh #${validTextSelection} (ảnh cũ/cần gỡ); Gemini Vision đã xác minh poster mới chính xác là #${visionResolution.selection.indices.join(', ')}`);
                plan.ticket.popupAttachmentIndex = visionResolution.selection.indices[0];
              } else {
                const error = new Error(`Gemini text selected attachment #${validTextSelection}, but the verified Vision poster set does not contain it. The poster set was not guessed.`);
                error.stage = 'attachment-selection';
                throw error;
              }
            }
            const multiIntent = hasMultiPosterIntent(body);
            if (!multiIntent && validTextSelection && visionResolution.selection.indices.includes(validTextSelection)) {
              progress('attachment-selection-refined', `Ticket chỉ yêu cầu 1 popup; ưu tiên poster #${validTextSelection} từ ngữ cảnh/comment`);
              plan.ticket.popupAttachmentIndexes = [validTextSelection];
            } else if (!multiIntent && visionResolution.selection.indices.length > 1) {
              const latestIndex = Math.max(...visionResolution.selection.indices);
              progress('attachment-selection-refined', `Ticket không yêu cầu nhiều popup; ưu tiên ảnh đính kèm mới nhất #${latestIndex}`);
              plan.ticket.popupAttachmentIndexes = [latestIndex];
            } else {
              plan.ticket.popupAttachmentIndexes = visionResolution.selection.indices;
            }
            plan.ticket.popupAttachmentSelection = 'gemini-vision-set';
            visionPosterSchedules = (visionResolution.selection.posterSchedules || [])
              .filter((schedule) => plan.ticket.popupAttachmentIndexes.includes(schedule.attachmentIndex));
            plan.ticket.popupVisionSchedules = visionPosterSchedules;
            applyArtworkSchedulePrecedence(plan.ticket, visionPosterSchedules);
            attachmentDecision = attachmentPlanForTicket({
              popupAction: plan.ticket.popupAction,
              attachmentCount: ticketContext.attachmentCandidates.length,
              popupAttachmentIndex: plan.ticket.popupAttachmentIndexes.length === 1 ? plan.ticket.popupAttachmentIndexes[0] : null,
              popupAttachmentIndexes: plan.ticket.popupAttachmentIndexes
            });
            plan.attachmentPlan = attachmentDecision;
            downloadedAttachments = plan.ticket.popupAttachmentIndexes.map((candidateIndex) => (
              visionCandidateDownloads.find((candidate) => candidate.candidateIndex === candidateIndex) || null
            ));
            if (downloadedAttachments.some((attachment) => !attachment) || downloadedAttachments.length !== plan.ticket.popupAttachmentIndexes.length) {
              const error = new Error('Gemini Vision selected a poster that was not present in the locally downloaded ticket images.');
              error.stage = 'attachment-selection';
              throw error;
            }
            if (applyChanges) {
              try {
                downloadedAttachments = await Promise.all(
                  downloadedAttachments.map((attachment) => stageCmsUploadImage(attachment, runDir, { page, progress }))
                );
                for (const attachment of downloadedAttachments) {
                  progress(
                    'attachment-upload-staged',
                    `Đã tạo bản poster tên an toàn để upload CMS: ${attachment.uploadFilename}`,
                    { originalFilename: attachment.filename, candidateIndex: attachment.candidateIndex }
                  );
                }
              } catch (error) {
                error.stage = 'attachment-upload-stage';
                throw error;
              }
            }
            downloadedAttachment = downloadedAttachments[0];
            plan.attachments = downloadedAttachments.map(attachmentReport);
            plan.attachment = plan.attachments[0];
            progress('attachments-downloaded', `Đã tải và xác minh ${downloadedAttachments.length} poster từ ticket`, {
              count: downloadedAttachments.length
            });
            if (!applyChanges) plan.safety = 'All selected posters were downloaded and validated locally. No CMS write action was attempted.';
          } else {
          if (!attachmentDecision.ready && attachmentDecision.mode === 'removal-reference') {
            const error = new Error('This removal ticket has multiple image attachments, but none was identified unambiguously as the popup reference image. No CMS change was attempted.');
            error.stage = 'attachment-selection';
            throw error;
          }
          // Even one unambiguous image can contain an explicit display window
          // that is not repeated in the ticket text. Run Vision for every new
          // or replacement poster so those dates can be validated per image.
          const shouldUseVision = shouldUseTicketVision(
            plan.ticket.popupAction,
            ticketContext.attachmentCandidates.length
          );
          if (shouldUseVision) {
            progress('attachment-vision-download', 'Downloading local ticket images for Gemini Vision selection');
            try {
              visionCandidateDownloads = await downloadTicketCandidateImages(page, ticketUrl, runDir, {
                expectedAttachmentCount: ticketContext.attachmentCandidates.length
              });
              const preparedVision = await visionCandidatesFromDownloads(visionCandidateDownloads, ticketContext.attachmentCandidates, { page });
              if (preparedVision.candidates.length) {
                progress('ticket-vision', 'Đang dùng Gemini Vision để xác minh poster và đọc ngày hết hạn...');
                const visionResolution = await resolveTicketVision(body, preparedVision.candidates);
                plan.vision = {
                  ...visionResolution.audit,
                  warnings: [...preparedVision.warnings, ...(visionResolution.audit.warnings || [])]
                };
                if (visionResolution.selection) {
                  const textSelection = plan.ticket.popupAttachmentIndex || null;
                  if (textSelection && textSelection !== visionResolution.selection.index) {
                    const rationale = String(visionResolution.audit?.rationale || visionResolution.selection?.rationale || '');
                    const textSelectionWasRejected = new RegExp(String.raw`attachment\s*#?${textSelection}\b.*(?:remove|gỡ|xóa|old|screenshot|chụp|không\s*phải)`, 'i').test(rationale)
                      || isPopupRemovalAction(plan.ticket.popupAction)
                      || plan.ticket.popupAction === 'replace'
                      || hasAffirmativePopupRemoval(body);

                    if (textSelectionWasRejected) {
                      progress('attachment-selection-corrected', `Gemini text chọn ảnh #${textSelection} (ảnh cũ/cần gỡ); Gemini Vision đã xác minh poster mới chính xác là #${visionResolution.selection.index}`);
                    } else {
                      const error = new Error(`Gemini text selected attachment #${textSelection}, while Gemini Vision selected #${visionResolution.selection.index}. The poster was not guessed.`);
                      error.stage = 'attachment-selection';
                      throw error;
                    }
                  }
                  plan.ticket.popupAttachmentIndex = visionResolution.selection.index;
                  plan.ticket.popupAttachmentSelection = 'gemini-vision';
                  visionPosterSchedules = visionResolution.selection.posterSchedules || [];
                  plan.ticket.popupVisionSchedules = visionPosterSchedules;
                  applyArtworkSchedulePrecedence(plan.ticket, visionPosterSchedules, visionResolution.selection.index);
                }
              } else {
                plan.vision = {
                  provider: 'gemini-vision',
                  status: 'skipped',
                  warnings: preparedVision.warnings.length ? preparedVision.warnings : ['No ticket image was eligible for inline Gemini Vision.']
                };
              }
            } catch (error) {
              if (error.stage === 'attachment-selection') throw error;
              plan.vision = {
                provider: 'gemini-vision',
                status: 'unavailable',
                warnings: [error.message || 'Gemini Vision was unavailable; text-based attachment selection was used.']
              };
              visionCandidateDownloads = null;
            }
          }
          progress('attachment-download', 'Downloading the popup image from CRM');
          if (visionCandidateDownloads) {
            downloadedAttachment = visionCandidateDownloads.find(
              (candidate) => candidate.candidateIndex === plan.ticket.popupAttachmentIndex
            ) || null;
            if (!downloadedAttachment) {
              const error = new Error('Gemini Vision completed, but no uniquely selected local popup poster was available.');
              error.stage = 'attachment-selection';
              throw error;
            }
          } else {
            downloadedAttachment = await downloadTicketImage(page, ticketUrl, runDir, {
              selectedAttachmentIndex: plan.ticket.popupAttachmentIndex || null,
              expectedAttachmentCount: ticketContext.attachmentCandidates.length
            });
          }
          if (applyChanges && (plan.ticket.popupAction === 'create' || plan.ticket.popupAction === 'replace')) {
            try {
              downloadedAttachment = await stageCmsUploadImage(downloadedAttachment, runDir, { page, progress });
              progress(
                'attachment-upload-staged',
                `Đã tạo bản poster tên an toàn để upload CMS: ${downloadedAttachment.uploadFilename}`,
                { originalFilename: downloadedAttachment.filename }
              );
            } catch (error) {
              error.stage = 'attachment-upload-stage';
              throw error;
            }
          }
          downloadedAttachments = [downloadedAttachment];
          plan.attachment = attachmentReport(downloadedAttachment);
          plan.attachments = [plan.attachment];
          progress('attachment-downloaded', `Đã tải xong poster: ${downloadedAttachment.filename}`, { bytes: downloadedAttachment.bytes });
          if (!applyChanges) plan.safety = 'Poster was downloaded and validated locally. No CMS write action was attempted.';
          }

          if (downloadedAttachments.length > 0 && (!visionPosterSchedules || visionPosterSchedules.length === 0) && (plan.ticket.popupAction === 'create' || plan.ticket.popupAction === 'replace')) {
            try {
              const localCandidates = downloadedAttachments
                .map((att, i) => visionCandidateFromLocalImage(att, att.candidateIndex || (i + 1), 'Downloaded ticket poster'))
                .filter(Boolean);
              if (localCandidates.length > 0) {
                progress('ticket-vision', 'Đang dùng Gemini Vision để đọc ngày hết hạn từ poster đã tải');
                if (localCandidates.length === 1) {
                  const visionResolution = await resolveTicketVision(body, localCandidates);
                  if (visionResolution.selection?.posterSchedules?.length) {
                    visionPosterSchedules = visionResolution.selection.posterSchedules;
                    plan.ticket.popupVisionSchedules = visionPosterSchedules;
                    applyArtworkSchedulePrecedence(plan.ticket, visionPosterSchedules, localCandidates[0].index);
                  }
                  if (visionResolution.audit) {
                    plan.vision = {
                      ...visionResolution.audit,
                      warnings: [...(plan.vision?.warnings || []), ...(visionResolution.audit.warnings || [])]
                    };
                  }
                } else {
                  const visionResolution = await resolveTicketPopupVisionSet(body, localCandidates);
                  if (visionResolution.selection?.posterSchedules?.length) {
                    visionPosterSchedules = visionResolution.selection.posterSchedules;
                    plan.ticket.popupVisionSchedules = visionPosterSchedules;
                    applyArtworkSchedulePrecedence(plan.ticket, visionPosterSchedules);
                  }
                  if (visionResolution.audit) {
                    plan.vision = {
                      ...visionResolution.audit,
                      warnings: [...(plan.vision?.warnings || []), ...(visionResolution.audit.warnings || [])]
                    };
                  }
                }
              }
            } catch {
              // Non-fatal
            }
          }
        }
        progress('cms', 'Đang mở NewZenSite');
        await page.goto(cmsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await openFastboy(page);
        progress('organization', 'Đã mở Organization fastboy');
        await page.getByText('Find exact', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
        const search = page.locator('input[placeholder*="Search" i]').first();
        await search.waitFor({ state: 'visible', timeout: 10000 });
        await search.click();
        await search.fill('');
        await search.pressSequentially(plan.ticket.siteId, { delay: 60 });
        await search.press('Enter').catch(() => {});
        // Wait for CMS search debounce, network API, and card rendering
        await page.getByText(plan.ticket.siteId, { exact: true }).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1000);
        progress('project-search', `Đang tìm project ${plan.ticket.siteId}`);
        let projectCandidates = await projectSearchCandidates(page, plan.ticket.siteId);
        if (!projectCandidates.length) {
          await page.waitForTimeout(1500);
          projectCandidates = await projectSearchCandidates(page, plan.ticket.siteId);
        }
        const projectSelection = chooseProjectCandidate(projectCandidates);
        const selectedDomain = projectSelection.candidate?.domains.find((domain) => !isPreviewProjectDomain(domain))
          || projectSelection.candidate?.domains[0]
          || null;
        plan.cms = {
          siteId: plan.ticket.siteId,
          searchValue: await search.inputValue(),
          found: projectCandidates.length > 0,
          candidateCount: projectCandidates.length,
          selectedDomain,
          selectionMethod: projectSelection.method,
          ambiguous: projectSelection.ambiguous
        };
        await page.screenshot({ path: path.join(runDir, 'cms-search.png'), fullPage: false });
        if (!plan.cms.found) {
          plan.status = 'site-not-found';
          plan.nextAction = 'Verify the Website ID and fastboy access.';
        } else if (plan.cms.ambiguous || !projectSelection.candidate) {
          plan.status = 'site-id-ambiguous';
          plan.nextAction = `Website ID ${plan.ticket.siteId} has multiple CMS projects and no unique custom-domain match. No CMS change was attempted.`;
        } else {
          progress('project-open', 'Opening the matching CMS project');
          const project = page.getByText(plan.ticket.siteId, { exact: true }).nth(projectSelection.candidate.locatorIndex);
          await project.click();
          await page.waitForURL(/\/projects\/\d+/, { timeout: 15000 }).catch(() => page.waitForTimeout(400));
          const baseUrl = projectBaseUrl(page.url());
          plan.cms.projectId = baseUrl.match(/\/projects\/(\d+)/)?.[1] || null;

          progress('plugin-check', 'Checking Announcement plugin status');
          await page.goto(`${baseUrl}/plugins`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.getByText('Plugins', { exact: true }).last().waitFor({ state: 'visible', timeout: 15000 });
          plan.plugin = await readAnnouncementPlugin(page);
          await page.screenshot({ path: path.join(runDir, 'plugins.png'), fullPage: false });

          // CMS applies index.yml during Build, so do not inspect it here.
          plan.popupSection = { exists: null, sectionId: null, checked: false };

          if (isPopupRemovalAction(plan.ticket.popupAction)) {
            const isTopicRemoval = plan.ticket.popupAction === 'remove-one' && !downloadedAttachment;
            plan.status = 'ready-to-remove-popup';
            plan.nextAction = plan.ticket.popupAction === 'remove-all'
              ? 'Ticket requests removal of every current popup. Apply will delete existing popup items and Build only after verification.'
              : isTopicRemoval
                ? 'Ticket requests removal of a specific popup described in the note. Apply will use Gemini Vision to inspect current CMS popups and delete the matching one.'
                : 'Ticket includes a popup reference image. Apply will use Gemini Vision to match exactly one current CMS popup before deleting it.';
            if (applyChanges) {
              plan.safety = buildRequested
                ? 'CMS popup-removal and Build/publish were explicitly requested.'
                : 'CMS popup-removal was explicitly requested. Build/publish was not requested.';

              let sectionVersionInfo = { expectedToken: null, sections: [], legacySectionIds: [] };
              try {
                sectionVersionInfo = await inspectAnnouncementSectionVersions(page, baseUrl, plan.plugin.version);
                plan.legacySection = {
                  expectedVersion: sectionVersionInfo.expectedToken,
                  legacyCount: sectionVersionInfo.legacySectionIds.length
                };
              } catch (error) {
                // Section version check fallback
              }

              const pluginStateBeforeApply = plan.plugin.state;
              const mustUpgrade = pluginStateBeforeApply === 'outdated'
                || pluginStateBeforeApply === 'missing'
                || sectionVersionInfo.legacySectionIds.length > 0
                || (plan.plugin.version && announcementSectionVersionToken(plan.plugin.version) !== '1038');

              let removal;
              if (mustUpgrade) {
                progress('timezone-check', 'Reading project address to resolve popup timezone');
                plan.timezone = await discoverProjectTimezone(page, baseUrl, {
                  selectedDomain: plan.cms?.selectedDomain,
                  website: plan.website,
                  ticketText: plan.ticket?.raw
                });

                progress('legacy-popup-snapshot', 'Reading active popups before plugin update and section replacement');
                const legacyPopupSnapshot = await snapshotActiveLegacyPopups(page, baseUrl, plan.timezone, runDir, {
                  preserveActive: true
                });

                if (!legacyPopupSnapshot.scannedItems.length) {
                  removal = { scope: 'all', sectionCount: 0, removedCount: 0, changed: false };
                } else if (plan.ticket.popupAction === 'remove-all') {
                  progress('popup-removal-all', 'Removing every current popup item requested by the ticket');
                  progress('plugin-apply', 'Updating Announcement plugin to latest version');
                  plan.plugin = await ensureAnnouncementPlugin(page, baseUrl);
                  progress('section-apply', 'Recreating Announcement section on latest plugin version');
                  plan.popupSection = await ensurePopupSection(page, baseUrl, {
                    replaceExisting: true,
                    expectedPluginVersion: plan.plugin.version,
                    targetSectionIds: sectionVersionInfo.legacySectionIds
                  });
                  try {
                    await openPopupSettings(page, plan.popupSection.sectionId);
                    await deleteOneEmptyPopupItem(page, 0).catch(() => {});
                  } catch {}
                  removal = {
                    scope: 'all',
                    changed: true,
                    removedCount: legacyPopupSnapshot.scannedItems.length,
                    sectionCount: 1,
                    sectionId: plan.popupSection.sectionId,
                    vision: null
                  };
                } else {
                  // remove-one
                  const popupCandidates = legacyPopupSnapshot.scannedItems.map((item, idx) => ({
                    ...item,
                    visionIndex: idx + 1,
                    sectionId: 'cms',
                    itemIndex: idx
                  }));

                  const prepared = preparePopupRemovalVision(downloadedAttachment, popupCandidates);
                  if (!prepared.candidates.length || prepared.complete !== true || prepared.candidates.length !== popupCandidates.length) {
                    const error = new Error(prepared.warnings.join(' ') || 'CMS popup images could not be prepared for Gemini Vision comparison.');
                    error.stage = 'popup-removal-ambiguous';
                    throw error;
                  }

                  progress('popup-removal-vision', downloadedAttachment
                    ? 'Gemini Vision is matching the ticket image to the current CMS popup'
                    : 'Gemini Vision đang đọc nội dung các popup trên CMS để xác định popup thông báo cần gỡ');
                  const resolution = await resolveTicketPopupRemovalVision(body, prepared.reference, prepared.candidates);
                  if (!resolution.selection) {
                    const notFound = resolution.audit?.status === 'not-found';
                    const auditWarning = resolution.audit?.warnings?.join(' ') || '';
                    const error = new Error(notFound
                      ? 'No current CMS popup matches the ticket request. No popup was removed and CMS Build was not started.'
                      : (auditWarning ? `The tool could not identify CMS popups matching the ticket request (${auditWarning}). No popup was removed and CMS Build was not started.` : 'The tool could not identify CMS popups matching the ticket request. No popup was removed and CMS Build was not started.'));
                    error.stage = notFound ? 'popup-removal-not-found' : 'popup-removal-ambiguous';
                    error.vision = resolution.audit;
                    throw error;
                  }

                  const targetIndices = new Set(
                    (Array.isArray(resolution.selection?.indices) && resolution.selection.indices.length > 0
                      ? resolution.selection.indices
                      : [resolution.selection?.index]
                    ).map((idx) => idx - 1)
                  );

                  const preservedPopups = legacyPopupSnapshot.items.filter((item) => {
                    const scannedIdx = legacyPopupSnapshot.scannedItems.indexOf(item);
                    return !targetIndices.has(scannedIdx);
                  });

                  progress('plugin-apply', 'Updating Announcement plugin to latest version');
                  plan.plugin = await ensureAnnouncementPlugin(page, baseUrl);

                  progress('section-apply', 'Recreating Announcement section on latest plugin version');
                  plan.popupSection = await ensurePopupSection(page, baseUrl, {
                    replaceExisting: true,
                    expectedPluginVersion: plan.plugin.version,
                    targetSectionIds: sectionVersionInfo.legacySectionIds
                  });

                  if (preservedPopups.length > 0) {
                    progress('popup-migrate', `Đang đưa ${preservedPopups.length} popup còn lại sang section Announcement 1038 mới`);
                    await configurePopup(page, null, null, plan.timezone, {
                      replaceExisting: false,
                      sectionId: plan.popupSection.sectionId,
                      legacyPopups: preservedPopups
                    });
                  } else {
                    try {
                      await openPopupSettings(page, plan.popupSection.sectionId);
                      await deleteOneEmptyPopupItem(page, 0).catch(() => {});
                    } catch {}
                  }

                  const firstTargetIdx = Array.from(targetIndices)[0] ?? 0;
                  removal = {
                    scope: targetIndices.size > 1 ? 'multiple' : 'one',
                    changed: targetIndices.size > 0,
                    removedCount: targetIndices.size,
                    sectionCount: 1,
                    sectionId: plan.popupSection.sectionId,
                    itemIndex: firstTargetIdx,
                    imageUrl: legacyPopupSnapshot.scannedItems[firstTargetIdx]?.sourceImageUrl || null,
                    vision: resolution.audit,
                    visionRationale: resolution.selection.rationale,
                    warnings: prepared.warnings
                  };
                }
              } else {
                removal = await removePopupForTicket(
                  page,
                  baseUrl,
                  runDir,
                  body,
                  plan.ticket.popupAction,
                  downloadedAttachment
                );
              }
              plan.popupRemoval = {
                scope: removal.scope,
                changed: removal.changed,
                removedCount: removal.removedCount,
                sectionCount: removal.sectionCount || null,
                sectionId: removal.sectionId || null,
                itemIndex: Number.isInteger(removal.itemIndex) ? removal.itemIndex : null,
                imageUrl: removal.imageUrl || null,
                visionRationale: removal.visionRationale || null,
                warnings: removal.warnings || []
              };
              if (removal.vision) plan.removalVision = removal.vision;
              await page.screenshot({ path: path.join(runDir, 'popup-removal.png'), fullPage: false });
              if (!removal.changed) {
                plan.status = 'popup-removal-noop';
                plan.nextAction = 'No configured popup existed to remove. CMS Build was not started because no CMS change was needed.';
              } else if (buildRequested) {
                progress('build-start', 'Starting CMS Build after verified popup removal');
                plan.build = await buildWebsite(page, baseUrl, {
                  fallbackDomain: plan.cms?.selectedDomain || null,
                  progress
                });
                plan.website = plan.build.website;
                plan.cmsStatus = plan.build.cmsStatus || null;
                if (plan.build.status === 'success') {
                  const websiteUrl = plan.website.liveUrl || plan.website.previewUrl || null;
                  plan.status = 'popup-removed';
                  const statusNote = plan.cmsStatus?.summary ? ` · [${plan.cmsStatus.summary}]` : '';
                  plan.nextAction = websiteUrl
                    ? `Popup removal completed successfully on website: ${websiteUrl}${statusNote}`
                    : `Popup removal completed successfully; CMS confirmed: ${plan.cmsStatus?.summary || 'Build COMPLETE'}`;
                  progress('build-complete', plan.nextAction, { websiteUrl, cmsStatus: plan.cmsStatus });
                } else {
                  plan.status = 'build-unconfirmed';
                  plan.nextAction = 'Popup removal was verified and CMS Build was started, but completion was not observed. Check CMS before declaring it live.';
                  progress('build-unconfirmed', plan.nextAction, { websiteUrl: plan.website.liveUrl || plan.website.previewUrl || null, cmsStatus: plan.cmsStatus });
                }
              } else {
                plan.status = 'popup-removal-awaiting-build';
                plan.nextAction = 'Popup removal was verified. Rerun with --apply --build to publish the removal.';
              }
            }
          } else if (plan.ticket.popupAction === 'update-duration') {
            plan.status = 'ready-to-update-duration';
            const dur = plan.ticket.popupDuration;
            plan.nextAction = `Ticket yêu cầu chỉnh thời gian popup hiển thị ${dur?.requestedSeconds}s (Time delay slider ${dur?.delaySliderSeconds}s). Rerun với --apply --build để cập nhật và build.`;
            if (applyChanges) {
              plan.safety = buildRequested
                ? 'CMS popup duration update and Build/publish were explicitly requested.'
                : 'CMS popup duration update was explicitly requested. Build/publish was not requested.';
              progress('section-apply', 'Opening the Page editor and Popup settings');
              plan.popupSection = await existingPopupSection(page, baseUrl, {
                expectedPluginVersion: plan.plugin.version
              });
              await openPopupSection(page, plan.popupSection.sectionId);
              await openPopupSettings(page, plan.popupSection.sectionId);
              progress('popup-delay-slider', `Cài đặt Time delay slider: ${dur.delaySliderSeconds}s (thời gian yêu cầu ${dur.requestedSeconds}s + 3s mở popup)`);
              const durationResult = await setTimeDelaySlider(page, dur.delaySliderSeconds);
              if (durationResult.applied !== true) {
                const error = new Error(`Time delay slider was not verified at ${dur.delaySliderSeconds}s (reported value: ${durationResult.value || 'empty'}). CMS Build was not started.`);
                error.stage = 'popup-delay-slider-verification';
                throw error;
              }
              plan.popup = {
                durationConfigured: durationResult.applied !== false,
                requestedSeconds: dur.requestedSeconds,
                delaySliderSeconds: dur.delaySliderSeconds,
                imageConfigured: true,
                ticketPosterVerified: true
              };
              await page.screenshot({ path: path.join(runDir, 'popup-settings.png'), fullPage: false });
              if (buildRequested) {
                progress('build-start', 'Starting CMS Build after verified popup duration update');
                plan.build = await buildWebsite(page, baseUrl, {
                  fallbackDomain: plan.cms?.selectedDomain || null,
                  progress
                });
                plan.website = plan.build.website;
                plan.cmsStatus = plan.build.cmsStatus || null;
                if (plan.build.status === 'success') {
                  const websiteUrl = plan.website.liveUrl || plan.website.previewUrl || null;
                  plan.status = 'popup-live';
                  const statusNote = plan.cmsStatus?.summary ? ` · [${plan.cmsStatus.summary}]` : '';
                  plan.nextAction = websiteUrl
                    ? `Popup duration update completed successfully on website: ${websiteUrl}${statusNote}`
                    : `Popup duration update completed successfully; CMS confirmed: ${plan.cmsStatus?.summary || 'Build COMPLETE'}`;
                  progress('build-complete', plan.nextAction, { websiteUrl, cmsStatus: plan.cmsStatus });
                } else {
                  plan.status = 'build-unconfirmed';
                  plan.nextAction = 'Popup duration was updated and CMS Build was started, but completion was not observed. Check CMS before declaring it live.';
                  progress('build-unconfirmed', plan.nextAction, { websiteUrl: plan.website.liveUrl || plan.website.previewUrl || null, cmsStatus: plan.cmsStatus });
                }
              } else {
                plan.status = 'awaiting-build-approval';
                plan.nextAction = 'Popup duration setting was updated. Rerun with --apply --build to publish.';
              }
            }
          } else {
            progress('timezone-check', 'Reading project address to resolve popup timezone');
            plan.timezone = await discoverProjectTimezone(page, baseUrl, {
              selectedDomain: plan.cms?.selectedDomain,
              website: plan.website,
              ticketText: plan.ticket?.raw
            });

          if (plan.plugin.state === 'missing') {
            plan.status = 'plugin-install-required';
            plan.nextAction = 'Announcement is not installed. Review and approve the plugin installation before creating a popup section.';
          } else if (plan.plugin.state === 'outdated') {
            plan.status = 'plugin-update-required';
            plan.nextAction = 'Announcement has an update available. Review and approve the plugin update before creating a popup section.';
          } else if (!plan.plugin.enabled) {
            plan.status = 'plugin-enable-required';
            plan.nextAction = 'Announcement is installed but disabled. Review and approve enabling it before creating a popup section.';
          } else {
            plan.status = 'ready-to-configure-popup';
            plan.nextAction = 'Announcement is current. The popup section will be found or added in the CMS editor, then the downloaded poster and schedule will be saved before Build.';
          }

          if (applyChanges) {
            // The operator explicitly selected the popup workflow in the UI/--apply.
            // Every requested ticket image is a hard gate: no plugin, section,
            // or popup mutation can begin until all CRM downloads have been
            // validated and staged locally.
            if (!repairExistingPopup && (!downloadedAttachments.length || downloadedAttachments.some((attachment) => !(attachment?.uploadPath || attachment?.path)))) {
              throw new Error('One or more requested posters were not downloaded and verified locally; CMS write mode stopped before any change.');
            }
            const effectiveExpiry = expiryOverride || plan.ticket.expiryDate || null;
            if (plan.ticket.expiry && !effectiveExpiry) {
              throw new Error('Ticket expiry was found but could not be converted automatically to a safe date. Use an ISO date (YYYY-MM-DD) in the ticket.');
            }
            if (plan.ticket.start && !plan.ticket.startDate) {
              throw new Error('Ticket popup start date was found but could not be converted automatically to a safe date. Use an ISO date (YYYY-MM-DD) in the ticket.');
            }
            const popupSchedule = popupScheduleFromTicket(plan.ticket, effectiveExpiry);
            const stagedTicketEntries = repairExistingPopup
              ? []
              : popupTicketEntriesFromDownloads(downloadedAttachments, popupSchedule, visionPosterSchedules);
            plan.ticket.popupItems = stagedTicketEntries.map((entry) => ({
              attachmentIndex: entry.candidateIndex,
              filename: entry.filename,
              startDate: entry.schedule.start?.date || null,
              expiryDate: entry.schedule.end?.date || null
            }));
            plan.safety = buildRequested
              ? 'CMS write mode and Build/publish were explicitly requested.'
              : 'CMS write mode was explicitly requested. Build/publish was not requested.';
            // A project may already have a current plugin but a section made
            // by an older plugin release (for example, ANNOUNCEMENT 1034 with
            // plugin 1.0.38). Inspect the section marker as well as the plugin
            // row, so this stale block is replaced automatically.
            progress('section-version-check', 'Checking whether the Announcement section matches the installed plugin');
            let sectionVersionInfo = { expectedToken: null, sections: [], legacySectionIds: [] };
            try {
              sectionVersionInfo = await inspectAnnouncementSectionVersions(page, baseUrl, plan.plugin.version);
              plan.legacySection = {
                expectedVersion: sectionVersionInfo.expectedToken,
                legacyCount: sectionVersionInfo.legacySectionIds.length
              };
            } catch (error) {
              error.stage = 'section-version-check';
              throw error;
            }
            const pluginStateBeforeApply = plan.plugin.state;
            const mustCreateFreshSection = mustCreateFreshAnnouncementSection({
              pluginStateBeforeApply,
              legacySectionIds: sectionVersionInfo.legacySectionIds
            });
            // Before an old section is removed, save each still-valid item
            // locally so it can be uploaded again into the fresh section. A
            // ticket that explicitly requests removal remains the exception.
            let legacyPopupSnapshot = { sectionIds: [], items: [], expiredCount: 0 };
            let matchingDuplicatePairs = [];
            let removalMatches = [];
            const preserveLegacyPopups = mustCreateFreshSection && plan.ticket.popupAction !== 'remove-all';
            const scanExistingPopupImages = !repairExistingPopup && stagedTicketEntries.length > 0;
            if (preserveLegacyPopups || scanExistingPopupImages) {
              progress(
                preserveLegacyPopups ? 'legacy-popup-snapshot' : 'popup-image-check',
                preserveLegacyPopups
                  ? 'Reading active popups and checking for duplicate ticket images before section replacement'
                  : 'Checking current popup images for a duplicate ticket poster'
              );
              try {
                legacyPopupSnapshot = await snapshotActiveLegacyPopups(page, baseUrl, plan.timezone, runDir, {
                  preserveActive: preserveLegacyPopups
                });
                const removalReferences = (visionCandidateDownloads || []).filter((c) => {
                  const ctx = ticketContext.attachmentCandidates?.find((ac) => ac.index === c.candidateIndex);
                  return ctx?.isRemovalReference === true;
                });
                if (removalReferences.length > 0 && legacyPopupSnapshot.scannedItems.length > 0) {
                  const popupCandidates = legacyPopupSnapshot.scannedItems.map((item, idx) => ({
                    ...item,
                    visionIndex: idx + 1,
                    sectionId: 'cms',
                    itemIndex: idx
                  }));
                  for (const ref of removalReferences) {
                    try {
                      const prepared = preparePopupRemovalVision(ref, popupCandidates);
                      if (prepared.reference && prepared.candidates.length > 0) {
                        const resolution = await resolveTicketPopupRemovalVision(body, prepared.reference, prepared.candidates);
                        if (resolution.selection?.index) {
                          const matchedIdx = resolution.selection.index - 1;
                          removalMatches.push({
                            refIndex: ref.candidateIndex,
                            cmsIndex: matchedIdx,
                            rationale: resolution.selection.rationale,
                            cmsItem: legacyPopupSnapshot.scannedItems[matchedIdx]
                          });
                          progress('legacy-popup-removal-match', `Đã nhận diện popup #${matchedIdx + 1} (${legacyPopupSnapshot.scannedItems[matchedIdx]?.filename || 'popup'}) khớp với ảnh cần gỡ trong ticket`);
                        }
                      }
                    } catch {
                      for (let idx = 0; idx < legacyPopupSnapshot.scannedItems.length; idx += 1) {
                        const direct = findDuplicatePopupImages([ref], [legacyPopupSnapshot.scannedItems[idx]]);
                        if (direct.length > 0) {
                          removalMatches.push({ refIndex: ref.candidateIndex, cmsIndex: idx, cmsItem: legacyPopupSnapshot.scannedItems[idx] });
                        }
                      }
                    }
                  }
                }
                if (preserveLegacyPopups) {
                  if (removalMatches.length > 0 && legacyPopupSnapshot.items.length > 0) {
                    const removedCmsIndices = new Set(removalMatches.map((m) => m.cmsIndex));
                    legacyPopupSnapshot.items = legacyPopupSnapshot.items.filter((item) => {
                      const idx = legacyPopupSnapshot.scannedItems.indexOf(item);
                      return !removedCmsIndices.has(idx);
                    });
                  }
                  writeLegacyPopupSnapshot(runDir, legacyPopupSnapshot);
                  plan.legacyPopups = {
                    sectionCount: legacyPopupSnapshot.sectionIds.length,
                    preservedCount: legacyPopupSnapshot.items.length,
                    expiredCount: legacyPopupSnapshot.expiredCount
                  };
                }
                const duplicates = await findDuplicatePopupImagesWithVision(page, downloadedAttachments, legacyPopupSnapshot.scannedItems);
                if (duplicates.length) {
                  progress(
                    'popup-replace-match',
                    `Phát hiện ảnh đính kèm tương ứng với block ảnh trên CMS (độ tương đồng ${Math.round((duplicates[0].similarity || 1) * 100)}%), tiến hành thay thế ảnh vào block cũ.`
                  );
                  matchingDuplicatePairs = duplicates;
                  plan.ticket.popupAction = 'replace';
                }
                // Historical URL mapping is a compatibility fallback for
                // CMS images that were transformed after upload. It must run
                // here, before plugin, section, timezone, or popup mutations.
                const currentPopupItems = legacyPopupSnapshot.scannedItems.map((item) => ({
                  image: item.sourceImageUrl
                }));
                for (const attachment of downloadedAttachments) {
                  const existing = findTicketPopupInHistory(root, runDir, {
                    siteId: plan.ticket.siteId,
                    ticketUrl,
                    attachment,
                    items: currentPopupItems
                  });
                  if (existing.ambiguous) {
                    const error = new Error(`More than one existing CMS popup may match "${attachment.filename || 'ticket poster'}". CMS was not changed and Build was not started.`);
                    error.stage = 'popup-image-ambiguous';
                    throw error;
                  }
                  if (existing.item && matchingDuplicatePairs.length === 0) {
                    const error = new Error(`Duplicate popup image: "${attachment.filename || 'ticket poster'}" already exists in CMS. The image was not added and CMS Build was not started.`);
                    error.stage = 'popup-image-duplicate';
                    error.duplicateImage = {
                      ticketFilename: attachment.filename || null,
                      cmsImageUrl: existing.item.image || null,
                      method: existing.method || 'history'
                    };
                    throw error;
                  }
                }
              } catch (error) {
                error.stage ||= preserveLegacyPopups ? 'legacy-popup-snapshot' : 'popup-image-check';
                throw error;
              }
            }
            if (repairExistingPopup && mustCreateFreshSection) {
              throw new Error('Popup cleanup only runs on one current Announcement section; plugin or section replacement is required first.');
            }
            progress('plugin-apply', 'Ensuring Announcement is installed, current, and active');
            try {
              plan.plugin = await ensureAnnouncementPlugin(page, baseUrl);
            } catch (error) {
              error.stage = 'plugin-apply';
              throw error;
            }

            // Keep the decision made before the plugin mutation. Some CMS
            // responses report the newly current plugin without retaining an
            // `updated` flag; that must never make us reuse its old section.
            const expectedTokenAfterPlugin = announcementSectionVersionToken(plan.plugin.version);
            const hasLegacySectionNow = sectionVersionInfo.sections.some(
              (section) => !section.marker || (expectedTokenAfterPlugin && section.marker !== expectedTokenAfterPlugin)
            );
            const replaceSectionAfterPluginUpdate = mustCreateFreshAnnouncementSection({
              pluginStateBeforeApply,
              pluginUpdated: plan.plugin.updated,
              legacySectionIds: hasLegacySectionNow ? ['legacy-section'] : sectionVersionInfo.legacySectionIds
            });
            let recoveredMigration = null;
            if (!repairExistingPopup && !replaceSectionAfterPluginUpdate && plan.ticket.popupAction !== 'remove-all') {
              recoveredMigration = recoverInterruptedLegacyMigration(root, {
                siteId: plan.ticket.siteId,
                ticketUrl,
                attachmentFilename: downloadedAttachment.filename,
                timezone: plan.timezone,
                currentRunDir: runDir
              });
              if (recoveredMigration) {
                progress('legacy-popup-recovery', 'Resuming active popup data saved before the interrupted section replacement');
                plan.legacyRecovery = {
                  resumed: true,
                  preservedCount: recoveredMigration.items.length
                };
              }
            }
            const shouldReplaceSection = replaceSectionAfterPluginUpdate || Boolean(recoveredMigration);
            progress(
              'section-apply',
              shouldReplaceSection
                ? 'Replacing the old Annoucement Popup section with the current plugin section'
                : 'Opening the Page editor and adding Annoucement Popup when needed'
            );
            try {
              plan.popupSection = await ensurePopupSection(page, baseUrl, {
                replaceExisting: shouldReplaceSection,
                expectedPluginVersion: plan.plugin.version,
                targetSectionIds: [
                  ...(legacyPopupSnapshot?.sectionIds || []),
                  ...(sectionVersionInfo?.legacySectionIds || []),
                  ...(recoveredMigration ? (sectionVersionInfo?.sections || []).map((s) => s.id).filter(Boolean) : [])
                ]
              });
            } catch (error) {
              error.stage = 'section-apply';
              throw error;
            }

            progress(
              'popup-settings',
              repairExistingPopup
                ? 'Removing the empty popup item and clearing an unrequested start date'
                : `Adding ${stagedTicketEntries.length} ticket poster${stagedTicketEntries.length === 1 ? '' : 's'} to Popup settings`
            );
            try {
              const configuredPopup = await configurePopup(page, downloadedAttachment?.uploadPath || downloadedAttachment?.path || null, popupSchedule, plan.timezone, {
                replaceExisting: plan.ticket.popupAction === 'replace',
                sectionId: plan.popupSection.sectionId,
                legacyPopups: (legacyPopupSnapshot?.items?.length > 0)
                  ? legacyPopupSnapshot.items
                  : (recoveredMigration?.items || []),
                repairOnly: repairExistingPopup,
                ticketFilename: downloadedAttachment?.filename || null,
                ticketEntries: stagedTicketEntries,
                popupPosition: plan.ticket.popupPosition || null,
                duplicateMatches: matchingDuplicatePairs,
                removalMatches: (replaceSectionAfterPluginUpdate || recoveredMigration || legacyPopupSnapshot?.items?.length > 0) ? [] : removalMatches,
                imageLink: plan.ticket.popupLink || null,
                popupDuration: plan.ticket.popupDuration || null
              });
              plan.popup = {
                imageConfigured: configuredPopup.imageConfigured !== false,
                ticketPosterVerified: configuredPopup.ticketPosterVerified === true,
                ticketPosterCount: configuredPopup.ticketPosterCount || stagedTicketEntries.length || 0,
                ticketItems: configuredPopup.ticketItems || [],
                popupPosition: configuredPopup.popupPosition || null,
                positionMoved: configuredPopup.positionMoved === true,
                start: configuredPopup.start,
                expiry: configuredPopup.end,
                timezone: plan.timezone.cmsLabel || plan.timezone.iana,
                cmsLabel: plan.timezone.cmsLabel,
                timezoneIana: plan.timezone.iana,
                timezoneControl: configuredPopup.timezoneControl,
                replaced: configuredPopup.replacement.removed,
                removedPopup: configuredPopup.replacement.previous || null,
                migratedLegacyPopups: configuredPopup.migratedCount,
                ticketMergedWithLegacy: configuredPopup.ticketMergedWithLegacy,
                repaired: configuredPopup.repaired === true,
                removedEmptyItems: configuredPopup.removedEmptyItems || 0,
                clearedStart: configuredPopup.clearedStart === true,
                deduplicated: configuredPopup.deduplicated === true,
                deduplicationMethod: configuredPopup.deduplicationMethod || null,
                cmsImageUrl: configuredPopup.cmsImageUrl || null,
                cmsImageUrls: configuredPopup.cmsImageUrls || (configuredPopup.cmsImageUrl ? [configuredPopup.cmsImageUrl] : []),
                link: plan.ticket.popupLink || null,
                delaySliderSeconds: configuredPopup.delaySliderSeconds || null,
                requestedSeconds: plan.ticket.popupDuration?.requestedSeconds || null,
                durationConfigured: configuredPopup.delaySlider ? configuredPopup.delaySlider.applied !== false : null
              };
            } catch (error) {
              error.stage ||= 'popup-settings';
              throw error;
            }
            const expectedTicketPosterCount = stagedTicketEntries.length;
            if (!repairExistingPopup && (
              !plan.popup?.imageConfigured
              || !plan.popup?.ticketPosterVerified
              || plan.popup.cmsImageUrls.length !== expectedTicketPosterCount
              || plan.popup.ticketPosterCount !== expectedTicketPosterCount
            )) {
              const error = new Error(`All ${expectedTicketPosterCount} ticket poster${expectedTicketPosterCount === 1 ? '' : 's'} were not verified in CMS Popup settings. CMS Build was not started.`);
              error.stage = 'popup-ticket-verification';
              throw error;
            }
            await page.screenshot({ path: path.join(runDir, 'popup-settings.png'), fullPage: false });
            if (buildRequested) {
              progress('build-start', 'Đang bắt đầu Build website');
              plan.build = await buildWebsite(page, baseUrl, {
                fallbackDomain: plan.cms?.selectedDomain || null,
                progress
              });
              plan.website = plan.build.website;
              plan.cmsStatus = plan.build.cmsStatus || null;
              if (plan.build.status === 'success') {
                const websiteUrl = plan.website.liveUrl || plan.website.previewUrl || null;
                plan.popup.published = true;
                plan.status = 'popup-live';
                const statusNote = plan.cmsStatus?.summary ? ` · [${plan.cmsStatus.summary}]` : '';
                plan.nextAction = websiteUrl
                  ? `Popup thành công trên website: ${websiteUrl}${statusNote}`
                  : `Popup thành công. Trạng thái CMS: ${plan.cmsStatus?.summary || 'Build COMPLETE'}`;
                progress('build-complete', plan.nextAction, { websiteUrl, cmsStatus: plan.cmsStatus });
                console.log(`Popup thành công: ${websiteUrl || 'CMS Build confirmed'} ${statusNote}`);
              } else {
                plan.status = 'build-unconfirmed';
                plan.nextAction = 'Popup settings were configured and CMS Build was started, but the tool did not observe a completion signal. Check CMS before declaring the popup live.';
                progress('build-unconfirmed', plan.nextAction, { websiteUrl: plan.website.liveUrl || plan.website.previewUrl || null, cmsStatus: plan.cmsStatus });
              }
            } else {
              plan.status = 'awaiting-build-approval';
              plan.nextAction = 'Popup settings were saved. Rerun with --apply --build to publish the popup.';
            }
          }
        }
      }
    }
    }
  } catch (error) {
    const profileLocked = browserProfileLocked(error);
    const storageUnavailable = error.status === 'run-storage-unavailable';
    plan.status = profileLocked ? 'browser-profile-locked' : (error.stage ? `${error.stage}-failed` : (error.status || 'blocked'));
    plan.error = error.message || String(error);
    if (error.duplicateImage) plan.duplicateImage = error.duplicateImage;
    if (error.vision) plan.removalVision = error.vision;
    if (Array.isArray(error.popupItems)) {
      plan.popupVerification = {
        target: error.stage === 'popup-item-persist' ? 'ticket-popup-item' : null,
        observedItems: error.popupItems
      };
    }
    plan.nextAction = profileLocked
      ? 'Chrome profile của tool đang được một cửa sổ Chrome khác sử dụng. Đóng cửa sổ Chrome của tool, chờ vài giây rồi chạy lại. CMS chưa thay đổi.'
      : storageUnavailable
      ? 'Tool không thể ghi báo cáo cục bộ. Kiểm tra quyền ghi của thư mục tool hoặc mở lại PowerShell bằng tài khoản đang dùng CRM/CMS. CMS chưa thay đổi.'
      : error.stage === 'attachment-download'
      ? `Poster could not be downloaded and validated locally: ${error.message} No CMS change was attempted.`
      : error.stage
      ? `Stopped at ${error.stage}: ${error.message}`
      : error.status === 'build-failed'
      ? 'CMS reported a Build failure. Review the CMS Status page; the tool did not declare the popup live.'
      : 'Run with --headed, sign in inside the tool Chrome window, then rerun the same command.';
    progress(error.stage ? `${error.stage}-failed` : 'failed', plan.error, { status: plan.status });
  } finally {
    if (runDir) {
      reportPath = path.join(runDir, 'plan.json');
      fs.writeFileSync(reportPath, JSON.stringify(plan, null, 2), 'utf8');
    }
    await closeToolBrowser({ browser, context, profileDirectory, cleanupProfile });
  }
  progress('complete', plan.status === 'ready-for-popup-review' ? 'Đã tìm thấy project; sẵn sàng review popup' : `Hoàn tất với trạng thái ${plan.status}`, { status: plan.status });
  if (reportPath) console.log(`Result: ${reportPath}`);
  else console.error(`Fatal: ${plan.nextAction || 'Tool could not create a local report.'}`);
  console.log(`Status: ${plan.status}`);
}
if (require.main === module) {
  main().catch((error) => { console.error(`Fatal: ${error.message}`); process.exitCode = 1; });
}

module.exports = {
  downloadTicketImage,
  downloadTicketCandidateImages,
  validateDownloadedImage,
  cmsSafeUploadFilename,
  stageCmsUploadImage,
  isInlineTicketImageUrl,
  foldTicketText,
  endOfMonthExpiryFromTicket,
  ticketData,
  ticketMarkerPattern,
  normalizeExpiry,
  findTicketDate,
  isPopupRemovalAction,
  popupActionNeedsTicketImage,
  hasMultiPosterIntent,
  resolveRemovalScopeFromAttachments,
  popupScheduleFromTicket,
  popupTicketEntriesFromDownloads,
  applyArtworkSchedulePrecedence,
  shouldUseTicketVision,
  buildPopupEntries,
  buildPopupEntriesForTickets,
  planPopupItemTarget,
  resolveAddedPopupItemTarget,
  verifyPersistedPopupItem,
  resolvePopupItemByImageAndSchedule,
  popupListItemCards,
  popupListItemsPanel,
  waitForPopupListItemsPanel,
  popupListItemEditorIsOpen,
  ensurePopupSection,
  openPageEditor,
  popupSectionCards,
  popupSectionCardById,
  openPopupSection,
  openPopupSettings,
  backToPopupSettings,
  readPopupListItems,
  openPopupListCard,
  collectPopupRemovalCandidates,
  preparePopupRemovalVision,
  attachmentMatchEvidence,
  findTicketPopupInHistory,
  projectDomainsFromText,
  chooseProjectCandidate,
  announcementPluginVersionFromText,
  mustCreateFreshAnnouncementSection,
  extractJsonObject,
  repairWrappedJson,
  usStateFromZip,
  usStateFromAddress,
  resolveTimezoneFromData,
  fetchTimezoneFromWebsite,
  discoverProjectTimezone,
  recoverInterruptedLegacyMigration,
  setPopupImageLink,
  popupImageUploadControl,
  popupImageUrls,
  waitForPopupImageUpload,
  readBuildState,
  readCmsBuildStatus,
  verifyFinalCmsStatus,
  popupItemsForReport
};
