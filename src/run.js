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
  openTicketDetails
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
  findDuplicatePopupImages
} = require('./cms/popup-image-policy');

function progress(stage, message, details = {}) {
  process.stdout.write(`PROGRESS ${JSON.stringify({ stage, message, ...details })}\n`);
}

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
    const artworkSchedule = artworkSchedules.get(candidateIndex) || null;
    // Ticket/comment dates and the explicit CLI expiry override are stronger
    // evidence than poster OCR. Fall back to the validated artwork schedule
    // independently for each missing field, so two posters can have different
    // validity windows without sharing dates accidentally.
    const startDate = schedule?.start?.date || artworkSchedule?.startDate || null;
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
    candidateIndex: attachment.candidateIndex || null
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


async function visibleMatch(locator, description, fromEnd = false) {
  const count = await locator.count();
  const start = fromEnd ? count - 1 : 0;
  const end = fromEnd ? -1 : count;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== end; index += step) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  if (description) throw new Error(`${description} was not found.`);
  return null;
}

async function waitForVisibleMatch(locator, description, fromEnd = false, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const match = await visibleMatch(locator, null, fromEnd);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(`${description || 'Expected CMS control'} was not found.`);
}

async function visibleLabel(page, labelText, fromEnd = false) {
  const labels = page.locator('label');
  const count = await labels.count();
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    if (await label.isVisible().catch(() => false) && (await label.innerText().catch(() => '')).trim() === labelText) matches.push(label);
  }
  const result = fromEnd ? matches.at(-1) : matches[0];
  if (!result) throw new Error(`Visible label "${labelText}" was not found.`);
  return result;
}

async function controlForLabel(page, labelText, fromEnd = false) {
  const label = await visibleLabel(page, labelText, fromEnd);
  const id = await label.getAttribute('for');
  if (!id) throw new Error(`The "${labelText}" control has no associated ID.`);
  const control = page.locator(`[id="${id}"]`);
  const found = await visibleMatch(control, `The "${labelText}" control`, fromEnd);
  return { label, control: found, id };
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
    await button.click({ force: true });
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
      throw new Error(`The visible attachment list changed from ${expectedAttachmentCount} to ${items.length}; Vision did not guess an image.`);
    }
    if (!items.length) throw new Error('No visible image attachment was available for Gemini Vision.');
    const downloads = [];
    for (let index = 0; index < items.length; index += 1) {
      const candidateDir = path.join(assetDir, String(index + 1));
      fs.mkdirSync(candidateDir, { recursive: true });
      const item = items[index];
      let downloadPath;
      if (item.kind === 'inline-image') {
        downloadPath = await downloadInlineTicketImage(page, item, candidateDir, index + 1);
      } else {
        await item.locator.hover({ force: true, timeout: 5000 });
        const button = await visibleMatch(item.locator.locator('button[title="Download file"]'), null, true);
        if (!button) throw new Error(`Attachment #${index + 1} did not expose its Download file control.`);
        downloadPath = await clickAndSaveDownload(page, button, candidateDir);
      }
      downloads.push({
        ...validateDownloadedImage(downloadPath),
        source: item.kind === 'inline-image' ? 'inline-ticket-image' : 'vision-candidate-download',
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
      throw new Error(`The visible attachment list changed from ${expectedAttachmentCount} to ${items.length}; the poster was not guessed.`);
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
      if (selectedItem.kind === 'inline-image') {
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
    if (downloadSource === 'hover-file') return { ...validateDownloadedImage(downloadPath), source: downloadSource, candidateIndex: selectedIndex };
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

async function popupSectionCards(page) {
  const cards = page.locator('div[id^="item_block_section#"]');
  const result = [];
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    if (!await card.isVisible().catch(() => false)) continue;
    const text = (await card.innerText().catch(() => '')).trim();
    if (/(?:^|\n)(?:Annoucement|Announcement) Popup(?:\n|$)/.test(text)) result.push(card);
  }
  return result;
}

async function popupSectionCardById(page, sectionId) {
  const cards = await popupSectionCards(page);
  for (const card of cards) {
    if (await card.getAttribute('id') === sectionId) return card;
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

async function deleteLegacyPopupSections(page) {
  let cards = await popupSectionCards(page);
  let removedCount = 0;
  while (cards.length) {
    const before = cards.length;
    const card = cards.at(-1);
    const menuButton = await visibleMatch(card.locator('button.button-drag'), 'Announcement section menu', true);
    await menuButton.click();
    const menu = await waitForVisibleMatch(page.getByRole('menu'), 'Announcement section menu', true, 3000);
    const remove = await visibleMatch(
      menu.getByRole('menuitem', { name: 'Delete item', exact: true }),
      'Announcement section Delete item control',
      true
    );
    await remove.click();
    const confirm = await waitForVisibleMatch(
      page.getByRole('button', { name: /^(?:Confirm|Delete|Yes)$/i }),
      'Announcement section delete confirmation',
      true,
      1800
    ).catch(() => null);
    if (confirm) await confirm.click();
    await waitForPopupSectionCardCount(page, before - 1);
    removedCount += 1;
    cards = await popupSectionCards(page);
  }
  return removedCount;
}

async function ensurePopupSection(page, baseUrl, { replaceExisting = false, expectedPluginVersion = null } = {}) {
  await openPageEditor(page, baseUrl);
  // This checks the active editor UI only. index.yml is written by CMS Build,
  // so it is not used as a source of truth for the popup workflow.
  const expectedToken = announcementSectionVersionToken(expectedPluginVersion);
  const existing = await popupSectionCards(page);
  let removedCount = 0;
  if (replaceExisting) removedCount = await deleteLegacyPopupSections(page);
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
  return {
    exists: true,
    sectionId: await createdCard.getAttribute('id'),
    created: true,
    replaced: removedCount > 0,
    removedCount
  };
}

async function openPopupSection(page, sectionId = null) {
  // Choosing Announcement Popup from "Add new section" immediately opens a
  // full-screen section editor in current NewZenSite.  In that state the
  // page-editor card is still visible in the DOM but is behind the overlay,
  // so clicking it would time out.  Prefer the already-open editor.
  const alreadyOpen = await waitForVisibleMatch(
    page.getByText('Popup setting', { exact: true }),
    null,
    true,
    1200
  ).catch(() => null);
  if (alreadyOpen) return alreadyOpen;
  if (sectionId) {
    const card = await popupSectionCardById(page, sectionId);
    if (!card) throw new Error(`Announcement section ${sectionId} was not found in the Page editor.`);
    const section = await visibleMatch(card.getByText(/^(?:Annoucement|Announcement) Popup$/), 'Announcement section', true);
    if (!section) throw new Error(`Announcement section ${sectionId} could not be opened.`);
    await section.click();
    await page.waitForTimeout(250);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const settingsCard = await visibleMatch(page.getByText('Popup setting', { exact: true }), null);
    if (settingsCard) return settingsCard;
    const section = await visiblePopupSection(page, null);
    if (section) await section.click();
    await page.waitForTimeout(250);
  }
  throw new Error('Popup section editor did not open after the section was added.');
}

async function openPopupSettings(page, sectionId = null) {
  await openPopupSection(page, sectionId);
  const isAddBlockVisible = async () => page.getByRole('button', { name: 'Add block', exact: true }).isVisible().catch(() => false);
  if (await isAddBlockVisible()) return;

  const popupSetting = await visibleMatch(page.getByText('Popup_setting', { exact: true }), 'Popup setting control');
  await popupSetting.click();

  const appeared = await waitForVisibleMatch(
    page.getByRole('button', { name: 'Add block', exact: true }),
    null,
    true,
    4000
  ).catch(() => null);

  if (!appeared) {
    // If clicking closed an already open accordion or if the transition was delayed,
    // retry clicking Popup_setting once to re-open the panel.
    await popupSetting.click().catch(() => {});
    await waitForVisibleMatch(
      page.getByRole('button', { name: 'Add block', exact: true }),
      'Popup Add block control',
      true,
      8000
    );
  }
}

function expiryAriaLabel(expiry) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(`${expiry}T12:00:00.000Z`));
}

function calendarMonthStart(heading) {
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/.exec(heading);
  if (!match) return null;
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(match[1]);
  return new Date(Date.UTC(Number(match[2]), month, 1, 12));
}

function popupInputValues(type, date, defaultTime) {
  if (type === 'date') return [date];
  if (type === 'datetime-local') return [`${date}T${defaultTime}`];
  return [`${date} ${defaultTime}`, date];
}

async function trySetPopupDateInput(page, control, id, date, defaultTime) {
  const meta = await control.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    type: (element.getAttribute('type') || 'text').toLowerCase(),
    readOnly: Boolean(element.readOnly),
    disabled: Boolean(element.disabled)
  })).catch(() => null);
  if (!meta || meta.tag !== 'input' || meta.readOnly || meta.disabled) return false;
  for (const value of popupInputValues(meta.type, date, defaultTime)) {
    try {
      await control.fill(value);
      await control.press('Tab').catch(() => {});
      const applied = await page.waitForFunction(
        ({ fieldId, expected }) => document.getElementById(fieldId)?.value.includes(expected),
        { fieldId: id, expected: date },
        { timeout: 1500 }
      ).then(() => true).catch(() => false);
      if (applied) return true;
    } catch {
      // Some CMS date inputs are readonly and only expose the calendar.
    }
  }
  return false;
}

