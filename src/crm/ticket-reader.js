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

async function isElementDisplayed(locator) {
  if (!locator) return false;
  try {
    const visible = await locator.isVisible().catch(() => false);
    if (visible) return true;
    const count = typeof locator.count === 'function' ? await locator.count().catch(() => 0) : 1;
    if (count === 0) return false;
    return await locator.evaluate((element) => {
      if (!element || !(element instanceof Element)) return false;
      let cur = element;
      while (cur) {
        const s = window.getComputedStyle(cur);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true' || cur.hasAttribute?.('inert')) return false;
        cur = cur.parentElement;
      }
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
      if (viewportWidth <= 0 || viewportHeight <= 0) return false;
      return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
    }, null, { timeout: 2000 }).catch(() => false);
  } catch {
    return false;
  }
}

async function firstVisible(locator, fromEnd = false) {
  const count = await locator.count();
  for (let offset = 0; offset < count; offset += 1) {
    const index = fromEnd ? count - offset - 1 : offset;
    const candidate = locator.nth(index);
    if (await isElementDisplayed(candidate)) return candidate;
  }
  return null;
}

async function activeTicketTabVisible(page, ticketNumber) {
  const href = `/tickets/detail/${ticketNumber}`;
  return page.locator(`a[href="${href}"]`).evaluateAll((nodes) => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      let cur = element.parentElement;
      while (cur && cur !== document.body) {
        const s = window.getComputedStyle(cur);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        cur = cur.parentElement;
      }
      return true;
    };
    return nodes.some((node) => visible(node) && Boolean(node.closest('.active, [aria-selected="true"], [data-active="true"]')));
  }).catch(() => false);
}

