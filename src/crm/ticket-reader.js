'use strict';

const path = require('node:path');

const ACTIVE_TICKET_ROOT_SELECTOR = '#fbc-ticket-detail-right, [role="tabpanel"]:not([hidden]), .ant-tabs-tabpane-active, [class*="ticket-detail"], [class*="ticket_detail"]';

function browserProblem(body, online) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!online && /no internet connection|err_internet|you are offline/i.test(text)) return 'browser-offline';
  return null;
}

function ticketNumberFromUrl(ticketUrl) {
  return new URL(ticketUrl).pathname.match(/\/tickets\/detail\/(\d+)/i)?.[1] || null;
}

function ticketMarkerPattern(ticketNumber) {
  // CRM renders the header as `ID#12345 - Website Support` in some views,
  // while other views use a standalone `#12345`. Keep the number boundary
  // strict so a retained background ticket can never be selected.
  return new RegExp(`(?:^|\\s|\\bID\\s*)#\\s*${ticketNumber}(?=\\s|$|-)`, 'i');
}

function hasWebsiteIdHeader(text) {
  return /(?:\bID\s*(?:#\s*|[-:]\s*)?\d{2,}\s*-\s*\S|^\s*\d{3,6}\s*-\s*\S)/im.test(String(text || ''));
}

async function firstVisible(locator, fromEnd = false) {
  const count = await locator.count();
  for (let offset = 0; offset < count; offset += 1) {
    const index = fromEnd ? count - offset - 1 : offset;
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function activeTicketTabVisible(page, ticketNumber) {
  const href = `/tickets/detail/${ticketNumber}`;
  return page.locator(`a[href="${href}"]`).evaluateAll((nodes) => {
    const visible = (element) => Boolean(element.getClientRects().length);
    return nodes.some((node) => visible(node) && Boolean(node.closest('.active, [aria-selected="true"], [data-active="true"]')));
  }).catch(() => false);
}

async function activeTicketRoot(page, ticketUrl) {
  const ticketNumber = ticketNumberFromUrl(ticketUrl);
  if (!ticketNumber) return null;
  if (ticketNumberFromUrl(page.url()) !== ticketNumber) return null;
  const marker = ticketMarkerPattern(ticketNumber);
  const candidates = page.locator(ACTIVE_TICKET_ROOT_SELECTOR);
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = await candidate.innerText().catch(() => '');
    if (marker.test(text.replace(/\s+/g, ' ').trim())) return candidate;
  }
  // Current CRM layouts render the route ticket number in an outer active tab
  // and the Website-ID title in #fbc-ticket-detail-right. Anchor the panel to
  // the active tab so a retained older tab cannot supply data.
  if (await activeTicketTabVisible(page, ticketNumber)) {
    const panel = page.locator('#fbc-ticket-detail-right').first();
    if (await panel.isVisible().catch(() => false)) {
      const text = await panel.innerText().catch(() => '');
      if (hasWebsiteIdHeader(text)) return panel;
    }
  }
  // Older one-panel layouts may not expose an identifying wrapper. Use body
  // only when it has exactly one ticket heading.
  const body = page.locator('body');
  const text = await body.innerText().catch(() => '');
  const headingCount = [...text.matchAll(/(?:\bID\s*(?:#\s*|[-:]\s*)?\d{2,}\s*-|^\s*\d{3,6}\s*-)/gim)].length;
  return headingCount <= 1 && marker.test(text.replace(/\s+/g, ' ').trim()) ? body : null;
}

async function activeTicketText(page, ticketUrl) {
  const root = await activeTicketRoot(page, ticketUrl);
  if (!root) throw new Error('CRM rendered ticket tabs, but the selected ticket panel could not be isolated.');
  return root.innerText({ timeout: 10000 });
}

function allAttachmentsDownloadButton(root) {
  return root.locator('button[title="Download all attachments"]').first();
}

async function revealTicketAttachmentArea(page, root) {
  await root.evaluate((panel) => {
    const nodes = [panel, ...panel.querySelectorAll('*')];
    for (const node of nodes) {
      if (node.scrollHeight > node.clientHeight + 8) node.scrollTop = node.scrollHeight;
    }
  }).catch(() => {});
  await page.waitForTimeout(250);
  const conversation = await firstVisible(
    root.locator('button, [role="button"]').filter({ hasText: /^\s*(?:Conversations?|Comments?)\b/i }),
    true
  );
  const expanded = conversation ? await conversation.getAttribute('aria-expanded').catch(() => null) : null;
  const alreadyRevealed = conversation ? await conversation.getAttribute('data-popup-ticket-runner-revealed').catch(() => null) : null;
  if (conversation && expanded !== 'true' && alreadyRevealed !== 'true') {
    const opened = await conversation.click({ force: true }).then(() => true).catch(() => false);
    if (opened) await conversation.evaluate((button) => button.setAttribute('data-popup-ticket-runner-revealed', 'true')).catch(() => {});
    await page.waitForTimeout(350);
  }
  await root.evaluate((panel) => {
    const nodes = [panel, ...panel.querySelectorAll('*')];
    for (const node of nodes) {
      if (node.scrollHeight > node.clientHeight + 8) node.scrollTop = node.scrollHeight;
    }
  }).catch(() => {});
  await page.waitForTimeout(250);
}

async function visibleTicketAttachmentItems(root) {
  const cards = root.locator('.ant-upload-list-item');
  const items = [];
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    if (!await card.isVisible().catch(() => false)) continue;
    const thumbnail = card.locator('a.ant-upload-list-item-thumbnail, img.ant-upload-list-item-image');
    if (await firstVisible(thumbnail, true)) items.push(card);
  }
  return items;
}

function isInlineTicketImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname === 'storage.fastboy.dev'
      // Rich-text ticket images are stored under `im/`; avatars use `av/`
      // and must never be counted as popup attachment candidates.
      && /^\/crm\/storage_objects\/im(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function filenameFromImageUrl(rawUrl, fallback = 'ticket-image') {
  try {
    const basename = path.basename(new URL(rawUrl).pathname);
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(basename)) return basename;
  } catch { /* use fallback below */ }
  return fallback;
}

async function visibleInlineTicketAttachmentItems(root) {
  const images = root.locator('img');
  const items = [];
  const seen = new Set();
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index);
    const meta = await image.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        src: element.currentSrc || element.getAttribute('src') || '',
        width: rect.width,
        height: rect.height,
        insideUploadCard: Boolean(element.closest('.ant-upload-list-item'))
      };
    }).catch(() => null);
    if (!meta
      || meta.insideUploadCard
      || meta.width < 100
      || meta.height < 100
      || !isInlineTicketImageUrl(meta.src)
      || seen.has(meta.src)) continue;
    seen.add(meta.src);
    items.push({ kind: 'inline-image', locator: image, sourceUrl: meta.src });
  }
  return items;
}

async function visibleTicketImageCandidates(root) {
  const uploadCards = await visibleTicketAttachmentItems(root);
  const cardsWithUrl = [];
  for (const card of uploadCards) {
    const sourceUrl = await card.evaluate((el) => {
      const link = el.querySelector('a.ant-upload-list-item-thumbnail, a[href*="storage.fastboy.dev"]');
      if (link && link.href) return link.href;
      const img = el.querySelector('img[src*="storage.fastboy.dev"]');
      return img?.currentSrc || img?.src || null;
    }).catch(() => null);
    cardsWithUrl.push({ kind: 'upload-card', locator: card, sourceUrl: isInlineTicketImageUrl(sourceUrl) ? sourceUrl : null });
  }
  const inlineImages = await visibleInlineTicketAttachmentItems(root);
  return [
    ...cardsWithUrl,
    ...inlineImages
  ];
}

async function ticketAttachmentDescriptors(root, items = null) {
  const candidates = items || await visibleTicketImageCandidates(root);
  const descriptors = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const descriptor = await candidate.locator.evaluate((element, { candidateIndex, kind, sourceUrl }) => {
      if (kind === 'inline-image') {
        let context = element.parentElement?.innerText || '';
        let parent = element.parentElement;
        for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
          const text = (parent.innerText || '').trim();
          if (text.length > context.length && text.length <= 2600) context = text;
        }
        return {
          index: candidateIndex,
          filename: sourceUrl ? sourceUrl.split('/').at(-1)?.split('?')[0] || null : null,
          context: context.replace(/\s+/g, ' ').trim().slice(0, 2200),
          kind
        };
      }
      const image = element.querySelector('img');
      const link = element.querySelector('a');
      const values = [
        element.innerText,
        element.getAttribute('title'),
        image?.getAttribute('alt'),
        image?.getAttribute('title'),
        image?.getAttribute('src'),
        link?.getAttribute('title'),
        link?.getAttribute('href')
      ].filter(Boolean).map((value) => String(value).trim());
      const filename = values.map((value) => value.split(/[/?#]/).filter(Boolean).at(-1))
        .find((value) => /\.(?:png|jpe?g|gif|webp)(?:$|\s)/i.test(value || ''))
        || values.find((value) => /\.(?:png|jpe?g|gif|webp)/i.test(value))
        || null;
      let context = element.innerText || '';
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
        const text = (parent.innerText || '').trim();
        if (text.length > context.length && text.length <= 2600) context = text;
      }
      return {
        index: candidateIndex,
        filename,
        context: context.replace(/\s+/g, ' ').trim().slice(0, 2200),
        kind
      };
    }, { candidateIndex: index + 1, kind: candidate.kind, sourceUrl: candidate.sourceUrl })
      .catch(() => ({ index: index + 1, filename: null, context: '', kind: candidate.kind }));
    descriptors.push(descriptor);
  }
  return descriptors;
}

async function readFullTicketContext(page, ticketUrl) {
  const root = await activeTicketRoot(page, ticketUrl);
  if (!root) throw new Error('CRM rendered ticket tabs, but the selected ticket panel could not be isolated.');
  await revealTicketAttachmentArea(page, root);
  const items = await visibleTicketImageCandidates(root);
  return {
    root,
    text: await root.innerText({ timeout: 10000 }),
    attachmentCandidates: await ticketAttachmentDescriptors(root, items)
  };
}

async function ticketAttachmentItems(page, ticketUrl, { reveal = true } = {}) {
  const root = await activeTicketRoot(page, ticketUrl);
  if (!root) return { root: null, items: [] };
  let items = await visibleTicketImageCandidates(root);
  if (reveal) {
    await revealTicketAttachmentArea(page, root);
    items = await visibleTicketImageCandidates(root);
  }
  return { root, items };
}

async function ticketAttachmentAvailable(page, ticketUrl) {
  const { root, items } = await ticketAttachmentItems(page, ticketUrl);
  return Boolean(items.length || (root && await allAttachmentsDownloadButton(root).isVisible().catch(() => false)));
}

async function waitForTicketDetails(page, ticketUrl, { timeout = 30000 } = {}) {
  const ticketNumber = ticketNumberFromUrl(ticketUrl);
  if (!ticketNumber) throw new Error('Could not determine the ticket number from its URL.');
  await page.waitForFunction(
    ({ ticketNumber: expectedTicketNumber }) => {
      const marker = new RegExp(`(?:^|\\s|\\bID\\s*)#\\s*${expectedTicketNumber}(?=\\s|$|-)`, 'i');
      const selectors = '#fbc-ticket-detail-right, [role="tabpanel"]:not([hidden]), .ant-tabs-tabpane-active, [class*="ticket-detail"], [class*="ticket_detail"]';
      const visible = (element) => Boolean(element.getClientRects().length);
      const directPanelMatch = [...document.querySelectorAll(selectors)]
        .some((element) => visible(element) && marker.test((element.innerText || '').replace(/\s+/g, ' ').trim()));
      if (directPanelMatch) return true;
      const routeMatches = location.pathname === `/tickets/detail/${expectedTicketNumber}`;
      const activeTab = [...document.querySelectorAll(`a[href="/tickets/detail/${expectedTicketNumber}"]`)]
        .some((element) => visible(element) && Boolean(element.closest('.active, [aria-selected="true"], [data-active="true"]')));
      const panel = document.querySelector('#fbc-ticket-detail-right');
      const panelReady = Boolean(panel && visible(panel) && /(?:\bID\s*(?:#\s*|[-:]\s*)?\d{2,}\s*-\s*\S|^\s*\d{3,6}\s*-\s*\S)/im.test(panel.innerText || ''));
      return routeMatches && activeTab && panelReady;
    },
    { ticketNumber },
    { timeout }
  );
}

async function openTicketDetails(page, ticketUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForTicketDetails(page, ticketUrl);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await page.waitForTimeout(1000);
    }
  }
  const body = await page.locator('body').innerText().catch(() => '');
  const online = await page.evaluate(() => navigator.onLine).catch(() => true);
  const error = new Error('CRM did not finish loading the selected ticket panel after two attempts.');
  error.status = browserProblem(body, online) || 'ticket-not-loaded';
  error.cause = lastError;
  throw error;
}

module.exports = {
  ACTIVE_TICKET_ROOT_SELECTOR,
  browserProblem,
  ticketNumberFromUrl,
  ticketMarkerPattern,
  hasWebsiteIdHeader,
  activeTicketTabVisible,
  activeTicketRoot,
  activeTicketText,
  allAttachmentsDownloadButton,
  revealTicketAttachmentArea,
  visibleTicketAttachmentItems,
  isInlineTicketImageUrl,
  filenameFromImageUrl,
  visibleInlineTicketAttachmentItems,
  visibleTicketImageCandidates,
  ticketAttachmentDescriptors,
  readFullTicketContext,
  ticketAttachmentItems,
  ticketAttachmentAvailable,
  waitForTicketDetails,
  openTicketDetails
};