async function popupCalendar(page) {
  // This CMS uses VCalendar in two forms: a popover (`vc-date-picker-content`)
  // and an inline calendar inside its own popup (`vc-container`). The latter
  // is what the Announcement list-item editor currently renders.
  const candidates = page.locator('.vc-date-picker-content, .vc-container');
  const count = await candidates.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const title = await visibleMatch(candidate.locator('.vc-header .vc-title'), null, true);
    if (title) return candidate;
  }
  throw new Error('Popup date calendar was not found.');
}

async function calendarHeading(calendar) {
  const title = await visibleMatch(calendar.locator('.vc-header .vc-title'), null, true)
    || await visibleMatch(calendar.locator('.vc-title'), null, true);
  if (title) return (await title.innerText()).trim();
  const header = await visibleMatch(calendar.locator('.vc-header'), 'Popup calendar month', true);
  return (await header.innerText()).trim();
}

async function calendarMoveControl(calendar, forward) {
  const selectors = forward
    ? ['.vc-header .vc-arrow.vc-next', '.vc-header .vc-next', '.vc-arrow.is-right', '[aria-label*="next month" i]', 'button[title*="next month" i]', '.vc-nav-arrow-next']
    : ['.vc-header .vc-arrow.vc-prev', '.vc-header .vc-prev', '.vc-arrow.is-left', '[aria-label*="previous month" i]', '[aria-label*="prev month" i]', 'button[title*="previous month" i]', '.vc-nav-arrow-prev'];
  for (const selector of selectors) {
    const control = await visibleMatch(calendar.locator(selector), null, true);
    if (control && !await control.isDisabled().catch(() => false)) return control;
  }
  const headerButtons = calendar.locator('.vc-header button');
  const count = await headerButtons.count();
  if (count >= 2) {
    const control = forward ? headerButtons.nth(count - 1) : headerButtons.first();
    if (await control.isVisible().catch(() => false) && !await control.isDisabled().catch(() => false)) return control;
  }
  return null;
}

function calendarMonthDistance(heading, date) {
  const visible = calendarMonthStart(heading);
  if (!visible) return null;
  const target = new Date(`${date}T12:00:00.000Z`);
  return ((target.getUTCFullYear() - visible.getUTCFullYear()) * 12)
    + (target.getUTCMonth() - visible.getUTCMonth());
}

async function popupCalendarDay(calendar, date) {
  // VCalendar marks the owning day cell with `id-YYYY-MM-DD`; unlike an
  // accessible name this remains stable across locales and versions. Do not
  // click its faint trailing/leading duplicate in an adjacent month: those
  // cells intentionally intercept pointer events in this CMS.
  const byId = await visibleMatch(
    calendar.locator(`.vc-day.in-month.id-${date} [role="button"]:not([aria-disabled="true"])`),
    null,
    true
  );
  if (byId) return byId;
  return visibleMatch(
    calendar.locator(`.vc-day.in-month [aria-label="${expiryAriaLabel(date)}"][role="button"]:not([aria-disabled="true"])`),
    null,
    true
  );
}

async function waitForCalendarMonthChange(page, calendar, before) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await page.waitForTimeout(100);
    const after = await calendarHeading(calendar).catch(() => null);
    if (after && after !== before) return after;
  }
  throw new Error(`Popup calendar arrow did not change month from ${before}.`);
}

async function setPopupDate(page, labelText, date, defaultTime) {
  const { control, id } = await controlForLabel(page, labelText, true);
  if (await trySetPopupDateInput(page, control, id, date, defaultTime)) return;
  await control.click();
  const calendar = await popupCalendar(page);
  for (let move = 0; move < 25; move += 1) {
    const day = await popupCalendarDay(calendar, date);
    if (day) {
      await day.click();
      await page.waitForFunction(({ fieldId, expected }) => document.getElementById(fieldId)?.value.startsWith(expected), { fieldId: id, expected: date }, { timeout: 5000 });
      return;
    }
    const current = await calendarHeading(calendar);
    const distance = calendarMonthDistance(current, date);
    if (distance === null) throw new Error(`Popup calendar month could not be read: ${current}`);
    if (distance === 0) throw new Error(`${labelText} date ${date} is missing from the visible CMS calendar month.`);
    const forward = distance > 0;
    const arrow = await calendarMoveControl(calendar, forward);
    if (!arrow) throw new Error(`Popup calendar ${forward ? 'next' : 'previous'} month arrow was not found.`);
    await arrow.click({ force: true });
    await waitForCalendarMonthChange(page, calendar, current);
  }
  throw new Error(`${labelText} date ${date} was not available in the calendar.`);
}

function todayInTimezone(iana) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: iana, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function setPopupDateValue(page, label, date, defaultTime) {
  // The popup request is date-based. CMS supplies its own safe default clock
  // value when a calendar day is picked, so avoid the version-dependent hour
  // and minute controls entirely.
  await setPopupDate(page, label, date, defaultTime);
  const { control } = await controlForLabel(page, label, true);
  await page.waitForFunction(({ fieldId, date }) => {
    const value = document.getElementById(fieldId)?.value || '';
    return value.includes(date);
  }, { fieldId: await control.getAttribute('id'), date }, { timeout: 5000 });
  return { date, time: null };
}

async function setPopupStart(page, requestedStart, timezone) {
  const date = requestedStart?.date || todayInTimezone(timezone.iana);
  return setPopupDateValue(page, 'Time start (optional)', date, '00:00');
}

async function setPopupExpiry(page, expiry) {
  return setPopupDateValue(page, 'Time end (optional)', expiry.date, '23:59');
}

async function waitForSaveEnabled(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const save = await visibleMatch(page.getByRole('button', { name: 'Save', exact: true }), null, true);
    if (save && !await save.isDisabled()) return save;
    await page.waitForTimeout(200);
  }
  throw new Error('Popup Save control did not become enabled.');
}

