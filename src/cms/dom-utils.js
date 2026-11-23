'use strict';

const { isElementDisplayed } = require('../crm/ticket-reader');

async function visibleMatch(locator, description, fromEnd = false) {
  if (!locator) {
    if (description) throw new Error(`${description} was not found.`);
    return null;
  }
  const count = typeof locator.count === 'function' ? await locator.count().catch(() => 0) : 1;
  const start = fromEnd ? count - 1 : 0;
  const end = fromEnd ? -1 : count;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== end; index += step) {
    const candidate = typeof locator.nth === 'function'
      ? locator.nth(index)
      : (index === 0 && typeof locator.first === 'function' ? locator.first() : locator);
    if (await isElementDisplayed(candidate)) return candidate;
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

async function visibleLabel(page, labelText, fromEnd = false, timeout = 3000) {
  const deadline = Date.now() + timeout;
  const targetClean = labelText.replace(/[*:]/g, '').trim().toLowerCase();
  do {
    const candidates = page.locator('label, .el-form-item__label, [class*="form-label"]');
    const count = await candidates.count();
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await isElementDisplayed(candidate)) continue;
      const text = (await candidate.innerText().catch(() => '')).replace(/[*:]/g, '').trim().toLowerCase();
      if (text === targetClean) {
        matches.push(candidate);
      }
    }
    if (matches.length > 0) {
      return fromEnd ? matches.at(-1) : matches[0];
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);

  // Fallback: search any text element with exact or cleaned label text
  const fallback = page.locator('div, span, p').filter({
    hasText: new RegExp(`^\\s*\\*?\\s*${labelText}\\s*[*:]?\\s*$`, 'i')
  });
  const fallbackMatch = await visibleMatch(fallback, null, fromEnd);
  if (fallbackMatch) return fallbackMatch;

  throw new Error(`Visible label "${labelText}" was not found.`);
}

async function controlForLabel(page, labelText, fromEnd = false) {
  const label = await visibleLabel(page, labelText, fromEnd);
  const id = await label.getAttribute('for');
  if (!id) throw new Error(`The "${labelText}" control has no associated ID.`);
  const control = page.locator(`[id="${id}"]`);
  const found = await visibleMatch(control, `The "${labelText}" control`, fromEnd);
  return { label, control: found, id };
}

async function ensureDesktopViewport(page, { width = 1440, height = 1000, minimumWidth = 1100 } = {}) {
  await page.bringToFront().catch(() => {});
  await page.setViewportSize({ width, height }).catch(() => {});
  await page.waitForTimeout(150).catch(() => {});
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth || document.documentElement?.clientWidth || 0,
    height: window.innerHeight || document.documentElement?.clientHeight || 0,
    hidden: document.hidden
  })).catch(() => ({ width: 0, height: 0, hidden: true }));
  if (viewport.hidden || viewport.width < minimumWidth || viewport.height < 700) {
    const error = new Error(
      `CMS viewport is not safe for popup editing (${viewport.width}x${viewport.height}, hidden=${viewport.hidden}). `
      + 'No popup control was clicked.'
    );
    error.stage = 'cms-viewport';
    throw error;
  }
  return viewport;
}

module.exports = {
  isElementDisplayed,
  visibleMatch,
  waitForVisibleMatch,
  visibleLabel,
  controlForLabel,
  ensureDesktopViewport
};