async function activeTicketRoot(page, ticketUrl) {
  const ticketNumber = ticketNumberFromUrl(ticketUrl);
  if (!ticketNumber) return null;
  if (ticketNumberFromUrl(page.url()) !== ticketNumber) return null;

  // If another tab was clicked or became active while running, restore the ticket tab
  const tabLocator = page.locator(`a[href="/tickets/detail/${ticketNumber}"]`).first();
  if (await tabLocator.count()) {
    await tabLocator.evaluate((el) => {
      if (!el.closest('.active, [aria-selected="true"], [data-active="true"]')) {
        el.click();
      }
    }).catch(() => {});
  }

  const marker = ticketMarkerPattern(ticketNumber);
  const candidates = page.locator(ACTIVE_TICKET_ROOT_SELECTOR);
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await isElementDisplayed(candidate)) continue;
    const text = await candidate.innerText().catch(() => '');
    if (marker.test(text.replace(/\s+/g, ' ').trim())) return candidate;
  }
  // Current CRM layouts render the route ticket number in an outer active tab
  // and the Website-ID title in #fbc-ticket-detail-right. Anchor the panel to
  // the active tab so a retained older tab cannot supply data.
  if (await activeTicketTabVisible(page, ticketNumber)) {
    const panel = page.locator('#fbc-ticket-detail-right').first();
    if (await isElementDisplayed(panel)) {
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
  await page.waitForTimeout(100);
  const conversation = await firstVisible(
    root.locator('button, [role="button"]').filter({ hasText: /^\s*(?:Conversations?|Comments?)\b/i }),
    true
  );
  const expanded = conversation ? await conversation.getAttribute('aria-expanded').catch(() => null) : null;
  const alreadyRevealed = conversation ? await conversation.getAttribute('data-popup-ticket-runner-revealed').catch(() => null) : null;
  if (conversation && expanded !== 'true' && alreadyRevealed !== 'true') {
    const opened = await conversation.click({ force: true }).then(() => true).catch(async () => {
      return conversation.evaluate((button) => {
        button.click();
        return true;
      }).catch(() => false);
    });
    if (opened) await conversation.evaluate((button) => button.setAttribute('data-popup-ticket-runner-revealed', 'true')).catch(() => {});
    await page.waitForTimeout(300);
  }
  await root.evaluate((panel) => {
    const nodes = [panel, ...panel.querySelectorAll('*')];
    for (const node of nodes) {
      if (node.scrollHeight > node.clientHeight + 8) node.scrollTop = node.scrollHeight;
    }
  }).catch(() => {});
  await page.waitForTimeout(100);
}

async function visibleTicketAttachmentItems(root) {
  const cards = root.locator('.ant-upload-list-item');
  const items = [];
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    if (!await isElementDisplayed(card)) continue;
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
      // Rich-text ticket images are stored under `im/`; upload attachments
      // use two-letter prefixes like `an/`, `16/`, `c3/`. Avatars use `av/`
      // and must never be counted as popup attachment candidates.
      && /^\/crm\/storage_objects\//i.test(url.pathname)
      && !/^\/crm\/storage_objects\/av(?:\/|$)/i.test(url.pathname);
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
  const count = await images.count();
  for (let index = 0; index < count; index += 1) {
    const image = images.nth(index);
    const meta = await image.evaluate(async (element) => {
      const src = element.currentSrc || element.getAttribute('src') || '';
      if (!src) return null;
      if (!element.complete && typeof element.decode === 'function') {
        await element.decode().catch(() => {});
      }
      const rect = element.getBoundingClientRect();
      const naturalW = element.naturalWidth || 0;
      const naturalH = element.naturalHeight || 0;
      const offsetW = element.offsetWidth || 0;
      const offsetH = element.offsetHeight || 0;
      const attrW = parseInt(element.getAttribute('width') || '0', 10) || 0;
      const attrH = parseInt(element.getAttribute('height') || '0', 10) || 0;

      const style = window.getComputedStyle(element);
      let isHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      if (!isHidden) {
        let cur = element.parentElement;
        while (cur && cur !== document.body) {
          const s = window.getComputedStyle(cur);
          if (s.display === 'none' || s.visibility === 'hidden') {
            isHidden = true;
            break;
          }
          cur = cur.parentElement;
        }
      }

      const effectiveWidth = Math.max(naturalW, offsetW, rect.width || 0, attrW);
      const effectiveHeight = Math.max(naturalH, offsetH, rect.height || 0, attrH);

      return {
        src,
        width: effectiveWidth,
        height: effectiveHeight,
        naturalWidth: naturalW,
        naturalHeight: naturalH,
        isHidden,
        insideUploadCard: Boolean(element.closest('.ant-upload-list-item'))
      };
    }).catch(() => null);

    if (!meta
      || meta.insideUploadCard
      || meta.isHidden
      || !isInlineTicketImageUrl(meta.src)
      || seen.has(meta.src)) continue;

    // Filter tiny icons/emojis (e.g. 16x16, 24x24) when dimensions are known.
    // In background or minimized windows, naturalWidth might be 0 until painted/decoded,
    // but isInlineTicketImageUrl already verified it is a CRM storage object (not avatar).
    const hasKnownDimensions = meta.width > 0 && meta.height > 0;
    if (hasKnownDimensions && (meta.width < 100 || meta.height < 100)) continue;

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
      const link = el.querySelector('a.ant-upload-list-item-thumbnail, a[href*="storage.fastboy.dev"], a.ant-upload-list-item-name');
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
      let precedingText = '';
      let isRemovalReference = false;
      if (kind === 'inline-image') {
        let block = element.closest('p, div, li, tr') || element;
        let prev = block.previousElementSibling;
        while (prev && !precedingText) {
          const t = (prev.innerText || '').trim();
          if (t) precedingText = t;
          prev = prev.previousElementSibling;
        }
        if (!precedingText && block.parentElement) {
          let parentPrev = block.parentElement.previousElementSibling;
          while (parentPrev && !precedingText) {
            const t = (parentPrev.innerText || '').trim();
            if (t) precedingText = t;
            parentPrev = parentPrev.previousElementSibling;
          }
        }
        const hasRemoval = /(?:gỡ|xóa|remove|delete|take\s*down)\s+(?:poster|hình|ảnh|popup)/i.test(precedingText)
          || /^[0-9]+[./)]\s*(?:gỡ|xóa|remove)/i.test(precedingText);
        const hasSubsequentPopup = /(?:và|then|thay\s+bằng|thay\s+thế|update\s+lại)\s+(?:pop[\s-]*up|tạo|đăng|lên|treo|thay)\b/i.test(precedingText)
          || /\bpop[\s-]*up\b[^.;\n]{0,60}\((?:ảnh|hình)\s+bên\s+dưới\)/i.test(precedingText);
        if (hasRemoval) {
          if (!hasSubsequentPopup) {
            isRemovalReference = true;
          } else {
            // Mixed clause: "gỡ [A] ... và pop up [B] (ảnh bên dưới)"
            // Check if another image preceded this one in the same container.
            const previousSiblingImage = element.closest('p, div, li, tr')?.previousElementSibling?.querySelector?.('img')
              || element.previousElementSibling?.matches?.('img');
            // If another image preceded this one, this is the new popup B (not removal).
            // If no image preceded this one, this is A (the removal reference).
            isRemovalReference = !previousSiblingImage;
          }
        }
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
          precedingText: precedingText.replace(/\s+/g, ' ').trim().slice(0, 300),
          kind,
          isRemovalReference
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
        precedingText: '',
        kind,
        isRemovalReference: false
      };
    }, { candidateIndex: index + 1, kind: candidate.kind, sourceUrl: candidate.sourceUrl })
      .catch(() => ({ index: index + 1, filename: null, context: '', precedingText: '', kind: candidate.kind, isRemovalReference: false }));
    descriptors.push(descriptor);
  }
  return descriptors;
}