async function readPopupListItems(page) {
  const checkboxes = page.locator('input[type="checkbox"][name^="check-all-list_items-"]');
  const count = await checkboxes.count();
  if (!count) return { chooseAll: null, items: [] };
  const chooseAll = checkboxes.nth(count - 1);
  const name = await chooseAll.getAttribute('name');
  const serialized = name?.slice('check-all-list_items-'.length);
  try {
    const items = JSON.parse(serialized || '[]');
    if (!Array.isArray(items)) throw new Error('not an array');
    return { chooseAll, items };
  } catch {
    const error = new Error('CMS popup item list could not be read safely. No popup was removed.');
    error.stage = 'popup-replacement-ambiguous';
    throw error;
  }
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
  const sectionIds = [];
  const preserved = [];
  const scannedItems = [];
  const warnings = [];
  let expiredCount = 0;
  const assetDir = path.join(runDir, preserveActive ? 'legacy-popup' : 'popup-image-scan');
  fs.mkdirSync(assetDir, { recursive: true });
  for (const card of cards) {
    const sectionId = await card.getAttribute('id');
    if (!sectionId) continue;
    sectionIds.push(sectionId);
    await openPopupSettings(page, sectionId);
    const { items } = await readPopupListItems(page);
    for (const item of items) {
      if (isEmptyPopupItem(item)) continue;
      const start = popupDateFromCmsValue(item?.time_start, timezone);
      const end = popupDateFromCmsValue(item?.time_end, timezone);
      if (item?.time_start && !start && preserveActive) throw new Error(`Could not read the start date of a popup in legacy Announcement section ${sectionId}. Old section was kept.`);
      if (item?.time_end && !end && preserveActive) throw new Error(`Could not read the expiry date of a popup in legacy Announcement section ${sectionId}. Old section was kept.`);
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
        end: end ? { date: end } : null
      };
      scannedItems.push(scanned);
      if (end && end < todayInTimezone(timezone.iana)) {
        expiredCount += 1;
        continue;
      }
      if (preserveActive) preserved.push(scanned);
    }
    // The next legacy card is opened from the page editor, not the nested
    // list-item panel, so return to the editor before selecting it.
    const back = await visibleMatch(page.getByRole('button', { name: /^back$/i }), null, true);
    if (back) await back.click();
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
      end: item.end
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
  const interrupted = records.find(({ plan, modifiedAt }) => (
    modifiedAt >= cutoff
    && plan.cms?.siteId === siteId
    && plan.ticketUrl === ticketUrl
    && plan.popupSection?.replaced === true
    && plan.popupSection?.created === true
    && !plan.popup?.imageConfigured
    && Number(plan.legacyPopups?.preservedCount || 0) > 0
    && /(?:section-apply|popup-settings)-failed$/i.test(plan.status || '')
  ));
  if (!interrupted) return null;
  // Once a later run has successfully configured this same ticket, an older
  // interrupted migration is no longer resumable state. Reusing it would
  // upload the saved poster a second time on an otherwise ordinary retry.
  const laterSuccessfulRun = records.find(({ plan, modifiedAt }) => (
    modifiedAt > interrupted.modifiedAt
    && completedPopupRun(plan)
    && plan.cms?.siteId === siteId
    && plan.ticketUrl === ticketUrl
  ));
  if (laterSuccessfulRun) return null;

  const snapshot = readJsonFile(path.join(interrupted.directory, 'legacy-popup-snapshot.json'));
  let items = [];
  if (Array.isArray(snapshot?.items)) {
    items = snapshot.items.map((item) => ({
      imagePath: path.resolve(interrupted.directory, item.asset || ''),
      filename: item.filename || null,
      sourceImageUrl: item.sourceImageUrl || item.filename || null,
      start: item.start || null,
      end: item.end || null
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
  const matchingRuns = priorRunRecords(root, currentRunDir).filter(({ plan }) => (
    completedPopupRun(plan)
    && plan.popup?.ticketPosterVerified === true
    && plan.cms?.siteId === siteId
    && plan.ticketUrl === ticketUrl
    && attachmentMatchEvidence(plan.attachment, attachment)
  ));
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

async function waitForPopupListItemCount(page, expected) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { items } = await readPopupListItems(page);
    if (items.length === expected) return items;
    await page.waitForTimeout(200);
  }
  throw new Error(`CMS popup list did not reach ${expected} item${expected === 1 ? '' : 's'} after the requested change.`);
}

function planPopupItemTarget(items, { forceNewBlock = false } = {}) {
  const current = Array.isArray(items) ? items : [];
  const firstEmptyIndex = current.findIndex(isEmptyPopupItem);
  // A popup editor always writes into a blank item.  `forceNewBlock` means
  // "do not overwrite a configured legacy popup"; it does *not* mean "add a
  // second placeholder even when the previous run already left one".  That
  // makes a retry idempotent after an interrupted Add block action.
  //
  // Never select a card by its status text: Vue recreates that text during
  // transitions and can point at the preceding legacy card. The CMS
  // serializes list_items in the same order as its draggable cards, so retain
  // the exact array index whenever a blank card already exists.
  if (firstEmptyIndex >= 0) {
    return {
      targetIndex: firstEmptyIndex,
      expectedCount: current.length,
      addBlock: false
    };
  }
  // NewZen may insert a new card at either end of list_items. Its position
  // cannot be predicted from the old count, so resolve it only after reading
  // the post-click serialized list.
  return {
    targetIndex: null,
    expectedCount: current.length + 1,
    addBlock: true
  };
}

function popupItemSignature(item) {
  // Only persistent fields belong in the comparison. IDs and UI-only state
  // vary on every Vue render and would make a valid prepend look ambiguous.
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

function samePopupItemSequence(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => popupItemSignature(item) === popupItemSignature(right[index]));
}

function resolveAddedPopupItemTarget(beforeItems, afterItems) {
  const before = Array.isArray(beforeItems) ? beforeItems : [];
  const after = Array.isArray(afterItems) ? afterItems : [];
  const expectedCount = before.length + 1;
  if (after.length !== expectedCount) {
    return {
      targetIndex: null,
      expectedCount,
      method: null,
      reason: `list-count-${after.length}-expected-${expectedCount}`
    };
  }

  // First prove where the new item was inserted by removing each candidate
  // from the after-list and comparing the remaining serialized values with
  // the before-list. This supports both prepend and append without assuming
  // either UI implementation.
  const insertedIndexes = [];
  for (let index = 0; index < after.length; index += 1) {
    const withoutCandidate = [...after.slice(0, index), ...after.slice(index + 1)];
    if (samePopupItemSequence(withoutCandidate, before)) insertedIndexes.push(index);
  }
  const blankInsertedIndexes = insertedIndexes.filter((index) => isEmptyPopupItem(after[index]));
  if (blankInsertedIndexes.length === 1) {
    return {
      targetIndex: blankInsertedIndexes[0],
      expectedCount,
      method: 'serialized-delta',
      reason: null
    };
  }

  // Some NewZen versions normalize a legacy field while adding a card. In
  // that case the exact delta comparison is no longer stable, but because we
  // only call Add when the before-list had no blanks, one newly blank card is
  // still unambiguous and safe to use.
  const blankIndexes = after
    .map((item, index) => (isEmptyPopupItem(item) ? index : -1))
    .filter((index) => index >= 0);
  if (blankIndexes.length === 1) {
    return {
      targetIndex: blankIndexes[0],
      expectedCount,
      method: 'unique-blank-after-add',
      reason: null
    };
  }
  return {
    targetIndex: null,
    expectedCount,
    method: null,
    reason: blankIndexes.length
      ? `ambiguous-blank-items-${blankIndexes.length}`
      : 'new-item-not-blank'
  };
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
  return { removed: true, previous };
}

async function popupListItemEditorIsOpen(page, timeout = 700) {
  return waitForVisibleMatch(
    page.getByRole('heading', { name: 'List items', exact: true }),
    null,
    true,
    timeout
  ).then(() => true).catch(() => false);
}

async function popupListItemsPanel(page) {
  // The page editor contains many `button-drag` controls (including fields
  // such as Horizontal). Anchor strictly to the `list_items` array field.
  // It is the only one with this serialized checkbox name. When the array is
  // empty the checkbox is absent, so the visible List items label is the
  // narrow fallback. Never fall back to a page-wide card selector.
  const checkAll = await visibleMatch(
    page.locator('input[type="checkbox"][name^="check-all-list_items-"]'),
    null,
    true
  );
  const anchor = checkAll || await visibleMatch(
    page.getByText('List items', { exact: true }),
    'Popup List items label',
    true
  );
  const panel = anchor.locator(
    'xpath=ancestor::div[.//button[normalize-space(.)="Add block"]][1]'
  );
  if (!await panel.isVisible().catch(() => false)) {
    const error = new Error('Popup List items panel was not available. No unrelated CMS field was selected.');
    error.stage = 'popup-item-target';
    throw error;
  }
  return panel;
}

async function waitForPopupListItemsPanel(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const panel = await popupListItemsPanel(page);
      const addBlock = await visibleMatch(
        panel.getByRole('button', { name: 'Add block', exact: true }),
        null,
        true
      );
      if (addBlock) return panel;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(150);
  }
  const error = new Error(`Popup List items panel did not become ready${lastError?.message ? ` (${lastError.message})` : ''}.`);
  error.stage = 'popup-item-target';
  throw error;
}

async function popupListItemCards(page, expectedCount = null) {
  const panel = await popupListItemsPanel(page);
  const dragButtons = panel.locator('button.button-drag');
  const cards = [];
  const count = await dragButtons.count();
  for (let index = 0; index < count; index += 1) {
    const button = dragButtons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    // UCard owns the Vue onClick handler.  An inner flex row can contain the
    // drag button too, but clicking it does not reliably select the item.
    const card = button.locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " relative ") and contains(concat(" ", normalize-space(@class), " "), " cursor-pointer ")][1]'
    );
    if (await card.isVisible().catch(() => false)) cards.push(card);
  }
  if (Number.isInteger(expectedCount) && cards.length !== expectedCount) {
    const error = new Error(`Popup list exposed ${cards.length} cards for ${expectedCount} serialized items. No unrelated CMS field was selected.`);
    error.stage = 'popup-item-target';
    throw error;
  }
  return cards;
}

async function openPopupListCard(page, targetIndex, description, { timeout = 7000, expectedCount = null } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    let card = null;
    try {
      const cards = await popupListItemCards(page, expectedCount);
      card = cards[targetIndex] || null;
    } catch (error) {
      lastError = error;
    }
    if (card) {
      try {
        await card.scrollIntoViewIfNeeded();
        const box = await card.boundingBox();
        if (box && box.width > 8 && box.height > 8) {
          // Click the text body of the card, away from its checkbox and drag
          // menu.  Re-resolve this exact index on every Vue transition.
          const x = Math.min(Math.max(70, Math.floor(box.width * 0.35)), Math.max(8, box.width - 18));
          const y = Math.max(2, Math.min(Math.floor(box.height / 2), box.height - 2));
          await card.click({
            position: { x, y },
            force: true
          }).catch(() => {});
          if (await popupListItemEditorIsOpen(page)) return true;
          await page.mouse.click(box.x + x, box.y + y);
          if (await popupListItemEditorIsOpen(page)) return true;
        }
      } catch (error) {
        lastError = error;
      }
    }
    await page.waitForTimeout(180);
  }
  const suffix = lastError?.message ? ` (${lastError.message})` : '';
  throw new Error(`${description} at popup item ${targetIndex + 1} was not available as a stable popup card${suffix}`);
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
  const sourceHandle = await visibleMatch(sourceCard.locator('button.button-drag'), 'Popup position drag handle', true);
  await sourceCard.scrollIntoViewIfNeeded();
  await destinationCard.scrollIntoViewIfNeeded();
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
      const handleBox = await refreshedSource.locator('button.button-drag').boundingBox();
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

async function openPopupListItem(page, { forceNewBlock = false } = {}) {
  const before = await readPopupListItems(page);
  let target = planPopupItemTarget(before.items, { forceNewBlock });
  let items = before.items;
  if (target.addBlock) {
    const panel = await popupListItemsPanel(page);
    const addBlock = await visibleMatch(
      panel.getByRole('button', { name: 'Add block', exact: true }),
      'Popup Add block control',
      true
    );
    await addBlock.click();
    // CMS sometimes auto-opens the last card, and sometimes leaves the
    // previous card open. Always return to the list then select the exact
    // serialized index; an open editor alone is not proof of its identity.
    if (await popupListItemEditorIsOpen(page, 1000)) await backToPopupSettings(page);
    items = await waitForPopupListItemCount(page, target.expectedCount);
    const resolved = resolveAddedPopupItemTarget(before.items, items);
    if (!Number.isInteger(resolved.targetIndex)) {
      const error = new Error(
        `CMS added a popup item but it was not a uniquely identifiable blank card (${resolved.reason}). `
        + 'The ticket poster and dates were not changed.'
      );
      error.stage = 'popup-item-target';
      error.popupItems = popupItemsForReport(items, { iana: 'UTC' });
      throw error;
    }
    target = {
      ...target,
      targetIndex: resolved.targetIndex,
      expectedCount: resolved.expectedCount,
      targetResolution: resolved.method
    };
  }
  if (!isEmptyPopupItem(items[target.targetIndex])) {
    const error = new Error(
      `Popup item ${target.targetIndex + 1} is not blank before opening it. `
      + 'The ticket poster and dates were not changed.'
    );
    error.stage = 'popup-item-target';
    throw error;
  }
  if (await popupListItemEditorIsOpen(page, 500)) await backToPopupSettings(page);
  await openPopupListCard(page, target.targetIndex, target.addBlock ? 'New popup block' : 'Popup placeholder', {
    expectedCount: target.expectedCount
  });
  return { ...target, beforeItems: before.items };
}

async function configurePopupListItem(page, imagePath, schedule, timezone, { forceNewBlock = false } = {}) {
  const target = await openPopupListItem(page, { forceNewBlock });
  await waitForVisibleMatch(
    page.getByRole('heading', { name: 'List items', exact: true }),
    'Popup list item editor',
    true,
    5000
  );

  const imageLabel = await visibleLabel(page, 'Image', true);
  const imagePanel = imageLabel.locator('xpath=ancestor::div[3]');
  const imageInput = imagePanel.locator('input[type="file"]');
  const previousImageUrls = await imagePanel.locator('img').evaluateAll((images) => images
    .map((image) => image.src)
    .filter((source) => source && !/\/images\/download\.png(?:$|\?)/.test(source))
  ).catch(() => []);
  if (previousImageUrls.length > 0) {
    const error = new Error(`Popup item ${target.targetIndex + 1} unexpectedly contains an existing image. The ticket poster was not uploaded.`);
    error.stage = 'popup-item-target';
    throw error;
  }
  // A missing start date means "show now" in the CMS.  Do not invent a
  // calendar date: only a date written in the ticket is allowed to populate
  // Time start. The blank-card assertion above happens first so a stale
  // editor can never alter a legacy popup's dates.
  const start = schedule.start ? await setPopupStart(page, schedule.start, timezone) : null;
  const end = schedule.end ? await setPopupExpiry(page, schedule.end) : null;
  await imageInput.setInputFiles(imagePath);
  await page.waitForFunction((before) => {
    const labels = [...document.querySelectorAll('label')].filter((label) => {
      const rect = label.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && label.textContent.trim() === 'Image';
    });
    let panel = labels.at(-1);
    for (let step = 0; panel && step < 3; step += 1) panel = panel.parentElement;
    const current = [...(panel?.querySelectorAll('img') || [])]
      .map((image) => image.src)
      .filter((source) => source && !/\/images\/download\.png(?:$|\?)/.test(source));
    // An existing legacy image must not be mistaken for a newly uploaded
    // ticket poster. A blank item accepts its first image; an occupied item
    // must visibly receive a different media URL.
    return before.length === 0 ? current.length > 0 : current.some((source) => !before.includes(source));
  }, previousImageUrls, { timeout: 30000 });
  const currentImageUrls = await imagePanel.locator('img').evaluateAll((images) => images
    .map((image) => image.src)
    .filter((source) => source && !/\/images\/download\.png(?:$|\?)/.test(source))
  ).catch(() => []);
  const uploadedImageUrl = previousImageUrls.length === 0
    ? currentImageUrls.at(-1) || null
    : currentImageUrls.find((source) => !previousImageUrls.includes(source)) || null;
  if (!uploadedImageUrl) throw new Error('CMS did not expose a new image URL after the ticket poster upload.');

  // List item changes are kept by the CMS as the fields/upload change. The
  // only explicit Save belongs to the outer Timezone panel and was clicked
  // before opening Popup settings. Do not close the editor or wait for a
  // nonexistent popup Save: Build is the global control at the top-right.
  await page.waitForTimeout(800);
  return {
    ...target,
    start: start?.date || null,
    end: end?.date || null,
    previewImageUrl: uploadedImageUrl
  };
}

async function backToPopupSettings(page) {
  const back = await visibleMatch(page.getByRole('button', { name: /^back$/i }), 'Popup item Back control', true);
  if (!back) throw new Error('Could not return from the popup item editor to Popup settings.');
  await back.click();
  await waitForPopupListItemsPanel(page);
  await page.waitForTimeout(150);
}

async function returnToPageEditor(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const contentBlocks = await visibleMatch(page.getByText('Content blocks', { exact: true }), null, true);
    if (contentBlocks) return;
    const back = await visibleMatch(page.getByRole('button', { name: /^back$/i }), null, true);
    if (!back) break;
    await back.click();
    await page.waitForTimeout(250);
  }
  await waitForVisibleMatch(page.getByText('Content blocks', { exact: true }), 'Page editor after popup action', true, 5000);
}