async function readFullTicketContext(page, ticketUrl) {
  const root = await activeTicketRoot(page, ticketUrl);
  if (!root) throw new Error('CRM rendered ticket tabs, but the selected ticket panel could not be isolated.');
  await revealTicketAttachmentArea(page, root);
  let items = await visibleTicketImageCandidates(root);
  let previousCount = items.length;
  let stablePolls = 0;
  // In background tabs or throttled windows, comments and attachments take time to render
  for (let poll = 0; poll < 15; poll += 1) {
    await page.waitForTimeout(300);
    items = await visibleTicketImageCandidates(root);
    if (items.length > 0 && items.length === previousCount) {
      stablePolls += 1;
      // Require at least 4 stable polls (~1200ms) AND at least poll >= 4 (~1500ms total) before breaking
      if (stablePolls >= 4 && poll >= 4) {
        break;
      }
    } else {
      stablePolls = 0;
    }
    previousCount = items.length;
  }
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
  return Boolean(items.length || (root && await isElementDisplayed(allAttachmentsDownloadButton(root))));
}

async function waitForTicketDetails(page, ticketUrl, { timeout = 30000 } = {}) {
  const ticketNumber = ticketNumberFromUrl(ticketUrl);
  if (!ticketNumber) throw new Error('Could not determine the ticket number from its URL.');
  await page.waitForFunction(
    ({ ticketNumber: expectedTicketNumber }) => {
      const marker = new RegExp(`(?:^|\\s|\\bID\\s*)#\\s*${expectedTicketNumber}(?=\\s|$|-)`, 'i');
      const selectors = '#fbc-ticket-detail-right, [role="tabpanel"]:not([hidden]), .ant-tabs-tabpane-active, [class*="ticket-detail"], [class*="ticket_detail"]';
      const visible = (element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length || (window.getComputedStyle(element).display !== 'none'));
      const directPanelMatch = [...document.querySelectorAll(selectors)]
        .some((element) => visible(element) && marker.test((element.innerText || '').replace(/\s+/g, ' ').trim()));
      if (directPanelMatch) return true;
      const routeMatches = location.pathname === `/tickets/detail/${expectedTicketNumber}`;
      const tabLinks = [...document.querySelectorAll(`a[href="/tickets/detail/${expectedTicketNumber}"]`)];
      const activeTab = tabLinks
        .some((element) => visible(element) && Boolean(element.closest('.active, [aria-selected="true"], [data-active="true"]')));
      if (routeMatches && tabLinks.length > 0 && !activeTab) {
        tabLinks[0].click();
      }
      const panel = document.querySelector('#fbc-ticket-detail-right');
      const panelReady = Boolean(panel && visible(panel) && /(?:\bID\s*(?:#\s*|[-:]\s*)?\d{2,}\s*-\s*\S|^\s*\d{3,6}\s*-\s*\S)/im.test(panel.innerText || ''));
      return routeMatches && (activeTab || tabLinks.length > 0) && panelReady;
    },
    { ticketNumber },
    { timeout, polling: 150 }
  );
}

async function openTicketDetails(page, ticketUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.bringToFront().catch(() => {});
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
  isElementDisplayed,
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