async function collectPopupRemovalCandidates(page, baseUrl, runDir) {
  await openPageEditor(page, baseUrl);
  const cards = await popupSectionCards(page);
  const assetDir = path.join(runDir, 'popup-removal-candidates');
  fs.mkdirSync(assetDir, { recursive: true });
  const items = [];
  let visionIndex = 1;
  for (const card of cards) {
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
    await returnToPageEditor(page);
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

async function removePopupForTicket(page, baseUrl, runDir, ticketText, action, referenceImage) {
  if (action === 'remove-all') {
    progress('popup-removal-all', 'Removing every current popup item requested by the ticket');
    return { scope: 'all', ...(await removeAllPopupItems(page, baseUrl)), vision: null };
  }
  if (action !== 'remove-one' || !referenceImage?.path) {
    const error = new Error('A remove-one popup ticket needs one locally downloaded reference image from CRM.');
    error.stage = 'popup-removal-ambiguous';
    throw error;
  }
  progress('popup-removal-scan', 'Downloading current CMS popup images for Gemini Vision comparison');
  const available = await collectPopupRemovalCandidates(page, baseUrl, runDir);
  if (!available.items.length) {
    const error = new Error('No configured CMS popup image exists that matches the ticket image. Nothing was removed and CMS Build was not started.');
    error.stage = 'popup-removal-not-found';
    throw error;
  }
  const prepared = preparePopupRemovalVision(referenceImage, available.items);
  if (!prepared.reference || !prepared.candidates.length || prepared.complete !== true || prepared.candidates.length !== available.items.length) {
    const error = new Error(prepared.warnings.join(' ') || 'CMS popup images could not be prepared for Gemini Vision comparison.');
    error.stage = 'popup-removal-ambiguous';
    throw error;
  }
  progress('popup-removal-vision', 'Gemini Vision is matching the ticket image to the current CMS popup');
  const resolution = await resolveTicketPopupRemovalVision(ticketText, prepared.reference, prepared.candidates);
  if (!resolution.selection) {
    const notFound = resolution.audit?.status === 'not-found';
    const error = new Error(notFound
      ? 'No current CMS popup matches the ticket image. No popup was removed and CMS Build was not started.'
      : 'The tool could not identify one unique CMS popup matching the ticket image. No popup was removed and CMS Build was not started.');
    error.stage = notFound ? 'popup-removal-not-found' : 'popup-removal-ambiguous';
    error.vision = resolution.audit;
    throw error;
  }
  const target = available.items.find((item) => item.visionIndex === resolution.selection.index);
  if (!target) {
    const error = new Error('Gemini Vision selected a CMS popup that was not in the local candidate set. No popup was removed.');
    error.stage = 'popup-removal-ambiguous';
    throw error;
  }
  progress('popup-removal-apply', 'Removing the uniquely Gemini-matched popup from CMS');
  const removal = await removeOnePopupItem(page, baseUrl, target);
  return { scope: 'one', ...removal, vision: resolution.audit, visionRationale: resolution.selection.rationale, warnings: prepared.warnings };
}

async function waitForPersistedPopupItem(page, target, schedule, timezone) {
  let lastItems = [];
  let lastReason = 'not-observed';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const { items } = await readPopupListItems(page);
      lastItems = items;
      const verification = verifyPersistedPopupItem({
        afterItems: items,
        targetIndex: target.targetIndex,
        expectedCount: target.expectedCount,
        schedule,
        timezone
      });
      lastReason = verification.reason || 'not-persisted';
      if (verification.ok) {
        // Use the serialized CMS URL, never the temporary image preview from
        // the nested editor. This ties the ticket poster to the exact card
        // that will be present at Build time.
        return {
          ...target,
          item: verification.item,
          imageUrl: verification.item.image
        };
      }
    } catch (error) {
      lastReason = error?.message || 'popup-list-unavailable';
    }
    await page.waitForTimeout(250);
  }
  const error = new Error(
    `Popup item ${target.targetIndex + 1} did not persist its ticket poster and dates (${lastReason}). CMS Build was not started.`
  );
  error.stage = 'popup-item-persist';
  error.popupItems = popupItemsForReport(lastItems, timezone);
  throw error;
}

function isEmptyPopupItem(item) {
  return ['time_start', 'time_end', 'image', 'image_alt', 'link', 'html_code']
    .every((key) => !String(item?.[key] || '').trim());
}

async function openConfiguredPopupListItem(page, imageUrl = null) {
  const { items } = await readPopupListItems(page);
  const configuredIndexes = items
    .map((item, index) => (String(item?.image || '').trim() ? index : -1))
    .filter((index) => index >= 0);
  let targetIndex = -1;
  if (imageUrl) {
    const expected = stableImageUrl(imageUrl);
    const matches = configuredIndexes.filter((index) => stableImageUrl(items[index].image) === expected);
    if (matches.length !== 1) {
      const error = new Error(`Configured popup image could not be matched to exactly one CMS card (found ${matches.length}).`);
      error.stage = 'popup-item-target';
      throw error;
    }
    targetIndex = matches[0];
  } else if (configuredIndexes.length === 1) {
    targetIndex = configuredIndexes[0];
  } else {
    const error = new Error(`Configured popup target is ambiguous (${configuredIndexes.length} configured cards).`);
    error.stage = 'popup-item-target';
    throw error;
  }
  await openPopupListCard(page, targetIndex, 'Configured popup item');
}

async function clearPopupStartDate(page) {
  const { control, id } = await controlForLabel(page, 'Time start (optional)', true);
  const existing = await control.inputValue().catch(() => '');
  if (!existing) return false;
  await control.click();
  const calendar = await popupCalendar(page);
  const clear = await visibleMatch(calendar.getByText('Clear', { exact: true }), 'Popup start Clear control', true);
  await clear.click();
  await page.waitForFunction((fieldId) => !(document.getElementById(fieldId)?.value || '').trim(), id, { timeout: 5000 });
  return true;
}

async function deletePopupItemAtIndex(page, targetIndex, expectedRemaining, description = 'Popup item') {
  const { items } = await readPopupListItems(page);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= items.length) {
    throw new Error(`${description} was not found in the CMS list.`);
  }
  const card = (await popupListItemCards(page, items.length))[targetIndex] || null;
  if (!card) throw new Error(`${description} was not found as a stable popup card.`);
  const menuButton = await visibleMatch(card.locator('button.button-drag'), `${description} menu`, true);
  await menuButton.click();
  const menu = await waitForVisibleMatch(page.getByRole('menu'), `${description} menu`, true, 3000);
  const remove = await visibleMatch(
    menu.getByRole('menuitem', { name: 'Delete item', exact: true }),
    `${description} Delete item control`,
    true
  );
  await remove.click();
  const confirm = await waitForVisibleMatch(
    page.getByRole('button', { name: /^(?:Confirm|Delete|Yes)$/i }),
    `${description} delete confirmation`,
    true,
    3000
  ).catch(() => null);
  if (confirm) await confirm.click();
  await waitForPopupListItemCount(page, expectedRemaining);
}

async function deleteOneEmptyPopupItem(page, expectedRemaining) {
  const { items } = await readPopupListItems(page);
  const targetIndex = items.findIndex(isEmptyPopupItem);
  if (targetIndex < 0) throw new Error('Empty popup item was not found in the CMS list.');
  return deletePopupItemAtIndex(page, targetIndex, expectedRemaining, 'Empty popup item');
}

async function repairExistingPopupSettings(page, schedule, timezone) {
  const before = await readPopupListItems(page);
  const emptyItems = before.items.filter(isEmptyPopupItem);
  const configuredItems = before.items.filter((item) => !isEmptyPopupItem(item));
  // Repair mode is intentionally limited to the precise state this tool
  // created by mistake: one empty placeholder plus one configured popup.
  // Anything else must be reviewed rather than guessed at.
  if (emptyItems.length !== 1 || configuredItems.length !== 1) {
    throw new Error(`Popup cleanup is ambiguous: expected one empty item and one configured popup, found ${emptyItems.length} empty and ${configuredItems.length} configured.`);
  }
  if (schedule.start) {
    throw new Error('Popup cleanup does not clear Time start because this ticket explicitly includes a start date.');
  }
  const configured = configuredItems[0];
  const existingEnd = popupDateFromCmsValue(configured.time_end, timezone);
  if (schedule.end?.date && existingEnd !== schedule.end.date) {
    throw new Error(`Popup cleanup stopped: the configured popup expires ${existingEnd || 'without a date'}, not the ticket date ${schedule.end.date}.`);
  }
  const existingStart = popupDateFromCmsValue(configured.time_start, timezone);
  if (existingStart) {
    await openConfiguredPopupListItem(page);
    await clearPopupStartDate(page);
    await backToPopupSettings(page);
  }
  await deleteOneEmptyPopupItem(page, configuredItems.length);
  return {
    imageConfigured: true,
    start: null,
    end: existingEnd,
    removedEmptyItems: emptyItems.length,
    clearedStart: Boolean(existingStart),
    repaired: true,
    replacement: { removed: false, previous: null },
    migratedCount: 0,
    ticketMergedWithLegacy: false,
    timezoneControl: { applied: false, supported: false }
  };
}

function normalizeTicketPopupEntries(ticketEntries, imagePath, schedule, ticketFilename = null) {
  const supplied = Array.isArray(ticketEntries) && ticketEntries.length
    ? ticketEntries
    : [{ imagePath, schedule, filename: ticketFilename }];
  const usedIndexes = new Set();
  return supplied.map((entry, index) => {
    const ticketIndex = Number.isInteger(entry?.ticketIndex) ? entry.ticketIndex : index;
    const entryImagePath = entry?.imagePath || null;
    if (!entryImagePath) throw new Error(`Ticket popup poster ${index + 1} has no local image path.`);
    if (usedIndexes.has(ticketIndex)) throw new Error(`Ticket popup poster index ${ticketIndex + 1} is duplicated.`);
    usedIndexes.add(ticketIndex);
    return {
      ticketIndex,
      candidateIndex: Number.isInteger(entry?.candidateIndex) ? entry.candidateIndex : null,
      imagePath: entryImagePath,
      filename: entry?.filename || ticketFilename || path.basename(entryImagePath),
      schedule: {
        start: entry?.schedule?.start?.date ? { date: entry.schedule.start.date } : null,
        end: entry?.schedule?.end?.date ? { date: entry.schedule.end.date } : null
      }
    };
  });
}

function buildPopupEntriesForTickets(ticketEntries, legacyPopups = []) {
  const normalizedTickets = Array.isArray(ticketEntries) ? ticketEntries : [];
  const matchedTicketIndexes = new Set();
  const matchingLegacyIndexes = [];
  const entries = legacyPopups.map((legacy, legacyIndex) => {
    const legacyIdentity = popupImageIdentity(legacy?.sourceImageUrl);
    const ticket = legacyIdentity
      ? normalizedTickets.find((candidate) => (
        !matchedTicketIndexes.has(candidate.ticketIndex)
        && popupImageIdentity(candidate.filename || path.basename(candidate.imagePath)) === legacyIdentity
      ))
      : null;
    if (ticket) {
      matchedTicketIndexes.add(ticket.ticketIndex);
      matchingLegacyIndexes.push(legacyIndex);
      return {
        imagePath: legacy.imagePath,
        // An old active popup is retained for its poster and expiry. The new
        // section must not introduce a start date unless this ticket gave one.
        schedule: { start: ticket.schedule.start || null, end: ticket.schedule.end || legacy.end },
        isTicket: true,
        ticketIndexes: [ticket.ticketIndex]
      };
    }
    return {
      imagePath: legacy.imagePath,
      schedule: { start: null, end: legacy.end },
      isTicket: false,
      ticketIndexes: []
    };
  });
  for (const ticket of normalizedTickets) {
    if (matchedTicketIndexes.has(ticket.ticketIndex)) continue;
    entries.push({
      imagePath: ticket.imagePath,
      schedule: ticket.schedule,
      isTicket: true,
      ticketIndexes: [ticket.ticketIndex]
    });
  }
  return {
    entries,
    matchingLegacyIndex: matchingLegacyIndexes[0] ?? -1,
    matchingLegacyIndexes
  };
}

// Compatibility wrapper for the established one-poster unit tests and call
// sites. The actual CMS writer accepts an array through `ticketEntries`.
function buildPopupEntries(imagePath, schedule, legacyPopups, { ticketFilename = null } = {}) {
  const tickets = normalizeTicketPopupEntries(null, imagePath, schedule, ticketFilename);
  return buildPopupEntriesForTickets(tickets, legacyPopups);
}

async function configurePopup(page, imagePath, schedule, timezone, {
  replaceExisting = false,
  sectionId = null,
  legacyPopups = [],
  repairOnly = false,
  ticketFilename = null,
  ticketEntries = null,
  popupPosition = null
} = {}) {
  await openPopupSection(page, sectionId);
  const timezoneControl = await setPopupTimezone(page, timezone);
  await openPopupSettings(page, sectionId);
  if (repairOnly) {
    const repaired = await repairExistingPopupSettings(page, schedule, timezone);
    return { ...repaired, timezoneControl };
  }
  const normalizedTicketEntries = normalizeTicketPopupEntries(ticketEntries, imagePath, schedule, ticketFilename);
  const before = await readPopupListItems(page);
  const replacement = replaceExisting ? await removeSingleExistingPopup(page) : { removed: false, previous: null };
  const { entries, matchingLegacyIndex, matchingLegacyIndexes } = buildPopupEntriesForTickets(normalizedTicketEntries, legacyPopups);
  const emptyItemsBefore = before.items.filter(isEmptyPopupItem);
  const configuredItemsBefore = before.items.filter((item) => !isEmptyPopupItem(item));
  const hasReusablePlaceholder = emptyItemsBefore.length > 0;
  const ticketItems = new Map();
  let lastConfiguredItem = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const configured = await configurePopupListItem(page, entry.imagePath, entry.schedule, timezone, {
      // The first item uses NewZen's existing "Not configured" placeholder.
      // Additional migrated popups require a genuine new block. If an older
      // current section already has an active item but no empty placeholder,
      // preserve it and add a real block for this ticket instead of replacing
      // the legacy poster.
      forceNewBlock: index > 0 || (index === 0 && configuredItemsBefore.length > 0 && !hasReusablePlaceholder)
    });
    await backToPopupSettings(page);
    // A preview inside the nested editor is not a save acknowledgement. Wait
    // until the outer Popup settings model contains this exact target card,
    // including the requested dates, before moving to the next item or Build.
    const item = await waitForPersistedPopupItem(page, configured, entry.schedule, timezone);
    lastConfiguredItem = item;
    for (const ticketIndex of entry.ticketIndexes || []) ticketItems.set(ticketIndex, item);
  }
  let positionResult = { applied: false, moved: false };
  if ((popupPosition === 'first' || popupPosition === 'last') && ticketItems.size) {
    const ticketImageUrls = normalizedTicketEntries
      .map((ticket) => ticketItems.get(ticket.ticketIndex)?.imageUrl || null)
      .filter(Boolean);
    progress('popup-position', `Moving ticket popup image${ticketImageUrls.length === 1 ? '' : 's'} to the requested ${popupPosition} position`);
    positionResult = await movePopupImagesToPosition(page, ticketImageUrls, popupPosition);
  }
  const after = await readPopupListItems(page);
  // The last exact target is the authoritative count.  This also handles a
  // replacement ticket, where the original single popup was intentionally
  // removed before adding the new one.
  const expectedItemCount = lastConfiguredItem?.expectedCount ?? after.items.length;
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
  return {
    imageConfigured: true,
    ticketPosterVerified: true,
    start: verifiedTicketItems[0]?.start || null,
    end: verifiedTicketItems[0]?.end || null,
    ticketItems: verifiedTicketItems,
    replacement,
    migratedCount: legacyPopups.length,
    ticketMergedWithLegacy: matchingLegacyIndexes.length > 0 || matchingLegacyIndex >= 0,
    deduplicated: false,
    deduplicationMethod: null,
    cmsImageUrl: ticketCmsImageUrls[0] || null,
    cmsImageUrls: ticketCmsImageUrls,
    ticketPosterCount: normalizedTicketEntries.length,
    popupPosition: positionResult.applied ? popupPosition : null,
    positionMoved: positionResult.moved,
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
  const success = current.match(/(?:build|publish|deploy).{0,100}(?:success(?:ful(?:ly)?)?|completed|complete|finished)|(?:success(?:ful(?:ly)?)?|completed|complete|finished).{0,100}(?:build|publish|deploy)|(?:build|xuất bản).{0,100}thành công|thành công.{0,100}(?:build|xuất bản)/i)?.[0] || null;
  const failure = current.match(/(?:build|publish|deploy).{0,100}(?:failed|failure|error|cancelled|canceled)|(?:failed|failure|error|cancelled|canceled).{0,100}(?:build|publish|deploy)|(?:build|xuất bản).{0,100}(?:lỗi|thất bại)|(?:lỗi|thất bại).{0,100}(?:build|xuất bản)/i)?.[0] || null;
  return {
    percent: values.length ? Math.max(...values) : null,
    success: success && !before.toLowerCase().includes(success.toLowerCase()) ? success : null,
    failure: failure && !before.toLowerCase().includes(failure.toLowerCase()) ? failure : null
  };
}

async function readCmsBuildStatus(page, projectId) {
  if (!projectId) return { ok: false, statusBuild: null, logIdLast: null };
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
        logIdLast: project?.log_id_last ?? project?.logIdLast ?? null
      };
    }, projectId);
  } catch {
    return { ok: false, statusBuild: null, logIdLast: null };
  }
}

async function buildWebsite(page, baseUrl) {
  const projectId = baseUrl.match(/\/projects\/(\d+)/)?.[1] || null;
  const buildControl = page.getByRole('button', { name: /^Build(?:\.\.\.)?$/i });
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
  await buildButton.click();
  // NewZen may present a confirmation immediately after Build. Confirming
  // "Save all" commits the pending editor changes before its build queue
  // starts. Some CMS versions start the queue directly, so this is optional.
  const saveAll = await waitForVisibleMatch(
    page.getByRole('button', { name: /^Save all(?: changes)?$/i }),
    'CMS Save all confirmation',
    true,
    5000
  ).catch(() => null);
  if (saveAll) {
    progress('build-save-all', 'Đang Save all thay đổi trước khi Build');
    await saveAll.click();
    // The CMS follows Save all with a final confirmation before queuing the
    // build. Confirm it when that dialog is present.
    const confirm = await waitForVisibleMatch(
      page.getByRole('button', { name: /^Confirm(?: build)?$/i }),
      'CMS Build confirmation',
      true,
      5000
    ).catch(() => null);
    if (confirm) {
      progress('build-confirm', 'Đang xác nhận Build');
      await confirm.click();
    }
    await page.waitForTimeout(500);
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
        if (statusBuild === 1 && (sawCmsProcessing || (sawNewCmsLog && sawBuildProgress))) {
          return {
            status: 'success',
            website: await websiteInfo(page, baseUrl),
            evidence: 'CMS reported status_build=COMPLETE.',
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
      return {
        status: 'success',
        website: await websiteInfo(page, baseUrl),
        evidence: state.success || 'CMS reported 100% Build progress.',
        completedAt: new Date().toISOString(),
        progress: highest
      };
    }
    await page.waitForTimeout(1000);
  }
  return {
    status: 'unconfirmed',
    website: await websiteInfo(page, baseUrl),
    evidence: null,
    completedAt: null,
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

function usStateFromAddress(address) {
  const text = String(address || '');
  const code = /\b([A-Za-z]{2})\s+\d{5}(?:-\d{4})?\b/.exec(text)?.[1]?.toUpperCase() || null;
  if (code && US_TIMEZONE_BY_STATE[code]) return code;
  const names = Object.entries(US_STATE_CODES_BY_NAME).sort(([left], [right]) => right.length - left.length);
  for (const [name, stateCode] of names) {
    const pattern = new RegExp(`\\b${escapePattern(name)}\\b(?=\\s+\\d{5}(?:-\\d{4})?\\b)`, 'i');
    if (pattern.test(text)) return stateCode;
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
  const strings = flattenStrings(data).map((item) => item.replace(/<br\s*\/?>/gi, ', ').replace(/\s+/g, ' ').trim());
  // Media filenames often contain five digits (for example
  // `footer-preview-57321.webp`). Only accept a string as an address after
  // it also yields a valid US state before the ZIP code.
  const address = strings.find((item) => Boolean(usStateFromAddress(item))) || null;
  const state = usStateFromAddress(address);
  const mapped = state ? US_TIMEZONE_BY_STATE[state] : null;
  return mapped ? { address, state, iana: mapped[0], cmsLabel: mapped[1], source: 'data/setting.json' } : { address, state, iana: null, cmsLabel: null, source: null };
}

async function readProjectDataFile(page, baseUrl, filename) {
  await page.goto(`${baseUrl}/files`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  const dataFolder = await waitForVisibleMatch(page.getByText('data', { exact: true }), 'data folder', true, 15000);
  await dataFolder.click();
  const file = await waitForVisibleMatch(page.getByText(filename, { exact: true }), 'project data file', true, 10000).catch(() => null);
  if (!file) return null;
  await file.click();
  await page.waitForTimeout(1000);
  const body = await page.locator('body').innerText();
  const marker = body.lastIndexOf(filename);
  const raw = extractJsonObject(marker >= 0 ? body.slice(marker) : body);
  try { return JSON.parse(repairWrappedJson(raw)); } catch { return null; }
}

async function discoverProjectTimezone(page, baseUrl) {
  let fallback = { address: null, iana: null, cmsLabel: null, source: null };
  for (const filename of ['setting.json', 'settings.json', 'footer.json']) {
    // A project may omit a data file, or the Files view may briefly fail while
    // loading it.  Timezone discovery must not make the whole popup job stop:
    // try the remaining sources and eventually use the agreed US default.
    let data = null;
    try {
      data = await readProjectDataFile(page, baseUrl, filename);
    } catch {
      continue;
    }
    if (!data) continue;
    const timezone = { ...resolveTimezoneFromData(data), source: `data/${filename}` };
    if (timezone.address) fallback = timezone;
    if (timezone.iana) return timezone;
  }
  if (fallback.iana) return fallback;
  // The workflow is date-based and the user requested that it continue
  // without a manual timezone confirmation. Use the national default only
  // after every supported project data file has been checked.
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
  const label = await visibleLabel(page, 'Timezone', true).catch(() => null);
  if (!label) return { applied: false, supported: false };
  const id = await label.getAttribute('for');
  if (!id) throw new Error('The "Timezone" control has no associated ID.');
  const control = await visibleMatch(page.locator(`[id="${id}"]`), 'The "Timezone" control', true);
  if (!control) throw new Error('The "Timezone" control was not found.');
  if ((await control.innerText()).trim() === timezone.cmsLabel) return { applied: false, supported: true };
  await control.click();
  const search = await visibleMatch(page.locator('input[placeholder="Search timezone..."]'), 'Timezone search', true);
  await search.fill(timezone.cmsLabel.split(' (')[0]);
  const option = await visibleMatch(page.getByText(timezone.cmsLabel, { exact: true }), 'Timezone option', true);
  await option.click();
  await page.waitForFunction(({ fieldId, label }) => document.getElementById(fieldId)?.innerText.trim() === label, { fieldId: id, label: timezone.cmsLabel }, { timeout: 5000 });
  // Timezone is a project setting. Commit it before interacting with any date
  // picker so NewZen serializes start/end values in the intended timezone.
  const save = await waitForSaveEnabled(page);
  await save.click();
  await page.waitForTimeout(600);
  return { applied: true, supported: true };
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
    await page.screenshot({ path: path.join(runDir, 'ticket.png'), fullPage: true });
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
        || await allAttachmentsDownloadButton(ticketContext.root).isVisible().catch(() => false)
      );
      plan.ticket.attachmentCount = ticketContext.attachmentCandidates.length;
      plan.ticket = resolveRemovalScopeFromAttachments(plan.ticket, ticketContext.attachmentCandidates);
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
        const actionNeedsTicketImage = popupActionNeedsTicketImage(plan.ticket.popupAction);
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
            const preparedVision = visionCandidatesFromDownloads(visionCandidateDownloads, ticketContext.attachmentCandidates);
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
            const textSelection = plan.ticket.popupAttachmentIndex || null;
            if (textSelection && !visionResolution.selection.indices.includes(textSelection)) {
              const error = new Error(`Gemini text selected attachment #${textSelection}, but the verified Vision poster set does not contain it. The poster set was not guessed.`);
              error.stage = 'attachment-selection';
              throw error;
            }
            plan.ticket.popupAttachmentIndexes = visionResolution.selection.indices;
            plan.ticket.popupAttachmentSelection = 'gemini-vision-set';
            visionPosterSchedules = visionResolution.selection.posterSchedules || [];
            plan.ticket.popupVisionSchedules = visionPosterSchedules;
            attachmentDecision = attachmentPlanForTicket({
              popupAction: plan.ticket.popupAction,
              attachmentCount: ticketContext.attachmentCandidates.length,
              popupAttachmentIndexes: plan.ticket.popupAttachmentIndexes
            });
            plan.attachmentPlan = attachmentDecision;
            downloadedAttachments = visionResolution.selection.indices.map((candidateIndex) => (
              visionCandidateDownloads.find((candidate) => candidate.candidateIndex === candidateIndex) || null
            ));
            if (downloadedAttachments.some((attachment) => !attachment) || downloadedAttachments.length !== visionResolution.selection.indices.length) {
              const error = new Error('Gemini Vision selected a poster that was not present in the locally downloaded ticket images.');
              error.stage = 'attachment-selection';
              throw error;
            }
            if (applyChanges) {
              try {
                downloadedAttachments = downloadedAttachments.map((attachment) => stageCmsUploadImage(attachment, runDir));
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
              const preparedVision = visionCandidatesFromDownloads(visionCandidateDownloads, ticketContext.attachmentCandidates);
              if (preparedVision.candidates.length) {
                progress('ticket-vision', 'Using Gemini Vision to verify the requested popup poster');
                const visionResolution = await resolveTicketVision(body, preparedVision.candidates);
                plan.vision = {
                  ...visionResolution.audit,
                  warnings: [...preparedVision.warnings, ...(visionResolution.audit.warnings || [])]
                };
                if (visionResolution.selection) {
                  const textSelection = plan.ticket.popupAttachmentIndex || null;
                  if (textSelection && textSelection !== visionResolution.selection.index) {
                    const error = new Error(`Gemini text selected attachment #${textSelection}, while Gemini Vision selected #${visionResolution.selection.index}. The poster was not guessed.`);
                    error.stage = 'attachment-selection';
                    throw error;
                  }
                  plan.ticket.popupAttachmentIndex = visionResolution.selection.index;
                  plan.ticket.popupAttachmentSelection = 'gemini-vision';
                  visionPosterSchedules = visionResolution.selection.posterSchedules || [];
                  plan.ticket.popupVisionSchedules = visionPosterSchedules;
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
              downloadedAttachment = stageCmsUploadImage(downloadedAttachment, runDir);
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
        await search.pressSequentially(plan.ticket.siteId, { delay: 80 });
        await page.waitForTimeout(1500);
        progress('project-search', `Đang tìm project ${plan.ticket.siteId}`);
        const projectCandidates = await projectSearchCandidates(page, plan.ticket.siteId);
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
        await page.screenshot({ path: path.join(runDir, 'cms-search.png'), fullPage: true });
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
          await page.waitForTimeout(1200);
          const baseUrl = projectBaseUrl(page.url());
          plan.cms.projectId = baseUrl.match(/\/projects\/(\d+)/)?.[1] || null;

          progress('plugin-check', 'Checking Announcement plugin status');
          await page.goto(`${baseUrl}/plugins`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.getByText('Plugins', { exact: true }).last().waitFor({ state: 'visible', timeout: 15000 });
          plan.plugin = await readAnnouncementPlugin(page);
          await page.screenshot({ path: path.join(runDir, 'plugins.png'), fullPage: true });

          // CMS applies index.yml during Build, so do not inspect it here.
          plan.popupSection = { exists: null, sectionId: null, checked: false };

          if (isPopupRemovalAction(plan.ticket.popupAction)) {
            // A removal must never install/update a plugin, replace a section,
            // or infer a timezone. It operates only on the existing popup
            // items the ticket asks to remove.
            plan.status = 'ready-to-remove-popup';
            plan.nextAction = plan.ticket.popupAction === 'remove-all'
              ? 'Ticket requests removal of every current popup. Apply will delete existing popup items and Build only after verification.'
              : 'Ticket includes a popup reference image. Apply will use Gemini Vision to match exactly one current CMS popup before deleting it.';
            if (applyChanges) {
              plan.safety = buildRequested
                ? 'CMS popup-removal and Build/publish were explicitly requested.'
                : 'CMS popup-removal was explicitly requested. Build/publish was not requested.';
              const removal = await removePopupForTicket(
                page,
                baseUrl,
                runDir,
                body,
                plan.ticket.popupAction,
                downloadedAttachment
              );
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
              await page.screenshot({ path: path.join(runDir, 'popup-removal.png'), fullPage: true });
              if (!removal.changed) {
                plan.status = 'popup-removal-noop';
                plan.nextAction = 'No configured popup existed to remove. CMS Build was not started because no CMS change was needed.';
              } else if (buildRequested) {
                progress('build-start', 'Starting CMS Build after verified popup removal');
                plan.build = await buildWebsite(page, baseUrl);
                plan.website = plan.build.website;
                if (plan.build.status === 'success') {
                  const websiteUrl = plan.website.liveUrl || plan.website.previewUrl || null;
                  plan.status = 'popup-removed';
                  plan.nextAction = websiteUrl
                    ? `Popup removal completed successfully on website: ${websiteUrl}`
                    : 'Popup removal completed successfully; CMS Build confirmed completion.';
                  progress('build-complete', plan.nextAction, { websiteUrl });
                } else {
                  plan.status = 'build-unconfirmed';
                  plan.nextAction = 'Popup removal was verified and CMS Build was started, but completion was not observed. Check CMS before declaring it live.';
                  progress('build-unconfirmed', plan.nextAction, { websiteUrl: plan.website.liveUrl || plan.website.previewUrl || null });
                }
              } else {
                plan.status = 'popup-removal-awaiting-build';
                plan.nextAction = 'Popup removal was verified. Rerun with --apply --build to publish the removal.';
              }
            }
          } else {
            progress('timezone-check', 'Reading project address to resolve popup timezone');
            plan.timezone = await discoverProjectTimezone(page, baseUrl);

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
            const preserveLegacyPopups = mustCreateFreshSection && plan.ticket.popupAction !== 'replace';
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
                if (preserveLegacyPopups) {
                  writeLegacyPopupSnapshot(runDir, legacyPopupSnapshot);
                  plan.legacyPopups = {
                    sectionCount: legacyPopupSnapshot.sectionIds.length,
                    preservedCount: legacyPopupSnapshot.items.length,
                    expiredCount: legacyPopupSnapshot.expiredCount
                  };
                }
                const duplicates = findDuplicatePopupImages(downloadedAttachments, legacyPopupSnapshot.scannedItems);
                if (duplicates.length) {
                  const duplicate = duplicates[0];
                  const ticketFilename = duplicate.ticket?.filename || `ticket image #${duplicate.ticketIndex + 1}`;
                  const error = new Error(`Duplicate popup image: "${ticketFilename}" already exists in CMS. The image was not added and CMS Build was not started.`);
                  error.stage = 'popup-image-duplicate';
                  error.duplicateImage = {
                    ticketFilename,
                    cmsImageUrl: duplicate.cms?.sourceImageUrl || null,
                    method: duplicate.method
                  };
                  throw error;
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
                  if (existing.item) {
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
            if (!repairExistingPopup && !replaceSectionAfterPluginUpdate && plan.ticket.popupAction !== 'replace') {
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
            progress(
              'section-apply',
              replaceSectionAfterPluginUpdate
                ? 'Replacing the old Annoucement Popup section with the current plugin section'
                : 'Opening the Page editor and adding Annoucement Popup when needed'
            );
            try {
              plan.popupSection = await ensurePopupSection(page, baseUrl, {
                replaceExisting: replaceSectionAfterPluginUpdate,
                expectedPluginVersion: plan.plugin.version
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
                legacyPopups: replaceSectionAfterPluginUpdate
                  ? legacyPopupSnapshot.items
                  : (recoveredMigration?.items || []),
                repairOnly: repairExistingPopup,
                ticketFilename: downloadedAttachment?.filename || null,
                ticketEntries: stagedTicketEntries,
                popupPosition: plan.ticket.popupPosition || null
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
                timezone: plan.timezone.iana,
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
                cmsImageUrls: configuredPopup.cmsImageUrls || (configuredPopup.cmsImageUrl ? [configuredPopup.cmsImageUrl] : [])
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
            await page.screenshot({ path: path.join(runDir, 'popup-settings.png'), fullPage: true });
            if (buildRequested) {
              progress('build-start', 'Đang bắt đầu Build website');
              plan.build = await buildWebsite(page, baseUrl);
              plan.website = plan.build.website;
              if (plan.build.status === 'success') {
                const websiteUrl = plan.website.liveUrl || plan.website.previewUrl || null;
                plan.popup.published = true;
                plan.status = 'popup-live';
                plan.nextAction = websiteUrl
                  ? `Popup thành công trên website: ${websiteUrl}`
                  : 'Popup thành công. CMS Build đã xác nhận hoàn tất nhưng không tìm thấy Live URL.';
                progress('build-complete', plan.nextAction, { websiteUrl });
                console.log(`Popup thành công: ${websiteUrl || 'CMS Build confirmed; Live URL unavailable'}`);
              } else {
                plan.status = 'build-unconfirmed';
                plan.nextAction = 'Popup settings were configured and CMS Build was started, but the tool did not observe a completion signal. Check CMS before declaring the popup live.';
                progress('build-unconfirmed', plan.nextAction, { websiteUrl: plan.website.liveUrl || plan.website.previewUrl || null });
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
  resolveRemovalScopeFromAttachments,
  popupScheduleFromTicket,
  popupTicketEntriesFromDownloads,
  shouldUseTicketVision,
  buildPopupEntries,
  buildPopupEntriesForTickets,
  planPopupItemTarget,
  resolveAddedPopupItemTarget,
  verifyPersistedPopupItem,
  resolvePopupItemByImageAndSchedule,
  popupListItemCards,
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
  resolveTimezoneFromData
};
