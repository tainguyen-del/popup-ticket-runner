'use strict';

const path = require('path');
const {
  isElementDisplayed,
  visibleMatch,
  waitForVisibleMatch,
  visibleLabel,
  controlForLabel,
  ensureDesktopViewport
} = require('./dom-utils');
const { popupImageIdentity } = require('./popup-image-policy');
const {
  stableImageUrl,
  verifyPersistedPopupItem,
  popupItemsForReport,
  popupDateFromCmsValue
} = require('./popup-verification');

let progressEmitter = () => {};
function setProgressHandler(handler) {
  if (typeof handler === 'function') progressEmitter = handler;
}
function emitProgress(stage, message) {
  progressEmitter(stage, message);
}

function expiryAriaLabel(expiry) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(`${expiry}T12:00:00.000Z`));
}

function todayInTimezone(iana) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: iana, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
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
  const currentValue = await control.inputValue().catch(() => '');
  if (currentValue && currentValue.includes(date)) return;
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

async function setPopupDateValue(page, label, date, defaultTime) {
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

async function clearPopupDateControl(page, labelText) {
  const controlInfo = await controlForLabel(page, labelText, false).catch(() => null);
  if (!controlInfo) return false;
  const { control, id } = controlInfo;
  const existing = await control.inputValue().catch(() => '');
  if (!existing) return false;
  await control.click();
  const calendar = await popupCalendar(page).catch(() => null);
  if (calendar) {
    const clear = await visibleMatch(calendar.getByText('Clear', { exact: true }), `${labelText} Clear control`, false).catch(() => null);
    if (clear) await clear.click().catch(() => {});
  }
  const stillHasValue = await control.inputValue().catch(() => '');
  if (stillHasValue) {
    await control.fill('').catch(() => {});
  }
  await page.waitForFunction((fieldId) => !(document.getElementById(fieldId)?.value || '').trim(), id, { timeout: 3000 }).catch(() => {});
  return true;
}

async function clearPopupStartDate(page) {
  return clearPopupDateControl(page, 'Time start (optional)');
}

async function clearPopupEndDate(page) {
  return clearPopupDateControl(page, 'Time end (optional)');
}

async function pageDelay(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms).catch(() => {});
  } else {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function isPopupItemEditorOpen(page, timeout = 1200) {
  const deadline = Date.now() + Math.max(10, timeout);

  do {
    // Definitive positive check 1: upload prompt text visible
    try {
      if (typeof page.getByText === 'function') {
        const hasImageAction = page.getByText(/(?:Click to (?:upload|change) image)|Upload image|Change image|thay\s+thế\s+ảnh|tải\s+ảnh/i);
        const actionMatch = await visibleMatch(hasImageAction, null, true).catch(() => null);
        if (actionMatch) return true;
      }
      if (typeof page.locator === 'function') {
        const uploadLoc = page.locator('label, div, span, p').filter({
          hasText: /(?:Click to (?:upload|change) image)|Upload image|Change image|thay\s+thế\s+ảnh|tải\s+ảnh/i
        });
        const actionMatch = await visibleMatch(uploadLoc, null, true).catch(() => null);
        if (actionMatch) return true;
      }
    } catch {}

    // Definitive positive check 2: Nuxt UI editor action prompts ("Browse file", "Drag and drop file")
    try {
      const editorPrompts = [
        page.locator('button, span, div, p').filter({ hasText: /^Browse file$/i }),
        page.locator('p, span, div').filter({ hasText: /Drag and drop file/i })
      ];

      for (const loc of editorPrompts) {
        if ((await loc.count().catch(() => 0)) > 0 && await isElementDisplayed(loc.first()).catch(() => false)) {
          return true;
        }
      }
    } catch {}

    // Definitive positive check 3: "List items" heading (role="heading") — appears inside legacy item editor
    try {
      if (typeof page.getByRole === 'function') {
        const isHeading = page.getByRole('heading', { name: 'List items', exact: true });
        if (await isElementDisplayed(isHeading)) return true;
      }
    } catch {}

    // Definitive positive check 4: "Image" label accompanied by file input
    try {
      const isImageLabel = page.locator('label').filter({ hasText: /^Image$/ }).first();
      let hasFileInput = (await page.locator('input[type="file"][accept*="image" i]').count().catch(() => 0)) > 0;
      if (!hasFileInput) {
        hasFileInput = (await page.locator('input[type="file"]').count().catch(() => 0)) > 0;
      }
      if (hasFileInput && await isElementDisplayed(isImageLabel).catch(() => false)) return true;
    } catch {}

    // Check 5: File input is present and Add block is completely absent from DOM
    try {
      const addBlockLocator = page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")');
      const addBlockCount = typeof addBlockLocator?.count === 'function' ? await addBlockLocator.count().catch(() => 0) : 0;
      if (addBlockCount === 0) {
        let fileInputs = page.locator('input[type="file"][accept*="image" i]');
        let fileCount = typeof fileInputs?.count === 'function' ? await fileInputs.count().catch(() => 0) : 0;
        if (fileCount === 0) {
          fileInputs = page.locator('input[type="file"]');
          fileCount = typeof fileInputs?.count === 'function' ? await fileInputs.count().catch(() => 0) : 0;
        }
        if (fileCount > 0) return true;
      }
    } catch {}

    // If Add block is visible now and none of the positive checks above matched, we are in list view
    try {
      const addBlock = page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")');
      const addBlockMatch = typeof addBlock?.first === 'function' ? addBlock.first() : addBlock;
      if (await isElementDisplayed(addBlockMatch)) {
        if (Date.now() >= deadline) return false;
        await pageDelay(page, 100);
        continue;
      }
    } catch {}

    // When Add block is gone, check for editor-specific schedule inputs
    try {
      const timeInputs = page.locator('input[name*="time_start"], input[name*="time_end"], [id*="time_start"], [id*="time_end"]');
      const timeCount = typeof timeInputs?.count === 'function' ? await timeInputs.count().catch(() => 0) : 0;
      if (timeCount > 0) {
        const timeMatch = await visibleMatch(timeInputs, null, true).catch(() => null);
        if (timeMatch) return true;
      }
    } catch {}

    if (Date.now() >= deadline) break;
    await pageDelay(page, 100);
  } while (Date.now() < deadline);

  return false;
}

const popupListItemEditorIsOpen = isPopupItemEditorOpen;

function safeFirst(locator) {
  if (!locator) return null;
  return typeof locator.first === 'function' ? locator.first() : locator;
}

function safeLast(locator) {
  if (!locator) return null;
  if (typeof locator.last === 'function') return locator.last();
  if (typeof locator.first === 'function') return locator.first();
  return locator;
}

async function hasElement(locator) {
  if (!locator) return false;
  try {
    if (typeof locator.count === 'function') {
      return (await locator.count().catch(() => 0)) > 0;
    }
    return await isElementDisplayed(locator);
  } catch {
    return false;
  }
}

async function isPopupListItemsViewOpen(page) {
  const addBlock = safeFirst(page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")'));
  return isElementDisplayed(addBlock);
}

async function getActivePopupDrawer(page) {
  try {
    // Strategy A: Direct drawer locator with Add block or Slide direction style
    const drawerLocator = page.locator('div[class*="overflow-y-auto"], div[class*="overflow-auto"], div.absolute.inset-0')
      .filter({ has: page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block"), text=/Slide direction style|Popup[\s_]setting/i') });
    const count = await drawerLocator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i -= 1) {
      const candidate = drawerLocator.nth(i);
      const isRoot = await candidate.evaluate((el) => !el || el.id === '__layout' || el.tagName === 'BODY' || el.tagName === 'HTML').catch(() => true);
      if (!isRoot) return candidate;
    }

    // Strategy B: Closest ancestor from marker (index [1], never [last()] which selects root layout!)
    const markers = page.locator('text=/Slide direction style|Time delay slider|Loop slider mode|Popup[\s_]setting/i');
    const markerCount = await markers.count().catch(() => 0);
    for (let i = 0; i < markerCount; i += 1) {
      const marker = typeof markers.nth === 'function' ? markers.nth(i) : markers;
      const drawer = marker.locator(
        'xpath=ancestor::div[(contains(@class, "overflow-y-auto") or contains(@class, "overflow-auto") or contains(@class, "inset-0") or contains(@class, "sidebar")) and not(@id="__layout") and not(self::body)][1]'
      );
      if (await hasElement(drawer)) return drawer;
    }
  } catch {}
  return null;
}

async function setTimeDelaySlider(page, seconds) {
  const numericSeconds = Number(seconds);
  if (!Number.isInteger(numericSeconds) || numericSeconds < 1 || numericSeconds > 120) {
    throw new Error(`Time delay slider value must be an integer between 1 and 120 seconds; received ${seconds}.`);
  }
  const targetValue = String(numericSeconds);
  let control = null;

  const isWritableValueInput = async (candidate) => {
    if (!candidate || !await isElementDisplayed(candidate).catch(() => false)) return false;
    if (typeof candidate.getAttribute !== 'function') return true;
    const type = String(await candidate.getAttribute('type').catch(() => '') || '').toLowerCase();
    return !['checkbox', 'radio', 'file', 'hidden', 'button', 'submit'].includes(type);
  };

  // Locate the exact field label first. Searching a broad drawer/container
  // is unsafe: on narrow viewports its first input is often "Choose all".
  if (!control) {
    try {
      const label = await visibleMatch(
        page.locator('label, span, div, p').filter({ hasText: /^\s*Time delay slider\s*$/i }),
        null,
        true
      ).catch(() => null);
      if (label) {
        const id = await label.getAttribute('for').catch(() => null);
        if (id) {
          const idMatch = page.locator(`[id="${id}"]`);
          if (await isWritableValueInput(idMatch)) control = idMatch;
        }
        if (!control) {
          const following = label.locator('xpath=following::input[1]');
          if (await isWritableValueInput(following)) control = following;
        }
        if (!control) {
          const container = label.locator('xpath=ancestor::div[.//input][1]');
          const cand = container.locator('input').first();
          if (await isWritableValueInput(cand)) control = cand;
        }
      }
    } catch {}
  }

  // Fallback only to controls whose own name/id identifies a delay field.
  if (!control) {
    try {
      const candidates = page.locator('input[name*="delay"], input[name*="time_delay"], input[id*="delay"], input[id*="time_delay"]');
      const count = await candidates.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const c = candidates.nth(i);
        if (await isWritableValueInput(c)) {
          control = c;
          break;
        }
      }
    } catch {}
  }

  // Last fallback: the only writable input immediately preceding List items.
  if (!control) {
    try {
      const listHeader = page.locator('button, span, div, p, label').filter({ hasText: /List items/i }).first();
      if (await isElementDisplayed(listHeader).catch(() => false)) {
        const precedingInput = listHeader.locator('xpath=preceding::input[1]');
        if (await isWritableValueInput(precedingInput)) {
          control = precedingInput;
        }
      }
    } catch {}
  }

  if (!control || !await isElementDisplayed(control).catch(() => false)) {
    throw new Error('Time delay slider control was not found in Popup settings.');
  }

  await control.evaluate((el) => {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
  }).catch(() => {});
  await control.click({ force: true }).catch(() => {});
  await control.fill('').catch(() => {});
  if (typeof control.pressSequentially === 'function') {
    await control.pressSequentially(targetValue, { delay: 40 }).catch(() => {});
  } else {
    await control.fill(targetValue).catch(() => {});
  }
  await control.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, targetValue).catch(() => {});
  await control.press('Tab').catch(() => {});
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(300).catch(() => {});
  let appliedValue = await control.inputValue().catch(() => '');

  // If not yet matching, retry using hardware keyboard simulation
  if (appliedValue !== targetValue && page.keyboard) {
    await control.click({ force: true }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(targetValue, { delay: 50 }).catch(() => {});
    await control.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, targetValue).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(300).catch(() => {});
    appliedValue = await control.inputValue().catch(() => '');
  }

  return {
    applied: appliedValue === targetValue,
    value: appliedValue || targetValue
  };
}

async function popupListItemsPanel(page) {
  // Strategy 1: Locate list panel inside active Announcement Popup drawer
  try {
    const drawer = await getActivePopupDrawer(page);
    if (drawer) {
      const addBlockLoc = drawer.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")');
      const addBlockInDrawer = safeLast(addBlockLoc);
      if ((await addBlockLoc.count().catch(() => 0)) > 0 && addBlockInDrawer) {
        const panel = addBlockInDrawer.locator(
          'xpath=ancestor::div[.//button[contains(@class, "button-drag")] or .//input[contains(@name, "list_items")] or .//*[contains(normalize-space(.), "List items") or contains(normalize-space(.), "Choose all")]][1]'
        );
        if (await hasElement(panel)) return panel;
        return drawer;
      }
      const cbLoc = drawer.locator('input[type="checkbox"][name^="check-all-list_items-"], input[name^="check-all-list_items-"]');
      const cbInDrawer = safeFirst(cbLoc);
      if ((await cbLoc.count().catch(() => 0)) > 0 && cbInDrawer) {
        const panel = cbInDrawer.locator(
          'xpath=ancestor::div[.//button[contains(normalize-space(.), "Add block")] or .//*[@role="button" and contains(normalize-space(.), "Add block")]][1]'
        );
        if (await hasElement(panel)) return panel;
        return drawer;
      }
    }
  } catch {}

  // Strategy 2: Direct anchor from Add block in DOM
  const addBlockLoc = page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")');
  const addBlock = safeLast(addBlockLoc);
  const hasAddBlock = (await addBlockLoc.count().catch(() => 0)) > 0;
  if (hasAddBlock && addBlock) {
    const panel = addBlock.locator(
      'xpath=ancestor::div[.//button[contains(@class, "button-drag")] or .//input[contains(@name, "list_items")] or .//*[contains(normalize-space(.), "List items") or contains(normalize-space(.), "Choose all")]][1]'
    );
    if (await hasElement(panel)) return panel;
    const fallbackPanel = addBlock.locator('xpath=ancestor::div[contains(@class, "el-collapse-item") or contains(@class, "section") or contains(@class, "sidebar")][1]');
    if (await hasElement(fallbackPanel)) return fallbackPanel;
  }

  const checkAllCheckboxLoc = page.locator('input[type="checkbox"][name^="check-all-list_items-"]');
  const checkAllCheckbox = safeLast(checkAllCheckboxLoc);
  const hasCheckbox = (await checkAllCheckboxLoc.count().catch(() => 0)) > 0;
  const checkAll = hasCheckbox ? checkAllCheckbox : null;
  const anchor = checkAll || await visibleMatch(
    page.getByText('List items', { exact: true }),
    null,
    true
  ) || await visibleMatch(
    page.getByText(/List\s*items/i),
    null,
    true
  ) || await visibleMatch(
    page.locator('label, div, span, p').filter({ hasText: /^List\s*items?$/i }),
    null,
    true
  ) || await visibleMatch(
    page.getByText(/Choose\s*all/i),
    null,
    true
  );

  if (anchor) {
    const panel = anchor.locator(
      'xpath=ancestor::div[.//button[contains(normalize-space(.), "Add block")] or .//*[@role="button" and contains(normalize-space(.), "Add block")]][1]'
    );
    if (await hasElement(panel)) return panel;
  }

  if (hasAddBlock) {
    const directAncestor = addBlock.locator('xpath=ancestor::div[2]');
    if (await hasElement(directAncestor)) return directAncestor;
  }

  const error = new Error('Popup List items panel was not available. No unrelated CMS field was selected.');
  error.stage = 'popup-item-target';
  throw error;
}

async function waitForPopupListItemsPanel(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const panel = await popupListItemsPanel(page);
      const addBlock = await visibleMatch(
        panel.getByRole('button', { name: /Add\s*block/i }),
        null,
        true
      ) || await visibleMatch(
        panel.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")'),
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
  const rawCards = [];

  // Strategy 1: Standard drag handle buttons
  try {
    const dragButtons = panel.locator('button.button-drag, [class*="button-drag"], [class*="drag-handle"]');
    const count = await dragButtons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const button = dragButtons.nth(index);
      const isButtonPresent = typeof button.count === 'function' ? (await button.count().catch(() => 0)) > 0 : await isElementDisplayed(button);
      if (!isButtonPresent) continue;

      const pointerCard = button.locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " relative ") and contains(concat(" ", normalize-space(@class), " "), " cursor-pointer ")][1]'
      );
      const hasPointerCard = typeof pointerCard.count === 'function' ? (await pointerCard.count().catch(() => 0)) > 0 : Boolean(pointerCard);
      if (hasPointerCard) {
        rawCards.push(pointerCard);
        continue;
      }

      const fallbackCard = button.locator('xpath=ancestor::div[contains(@class, "cursor-pointer") or contains(@class, "el-card")][1]');
      const hasFallbackCard = typeof fallbackCard.count === 'function' ? (await fallbackCard.count().catch(() => 0)) > 0 : Boolean(fallbackCard);
      if (hasFallbackCard) {
        rawCards.push(fallbackCard);
        continue;
      }

      const rowCandidate = button.locator(
        'xpath=ancestor::div[not(.//button[contains(normalize-space(.), "Add block")]) and (.//img or .//*[contains(normalize-space(.), "Not configured") or contains(normalize-space(.), "Until") or contains(normalize-space(.), "From") or contains(normalize-space(.), "Active") or contains(normalize-space(.), "Draft") or contains(normalize-space(.), "Expired")])][1]'
      );
      const hasRowCandidate = typeof rowCandidate.count === 'function' ? (await rowCandidate.count().catch(() => 0)) > 0 : Boolean(rowCandidate);
      if (hasRowCandidate) {
        rawCards.push(rowCandidate);
        continue;
      }

      const directParent = button.locator('xpath=ancestor::div[not(.//button[contains(normalize-space(.), "Add block")])][1]');
      const hasDirectParent = typeof directParent.count === 'function' ? (await directParent.count().catch(() => 0)) > 0 : Boolean(directParent);
      if (hasDirectParent) {
        rawCards.push(directParent);
      }
    }
  } catch {}

  // Strategy 2: Nuxt UI list item cards inside space-y-2 or cursor-pointer.rounded-lg
  if (rawCards.length === 0) {
    try {
      const nuxtCards = panel.locator('div.space-y-2 > div, div[class*="cursor-pointer"].rounded-lg').filter({
        has: page.locator('text=/Not configured|Until|From|Active|Draft|Expired|\d{1,2}\/\d{1,2}\/\d{4}/i, img, svg')
      });
      const nuxtCount = await nuxtCards.count().catch(() => 0);
      for (let i = 0; i < nuxtCount; i += 1) {
        const c = nuxtCards.nth(i);
        const hasAddBlock = (await c.locator('button:has-text("Add block")').count().catch(() => 0)) > 0;
        if (!hasAddBlock && await isElementDisplayed(c)) rawCards.push(c);
      }
    } catch {}
  }

  // Strategy 3 (Fallback): Broader drag elements (Nuxt UI icons, SVG handles, draggable items)
  if (rawCards.length === 0) {
    try {
      const broadDrag = panel.locator('[class*="cursor-grab"], [class*="cursor-move"], [class*="bars-2"], [class*="bars-3"], [draggable="true"], svg.cursor-grab, svg.cursor-move');
      const dragCount = await broadDrag.count().catch(() => 0);
      for (let index = 0; index < dragCount; index += 1) {
        const handle = broadDrag.nth(index);
        if (!await isElementDisplayed(handle)) continue;
        const card = handle.locator('xpath=ancestor::div[contains(@class, "cursor-pointer") or contains(@class, "relative") or contains(@class, "rounded") or contains(@class, "border")][not(.//button[contains(normalize-space(.), "Add block")])][1]');
        if (await isElementDisplayed(card)) {
          rawCards.push(card);
        } else {
          const directParent = handle.locator('xpath=ancestor::div[not(.//button[contains(normalize-space(.), "Add block")])][1]');
          if (await isElementDisplayed(directParent)) rawCards.push(directParent);
        }
      }
    } catch {}
  }

  // Strategy 4 (Fallback): Card discovery via status text ("Not configured" / date badges)
  if (rawCards.length === 0) {
    try {
      const statusLocators = [
        panel.locator('span, div, p, [class*="badge"]').filter({ hasText: /^Not configured$/i }),
        panel.locator('span, div, p, [class*="badge"]').filter({ hasText: /^(?:Until|From|Active|Draft|Expired)\b|\d{1,2}\/\d{1,2}\/\d{4}/i })
      ];
      for (const statusLoc of statusLocators) {
        const count = await statusLoc.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const statusEl = statusLoc.nth(i);
          if (!await isElementDisplayed(statusEl)) continue;
          const cardCandidate = statusEl.locator(
            'xpath=ancestor::div[contains(@class, "cursor-pointer") or contains(@class, "relative") or contains(@class, "rounded") or contains(@class, "border")][not(.//button[contains(normalize-space(.), "Add block")])][1]'
          );
          if (await isElementDisplayed(cardCandidate)) {
            rawCards.push(cardCandidate);
          } else {
            const fallbackRow = statusEl.locator('xpath=ancestor::div[not(.//button[contains(normalize-space(.), "Add block")]) and not(.//input[contains(@name, "check-all")])][1]');
            if (await isElementDisplayed(fallbackRow)) rawCards.push(fallbackRow);
          }
        }
      }
    } catch {}
  }

  // Strategy 5 (Fallback): Direct card containers in panel (excluding Add block)
  if (rawCards.length === 0) {
    try {
      const directContainers = panel.locator('div[class*="cursor-pointer"], [class*="card"]').filter({
        hasNot: panel.locator('button:has-text("Add block")'),
        has: panel.locator('text=/Not configured|Until|From|Active|Draft|Expired|\d{1,2}\/\d{1,2}\/\d{4}/i, img, svg')
      });
      const count = await directContainers.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const c = directContainers.nth(i);
        if (await isElementDisplayed(c)) rawCards.push(c);
      }
    } catch {}
  }

  // Deduplicate cards so duplicate locator instances pointing to the same DOM element are merged
  const cards = [];
  for (const card of rawCards) {
    let duplicate = false;
    for (const existing of cards) {
      try {
        const hExisting = typeof existing.elementHandle === 'function' ? await existing.elementHandle().catch(() => null) : existing;
        const hCard = typeof card.elementHandle === 'function' ? await card.elementHandle().catch(() => null) : card;
        if (hExisting && hCard) {
          const same = await page.evaluate(([a, b]) => a === b, [hExisting, hCard]).catch(() => false);
          if (same) {
            duplicate = true;
            break;
          }
        }
      } catch {}
    }
    if (!duplicate) cards.push(card);
  }

  if (Number.isInteger(expectedCount) && cards.length !== expectedCount) {
    const error = new Error(`Popup list exposed ${cards.length} cards for ${expectedCount} serialized items. No unrelated CMS field was selected.`);
    error.stage = 'popup-item-target';
    throw error;
  }
  return cards;
}

async function openPopupListCard(page, targetIndex, description, { timeout = 10000, expectedCount = null, expectedImageUrl = null } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (attempts > 0 && await isPopupItemEditorOpen(page, 300)) return true;
    attempts += 1;

    let card = null;
    try {
      let cards = [];
      try {
        cards = await popupListItemCards(page, expectedCount);
      } catch (err) {
        cards = await popupListItemCards(page, null);
      }
      card = cards[targetIndex] || null;
      if (expectedImageUrl) {
        const expected = stableImageUrl(expectedImageUrl);
        let matchedCard = null;
        for (const candidate of cards) {
          const sources = await candidate.locator('img').evaluateAll((images) => images.map((image) => image.src || image.getAttribute('src') || '')).catch(() => []);
          if (sources.some((source) => stableImageUrl(source) === expected)) {
            matchedCard = candidate;
            break;
          }
        }
        if (!matchedCard) {
          const error = new Error('The replacement popup card was not matched by its existing image. Add block was not clicked.');
          error.stage = 'popup-item-target';
          throw error;
        }
        card = matchedCard;
      }
    } catch (error) {
      lastError = error;
    }

    if (card) {
      try {
        await card.evaluate((el) => {
          try {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          } catch {}
        }).catch(() => {});

        // Attempt 1: Direct click on card container with force
        if (typeof card.click === 'function') {
          await card.click({ force: true }).catch(() => {});
          if (await isPopupItemEditorOpen(page, 1500)) return true;
        }

        // Attempt 2: Click sub-element (interactive text, thumbnail, locator.first)
        try {
          const clickTarget = typeof card.locator === 'function'
            ? card.locator('span.truncate, .grow, img, [class*="thumbnail"], [class*="icon"], span, div').first()
            : null;
          if (clickTarget && await isElementDisplayed(clickTarget)) {
            await clickTarget.click({ force: true }).catch(() => {});
            if (await isPopupItemEditorOpen(page, 1500)) return true;
          }
        } catch {}

        // Attempt 3: Click the status text ("Not configured" / date) inside the card
        try {
          if (typeof card.getByText === 'function') {
            const statusTarget = card.getByText(/Not configured|Until\b|From\b|Active|Draft|Expired|\d{1,2}\/\d{1,2}\/\d{4}/i).first();
            if (await isElementDisplayed(statusTarget)) {
              await statusTarget.click({ force: true }).catch(() => {});
              if (await isPopupItemEditorOpen(page, 1500)) return true;
            }
          }
        } catch {}

        // Attempt 4: Native evaluate click on the card element and its children
        if (typeof card.evaluate === 'function') {
          await card.evaluate((el) => {
            el.click();
            const clickable = el.querySelector('span, div, p, a, [role="button"]') || el;
            clickable.click();
            clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }).catch(() => {});
          if (await isPopupItemEditorOpen(page, 1500)) return true;
        }

        // Attempt 5: Coordinate click inside the card (offset to avoid drag handle)
        if (typeof card.boundingBox === 'function' && page.mouse?.click) {
          const box = await card.boundingBox().catch(() => null);
          if (box && box.width > 8 && box.height > 8) {
            const x = Math.min(Math.max(70, Math.floor(box.width * 0.35)), Math.max(8, box.width - 18));
            const y = Math.max(2, Math.min(Math.floor(box.height / 2), box.height - 2));
            await page.mouse.click(box.x + x, box.y + y).catch(() => {});
            if (await isPopupItemEditorOpen(page, 1500)) return true;
          }
        }
      } catch (error) {
        lastError = error;
      }
    } else {
      // Direct Fallback if card locator was not resolved: click targetIndex-th status element in panel
      try {
        const panel = await popupListItemsPanel(page).catch(() => null);
        if (panel) {
          const statusTargets = panel.locator('text=/^(?:Not configured|Until\b|From\b|Active|Draft|Expired)|\d{1,2}\/\d{1,2}\/\d{4}/i');
          const count = await statusTargets.count().catch(() => 0);
          if (count > targetIndex) {
            const targetStatus = statusTargets.nth(targetIndex);
            if (typeof targetStatus.scrollIntoViewIfNeeded === 'function') {
              await targetStatus.scrollIntoViewIfNeeded().catch(() => {});
            }
            await targetStatus.click({ force: true }).catch(() => {});
            if (await isPopupItemEditorOpen(page, 2000)) return true;
          }
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (await isPopupItemEditorOpen(page, 300)) return true;
    await page.waitForTimeout(200);
  }
  const suffix = lastError?.message ? ` (${lastError.message})` : '';
  throw new Error(`${description} at popup item ${targetIndex + 1} was not available as a stable popup card${suffix}`);
}

async function readPopupListItems(page, expectedCount = null) {
  let candidateCheckboxes = null;

  // Strategy 1: Find inside active Announcement Popup drawer
  try {
    const drawer = await getActivePopupDrawer(page);
    if (drawer) {
      const scoped = drawer.locator('input[type="checkbox"][name^="check-all-list_items-"], input[name^="check-all-list_items-"]');
      if ((await scoped.count().catch(() => 0)) > 0) {
        candidateCheckboxes = scoped;
      }
    }
  } catch {}

  // Strategy 2: If Add block is available in the DOM, scope checkbox to its enclosing panel
  if (!candidateCheckboxes) {
    try {
      const addBlockLoc = page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")');
      const addBlock = safeLast(addBlockLoc);
      if ((await addBlockLoc.count().catch(() => 0)) > 0 && addBlock) {
        const panel = addBlock.locator('xpath=ancestor::div[.//input[contains(@name, "list_items")]][1]');
        const scoped = panel.locator('input[type="checkbox"][name^="check-all-list_items-"], input[name^="check-all-list_items-"]');
        if ((await scoped.count().catch(() => 0)) > 0) {
          candidateCheckboxes = scoped;
        }
      }
    } catch {}
  }

  // Strategy 3: Scoped to popupListItemsPanel
  if (!candidateCheckboxes) {
    try {
      const panel = await popupListItemsPanel(page).catch(() => null);
      if (panel) {
        const scoped = panel.locator('input[type="checkbox"][name^="check-all-list_items-"], input[name^="check-all-list_items-"]');
        if ((await scoped.count().catch(() => 0)) > 0) {
          candidateCheckboxes = scoped;
        }
      }
    } catch {}
  }

  const checkboxes = candidateCheckboxes || page.locator('input[type="checkbox"][name^="check-all-list_items-"], input[name^="check-all-list_items-"]');
  const count = await checkboxes.count().catch(() => 0);
  if (!count) return { chooseAll: null, items: [] };

  // Vue can retain several check-all inputs in one slideover during transitions.
  // Parse scoped snapshots and select the newest valid render.
  // If an expectedCount is requested (e.g. after a deletion or addition), immediately prefer it.
  // Otherwise, among non-empty snapshots, prefer the latest one in DOM order.
  let selected = null;
  let fallbackEmpty = null;
  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    const name = await checkbox.getAttribute('name').catch(() => null);
    const serialized = name?.startsWith('check-all-list_items-')
      ? name.slice('check-all-list_items-'.length)
      : null;
    if (serialized === null) continue;
    try {
      const items = JSON.parse(serialized || '[]');
      if (!Array.isArray(items)) continue;
      if (expectedCount !== null && items.length === expectedCount) {
        selected = { chooseAll: checkbox, items };
        break;
      }
      if (items.length > 0) {
        selected = { chooseAll: checkbox, items };
      } else if (!fallbackEmpty) {
        fallbackEmpty = { chooseAll: checkbox, items };
      }
    } catch {
      // Ignore a stale/partially rendered serialized value and inspect others.
    }
  }
  if (!selected && fallbackEmpty) selected = fallbackEmpty;
  if (selected) return selected;
  {
    const error = new Error('CMS popup item list could not be read safely. No popup was removed.');
    error.stage = 'popup-replacement-ambiguous';
    throw error;
  }
}

async function waitForPopupListItemCount(page, expected, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastItems = [];
  while (Date.now() < deadline) {
    const { items } = await readPopupListItems(page, expected);
    lastItems = items;
    if (items.length === expected) return items;
    await page.waitForTimeout(150);
  }
  throw new Error(`CMS popup list did not reach ${expected} item${expected === 1 ? '' : 's'} after the requested change.`);
}

function isEmptyPopupItem(item) {
  if (!item || typeof item !== 'object') return true;
  if (!String(item.image || '').trim()) return true;
  return ['time_start', 'time_end', 'image', 'image_alt', 'link', 'html_code']
    .every((key) => !String(item?.[key] || '').trim());
}

function planPopupItemTarget(items, { forceNewBlock = false, maxAllowedBlocks = null, itemIndex = null } = {}) {
  const current = Array.isArray(items) ? items : [];

  // If there's an existing unconfigured/empty block in the list, ALWAYS reuse it first
  // (even if forceNewBlock is true, to prevent creating duplicate blank placeholders).
  const firstEmptyIndex = current.findIndex(isEmptyPopupItem);
  if (firstEmptyIndex >= 0) {
    return {
      targetIndex: firstEmptyIndex,
      expectedCount: current.length,
      addBlock: false
    };
  }

  // Hard cap: If maxAllowedBlocks is specified and current item count has reached or exceeded it,
  // do NOT add any new block under any circumstances!
  if (Number.isInteger(maxAllowedBlocks) && current.length >= maxAllowedBlocks) {
    const fallbackIndex = Number.isInteger(itemIndex) && itemIndex >= 0 && itemIndex < current.length
      ? itemIndex
      : Math.max(0, current.length - 1);
    return {
      targetIndex: fallbackIndex,
      expectedCount: current.length,
      addBlock: false
    };
  }

  return {
    targetIndex: null,
    expectedCount: current.length + 1,
    addBlock: true
  };
}

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
  if (blankInsertedIndexes.length > 1) {
    const lastIndex = after.length - 1;
    const targetIndex = blankInsertedIndexes.includes(lastIndex) ? lastIndex : blankInsertedIndexes[0];
    return {
      targetIndex,
      expectedCount,
      method: 'appended-blank-card',
      reason: null
    };
  }
  const blankAfter = after
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isEmptyPopupItem(item));
  if (blankAfter.length === 1) {
    return {
      targetIndex: blankAfter[0].index,
      expectedCount,
      method: 'single-blank-after',
      reason: null
    };
  }
  if (blankAfter.length > 1) {
    // If multiple blank cards exist after adding, select the newly appended card at the end
    const lastBlank = blankAfter[blankAfter.length - 1].index;
    return {
      targetIndex: lastBlank,
      expectedCount,
      method: 'last-blank-after',
      reason: null
    };
  }
  return {
    targetIndex: null,
    expectedCount,
    method: null,
    reason: `multiple-inserted-blanks-${blankInsertedIndexes.join('-') || 'none'}`
  };
}

async function openPopupListItem(page, { forceNewBlock = false, replaceTargetIndex = null, replaceTargetImageUrl = null, maxAllowedBlocks = null, itemIndex = null, allowAddBlock = true } = {}) {
  await ensureDesktopViewport(page);
  await waitForPopupListItemsPanel(page, 4000).catch(() => {});
  const before = await readPopupListItems(page);
  let target;
  let items = before.items;
  if (Number.isInteger(replaceTargetIndex) && replaceTargetIndex >= 0 && replaceTargetIndex < before.items.length) {
    target = {
      targetIndex: replaceTargetIndex,
      expectedCount: before.items.length,
      addBlock: false
    };
  } else {
    if (before.items.length === 0) {
      const renderedCards = await popupListItemCards(page, null).catch(() => []);
      if (renderedCards.length > 0) {
        const error = new Error(
          `CMS rendered ${renderedCards.length} popup card${renderedCards.length === 1 ? '' : 's'} but serialized list state was empty. `
          + 'Add block was not clicked to avoid creating duplicate blank items.'
        );
        error.stage = 'popup-item-target';
        throw error;
      }
    }
    target = planPopupItemTarget(before.items, { forceNewBlock, maxAllowedBlocks, itemIndex });
    if (target.addBlock) {
      if (!allowAddBlock) {
        const error = new Error('This replacement workflow is not allowed to add a popup block. No CMS item was changed.');
        error.stage = 'popup-item-target';
        throw error;
      }
      const panel = await waitForPopupListItemsPanel(page, 6000).catch(() => null);
      const addBlockLocator = panel
        ? panel.getByRole('button', { name: /Add\s*block/i })
        : page.getByRole('button', { name: /Add\s*block/i });

      const addBlock = await waitForVisibleMatch(
        addBlockLocator,
        null,
        true,
        6000
      ).catch(() => null) || await waitForVisibleMatch(
        page.locator('button:has-text("Add block")'),
        'Popup Add block control',
        true,
        8000
      );
      await addBlock.evaluate((el) => {
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
      }).catch(() => {});
      await addBlock.click({ force: true });
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
    const firstEmptyIndex = before.items.findIndex(isEmptyPopupItem);
    const expectingBlank = Boolean(target.addBlock || (firstEmptyIndex >= 0 && target.targetIndex === firstEmptyIndex));
    if (expectingBlank && !isEmptyPopupItem(items[target.targetIndex])) {
      const error = new Error(
        `Popup item ${target.targetIndex + 1} is not blank before opening it. `
        + 'The ticket poster and dates were not changed.'
      );
      error.stage = 'popup-item-target';
      throw error;
    }
  }

  // Open the card editor (return to list first if already open to guarantee selecting the exact target index)
  if (await isPopupItemEditorOpen(page, 500)) {
    await backToPopupSettings(page);
  }
  await openPopupListCard(page, target.targetIndex, target.addBlock ? 'New popup block' : (Number.isInteger(replaceTargetIndex) ? 'Popup block for replacement' : 'Popup placeholder'), {
    expectedCount: target.expectedCount,
    expectedImageUrl: Number.isInteger(replaceTargetIndex) ? replaceTargetImageUrl : null
  });
  return { ...target, beforeItems: before.items };
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

async function popupImageUploadControl(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    // Parent CMS editors remain mounted while a popup item is open. Anchor to
    // the exact Image field of the current item; page-wide first/last file
    // inputs can belong to Media or another section.
    try {
      const imageLabel = await visibleLabel(page, 'Image', true, 0);
      const panel = imageLabel.locator('xpath=ancestor::div[3]');
      // New Announcement versions use either `image/*` or an extension list
      // such as `.jpg, .jpeg, .png, .svg, .webp`. The exact Image panel is
      // already the safety boundary, so do not require one accept spelling.
      const inputs = panel.locator('input[type="file"]');
      const scopedCount = await inputs.count().catch(() => 0);
      if (scopedCount === 1) return { input: inputs.first(), panel };
      if (scopedCount > 1) {
        const error = new Error(`Popup Image field is ambiguous (${scopedCount} upload controls). The ticket poster was not uploaded.`);
        error.stage = 'popup-item-target';
        throw error;
      }
    } catch (error) {
      if (error?.stage === 'popup-item-target') throw error;
    }

    const candidates = page.locator('input[type="file"][accept*="image" i]');
    const count = await candidates.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const input = candidates.nth(index);
      try {
        const label = input.locator('xpath=ancestor::label[1]');
        if (await isElementDisplayed(label)) {
          const text = await label.innerText().catch(() => '');
          if (/(?:click\s+to\s+)?(?:upload|change)\s+image/i.test(text)) {
            // Expand to ancestor div[3] from the label to capture the image preview area
            const widerPanel = label.locator('xpath=ancestor::div[3]');
            const panelOk = typeof widerPanel?.count === 'function' ? await isElementDisplayed(widerPanel).catch(() => false) : false;
            return { input, panel: panelOk ? widerPanel : label };
          }
        }
      } catch {}
    }

    // Priority 2: click to upload / change text container
    const uploadPrompt = page.locator('label, div, span, p').filter({ hasText: /Click to (?:upload|change) image/i }).first();
    if (await isElementDisplayed(uploadPrompt)) {
      const directInput = uploadPrompt.locator('input[type="file"]').first();
      if ((await directInput.count().catch(() => 0)) > 0) {
        const widerPanel = uploadPrompt.locator('xpath=ancestor::div[3]');
        const panelOk = await isElementDisplayed(widerPanel).catch(() => false);
        return { input: directInput, panel: panelOk ? widerPanel : uploadPrompt };
      }
      const followingInput = uploadPrompt.locator('xpath=following::input[@type="file"][1]');
      if ((await followingInput.count().catch(() => 0)) > 0) {
        const widerPanel = uploadPrompt.locator('xpath=ancestor::div[3]');
        const panelOk = await isElementDisplayed(widerPanel).catch(() => false);
        return { input: followingInput, panel: panelOk ? widerPanel : uploadPrompt };
      }
      const precedingInput = uploadPrompt.locator('xpath=preceding::input[@type="file"][1]');
      if ((await precedingInput.count().catch(() => 0)) > 0) {
        const widerPanel = uploadPrompt.locator('xpath=ancestor::div[3]');
        const panelOk = await isElementDisplayed(widerPanel).catch(() => false);
        return { input: precedingInput, panel: panelOk ? widerPanel : uploadPrompt };
      }
      if (count > 0) {
        const lastCandidate = typeof candidates.last === 'function' ? candidates.last() : candidates.nth(count - 1);
        const widerPanel = uploadPrompt.locator('xpath=ancestor::div[3]');
        const panelOk = await isElementDisplayed(widerPanel).catch(() => false);
        return { input: lastCandidate, panel: panelOk ? widerPanel : uploadPrompt };
      }
    }

    // Priority 3: Image label → file input following it
    try {
      const imageLabel = await visibleLabel(page, 'Image', true).catch(() => null);
      if (imageLabel) {
        const nextInput = imageLabel.locator('xpath=following::input[@type="file"][1]');
        if ((await nextInput.count().catch(() => 0)) > 0) {
          const imagePanel = imageLabel.locator('xpath=ancestor::div[3]');
          return { input: nextInput, panel: imagePanel };
        }
      }
    } catch {}

    if (timeout === 0) break;
    await page.waitForTimeout(120);
  } while (Date.now() < deadline);

  const error = new Error('Popup image upload control was not found. The ticket poster was not uploaded.');
  error.stage = 'popup-item-target';
  throw error;
}

async function popupImageUrls(imagePanel) {
  if (!imagePanel) return [];
  return imagePanel.locator('img').evaluateAll((images) => images
    .filter((img) => {
      if (typeof img === 'string') return true;
      if (img.closest && img.closest('iframe, [class*="preview"], [id*="preview"], header, nav, .site-header')) return false;
      return true;
    })
    .map((image) => (typeof image === 'string' ? image : (image?.src || '')))
    .filter((source) => source && !/\/images\/download\.png(?:$|\?)/.test(source) && !source.includes('logo') && !source.includes('about.jpeg') && !source.includes('ui-avatars.com'))
  ).catch(() => []);
}

async function waitForPopupImageUpload(page, imagePanel, previousImageUrls, timeout = 30000) {
  const before = Array.isArray(previousImageUrls) ? previousImageUrls : [];
  const deadline = Date.now() + timeout;
  if (!imagePanel) {
    throw new Error('Popup Image panel was not found. The ticket poster was not uploaded.');
  }

  // A CDN request only proves that some image moved through the page. It does
  // not prove that the current popup item's Vue model accepted that image.
  // Require the new preview to render inside this exact Image field.
  while (Date.now() < deadline) {
    const imgs = await popupImageUrls(imagePanel);
    const newImg = imgs.find((src) => !before.includes(src) && !src.includes('about.jpeg'));
    if (newImg) return { currentImageUrls: imgs, uploadedImageUrl: newImg };
    await pageDelay(page, 300);
  }

  throw new Error('CMS did not render the ticket poster inside the current Popup Image field after upload.');
}

async function setPopupImageLink(page, imageLink) {
  if (!imageLink || typeof imageLink !== 'string' || !imageLink.trim()) return null;
  const link = imageLink.trim();

  const candidateLabels = [
    'Image link',
    'Image link (optional)',
    'Link',
    'Link (optional)'
  ];

  for (const labelText of candidateLabels) {
    try {
      const { control } = await controlForLabel(page, labelText, true);
      if (control) {
        await control.fill('');
        await control.fill(link);
        await control.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, link).catch(() => {});
        await page.waitForTimeout(300);
        const value = await control.inputValue().catch(() => '');
        if (value === link) {
          emitProgress('popup-link', `Đã gắn link cho popup: ${link}`);
          return link;
        }
      }
    } catch {
      // try next
    }
  }

  // Fallback 1: find label by case-insensitive text match
  try {
    const labels = page.locator('label');
    const count = await labels.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const label = labels.nth(i);
      if (!await label.isVisible().catch(() => false)) continue;
      const text = (await label.innerText().catch(() => '')).trim();
      if (/^(?:image\s+)?link(?:\s*\(optional\))?$/i.test(text)) {
        const id = await label.getAttribute('for');
        let input = id ? page.locator(`[id="${id}"]`) : null;
        if (!input || !await input.isVisible().catch(() => false)) {
          input = label.locator('xpath=following::input[1]');
        }
        if (!input || !await input.isVisible().catch(() => false)) {
          input = label.locator('xpath=ancestor::div[1]//input');
        }
        if (input && await input.isVisible().catch(() => false)) {
          await input.fill('');
          await input.fill(link);
          await input.evaluate((el, val) => {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, link).catch(() => {});
          await page.waitForTimeout(300);
          emitProgress('popup-link', `Đã gắn link cho popup: ${link}`);
          return link;
        }
      }
    }
  } catch {
    // try direct input
  }

  // Fallback 2: look for direct input with matching name or placeholder
  try {
    const direct = page.locator('input[name="link"], input[name="image_link"], input[placeholder*="link" i], input[placeholder*="http" i]').last();
    if (await direct.isVisible().catch(() => false)) {
      await direct.fill('');
      await direct.fill(link);
      await direct.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, link).catch(() => {});
      await page.waitForTimeout(300);
      emitProgress('popup-link', `Đã gắn link cho popup: ${link}`);
      return link;
    }
  } catch {
    // ignore
  }

  emitProgress('popup-link-warning', `Không tìm thấy ô nhập link trong popup editor để gắn URL: ${link}`);
  return null;
}

async function configurePopupListItem(page, imagePath, schedule, timezone, { forceNewBlock = false, replaceTargetIndex = null, replaceTargetImageUrl = null, isReplacement = false, imageLink = null, maxAllowedBlocks = null, itemIndex = null, allowAddBlock = true } = {}) {
  const target = await openPopupListItem(page, { forceNewBlock, replaceTargetIndex, replaceTargetImageUrl, maxAllowedBlocks, itemIndex, allowAddBlock });
  const editorReady = await isPopupItemEditorOpen(page, 4000);
  if (!editorReady) {
    throw new Error('Popup list item editor was not found.');
  }

  // Locate image upload control AND the preview panel.
  // The panel MUST contain the preview <img> that appears after upload.
  // The original dist approach uses visibleLabel('Image') → ancestor::div[3] for the panel.
  const { input: imageInput, panel: imagePanel } = await popupImageUploadControl(page, 5000);

  const previousImageUrls = await popupImageUrls(imagePanel);
  const isTargetReplacement = Boolean(isReplacement || Number.isInteger(replaceTargetIndex));
  if (!isTargetReplacement && previousImageUrls.length > 0) {
    emitProgress('popup-item-target', `Popup item ${target.targetIndex + 1} có sẵn ảnh hoặc preview (${previousImageUrls.length} ảnh), tiến hành upload ảnh mới thay thế.`);
  }

  let start = null;
  if (schedule?.start) {
    start = await setPopupStart(page, schedule.start, timezone);
  } else {
    await clearPopupStartDate(page).catch(() => {});
  }

  let end = null;
  if (schedule?.end) {
    end = await setPopupExpiry(page, schedule.end);
  } else if (schedule?.isIndefinite || isReplacement) {
    await clearPopupEndDate(page).catch(() => {});
  }

  await imageInput.setInputFiles(imagePath);

  const { uploadedImageUrl } = await waitForPopupImageUpload(page, imagePanel, previousImageUrls);

  let configuredLink = null;
  if (imageLink && typeof imageLink === 'string' && imageLink.trim()) {
    configuredLink = await setPopupImageLink(page, imageLink);
  }

  await page.waitForTimeout(800);
  return {
    ...target,
    start: start?.date || null,
    end: end?.date || null,
    previewImageUrl: uploadedImageUrl,
    imageLink: configuredLink || imageLink || null
  };
}

async function backToPopupSettings(page) {
  const editorOpen = await isPopupItemEditorOpen(page, 200);
  if (!editorOpen) {
    const addBlock = page.locator('button:has-text("Add block"), [role="button"]:has-text("Add block")').first();
    const hasAddBlock = (await addBlock.count().catch(() => 0)) > 0;
    if (hasAddBlock && await isElementDisplayed(addBlock)) {
      // Also verify no Back button exists before assuming we're safely in list view
      const backBtn = page.locator('button:has-text("Back"), [role="button"]:has-text("Back"), .el-button:has-text("Back")').first();
      const hasBackBtn = (await backBtn.count().catch(() => 0)) > 0;
      if (!hasBackBtn || !await isElementDisplayed(backBtn)) {
        return;
      }
    }
  }

  const back = await visibleMatch(page.getByRole('button', { name: /^back$/i }), null, true)
    || await visibleMatch(page.locator('button:has-text("Back"), [role="button"]:has-text("Back"), .el-button:has-text("Back")'), null, true)
    || await visibleMatch(page.locator('button, [role="button"], a').filter({ hasText: /^\s*Back\s*$/i }), null, true)
    || await visibleMatch(page.locator('.el-icon-back, [class*="icon-back"], [class*="arrow-left"]').locator('xpath=ancestor-or-self::button | ancestor-or-self::div[@role="button"]'), null, true);

  if (back) {
    // Click Back ONCE to navigate from Item Editor to List Items.
    // NEVER click Back in a loop, as repeated clicks cause Nuxt UI drawers
    // to rapidly slide out and in (horizontal jitter) and navigate away from Announcement.
    await back.click({ force: true }).catch(() => {});
  }

  // Add block stays visible behind the nested item editor, so it cannot prove
  // that Back completed. Wait for the item editor itself to close.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await isPopupItemEditorOpen(page, 100)) break;
    await page.waitForTimeout(150);
  }
  if (await isPopupItemEditorOpen(page, 100)) {
    const error = new Error('Popup item editor did not close after Back. CMS list verification was not started.');
    error.stage = 'popup-item-persist';
    throw error;
  }
  await waitForPopupListItemsPanel(page, 5000);

  // Reset any horizontal scroll that may have shifted the drawer or viewport
  await page.evaluate(() => {
    try {
      window.scrollTo({ left: 0 });
      if (document.documentElement) document.documentElement.scrollLeft = 0;
      if (document.body) document.body.scrollLeft = 0;
      const scrollables = document.querySelectorAll('div, section, aside, [id="headlessui-portal-root"]');
      for (const el of scrollables) {
        if (el.scrollLeft > 0) el.scrollLeft = 0;
      }
    } catch {}
  }).catch(() => {});
}

async function waitForPersistedPopupItem(page, target, schedule, timezone, timeout = 30000) {
  let lastItems = [];
  let lastReason = 'not-observed';
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const { items } = await readPopupListItems(page);
      lastItems = items;
      const verification = verifyPersistedPopupItem({
        afterItems: items,
        targetIndex: target.targetIndex,
        expectedCount: target.expectedCount,
        schedule,
        timezone,
        previewImageUrl: target.previewImageUrl || null
      });
      lastReason = verification.reason || 'not-persisted';
      if (verification.ok) {
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

async function deletePopupItemAtIndex(page, targetIndex, expectedRemaining, description = 'Popup item', targetImageUrl = null) {
  await ensureDesktopViewport(page);
  const targetImage = targetImageUrl ? stableImageUrl(targetImageUrl) : null;
  const cards = await popupListItemCards(page).catch(() => []);
  let card = null;

  // 1. First, try to find the exact card by targetImage in the live DOM
  if (targetImage && cards.length > 0) {
    for (const candidate of cards) {
      const sources = await candidate.locator('img').evaluateAll((images) => images.map((image) => image.src || image.getAttribute('src') || '')).catch(() => []);
      if (sources.some((source) => stableImageUrl(source) === targetImage)) {
        card = candidate;
        break;
      }
    }
  }

  // 2. If not found by targetImage, read items and resolve by targetIndex or empty card
  if (!card) {
    const { items } = await readPopupListItems(page, expectedRemaining + 1).catch(() => ({ items: [] }));
    let resolvedIndex = targetIndex;
    if ((!Number.isInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= items.length) && targetImage) {
      const found = items.findIndex((item) => stableImageUrl(item?.image) === targetImage);
      if (found >= 0) resolvedIndex = found;
    }
    if (Number.isInteger(resolvedIndex) && resolvedIndex >= 0 && resolvedIndex < cards.length) {
      card = cards[resolvedIndex];
    } else if (Number.isInteger(resolvedIndex) && resolvedIndex >= 0 && resolvedIndex < items.length) {
      const targetItem = items[resolvedIndex];
      const fallbackImage = stableImageUrl(targetItem?.image || '');
      if (fallbackImage) {
        for (const candidate of cards) {
          const sources = await candidate.locator('img').evaluateAll((images) => images.map((image) => image.src || image.getAttribute('src') || '')).catch(() => []);
          if (sources.some((source) => stableImageUrl(source) === fallbackImage)) {
            card = candidate;
            break;
          }
        }
      } else if (isEmptyPopupItem(targetItem)) {
        for (const candidate of cards) {
          const text = await candidate.innerText().catch(() => '');
          const sources = await candidate.locator('img').evaluateAll((images) => images.map((image) => image.src || image.getAttribute('src') || '')).catch(() => []);
          const hasPoster = sources.some((source) => /(?:newzensite|gocheckin|\/media\/)/i.test(source));
          if (/Not configured/i.test(text) && !hasPoster) {
            card = candidate;
            break;
          }
        }
      }
    }
  }

  // 3. Fallback retry: If card was not found, check if Popup_setting accordion needs re-expanding
  if (!card) {
    try {
      const popupSetting = await visibleMatch(page.getByText(/Popup[\s_]setting/i), null, true).catch(() => null);
      if (popupSetting) {
        await popupSetting.click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
        const retryCards = await popupListItemCards(page).catch(() => []);
        if (targetImage && retryCards.length > 0) {
          for (const candidate of retryCards) {
            const sources = await candidate.locator('img').evaluateAll((images) => images.map((image) => image.src || image.getAttribute('src') || '')).catch(() => []);
            if (sources.some((source) => stableImageUrl(source) === targetImage)) {
              card = candidate;
              break;
            }
          }
        }
        if (!card && Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < retryCards.length) {
          card = retryCards[targetIndex];
        }
      }
    } catch {}
  }

  if (!card) {
    throw new Error(`${description} was not found in the CMS list.`);
  }
  await card.evaluate((el) => {
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {}
  }).catch(() => {});
  const menuButton = await visibleMatch(
    card.locator('button.button-drag, [class*="button-drag"], [class*="drag-handle"], button[class*="drag"], button:has(svg), svg.cursor-grab, svg.cursor-move, [role="button"]:has(svg)'),
    `${description} menu`,
    true
  ) || await visibleMatch(card.locator('button, [role="button"]').last(), `${description} menu`, true);
  await menuButton.click({ force: true });
  const menu = await waitForVisibleMatch(page.getByRole('menu'), `${description} menu`, true, 3000);
  const remove = await visibleMatch(
    menu.getByRole('menuitem', { name: /Delete(?:\s*item)?/i }),
    null,
    true
  ).catch(() => null) || await visibleMatch(
    menu.locator('button, [role="menuitem"], a, div').filter({ hasText: /Delete(?:\s*item)?/i }),
    null,
    true
  ).catch(() => null);
  if (remove) {
    await remove.click({ force: true }).catch(() => {});
  }
  const confirm = await waitForVisibleMatch(
    page.getByRole('button', { name: /^(?:Confirm|Delete|Yes|OK|Xóa)$/i }),
    `${description} delete confirmation`,
    true,
    2500
  ).catch(() => null) || await waitForVisibleMatch(
    page.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("Yes"), button:has-text("OK")'),
    `${description} delete confirmation`,
    true,
    1500
  ).catch(() => null);
  if (confirm) await confirm.click({ force: true }).catch(() => {});
  // Only press Escape if a modal overlay is still open; never press Escape unconditionally
  // as it closes the slideover drawer / settings panel in NewZen CMS.
  const modalStillOpen = await page.locator('.el-overlay:visible, .ant-modal-root:visible, [role="dialog"]:visible').count().catch(() => 0);
  if (modalStillOpen > 0) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await waitForPopupListItemCount(page, expectedRemaining);
  await page.waitForTimeout(300);
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
  if (Array.isArray(ticketEntries) && ticketEntries.length > 0) {
    const usedIndexes = new Set();
    return ticketEntries.map((entry, index) => {
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

  if (imagePath) {
    return [{
      ticketIndex: 0,
      candidateIndex: null,
      imagePath,
      filename: ticketFilename || path.basename(imagePath),
      schedule: {
        start: schedule?.start?.date ? { date: schedule.start.date } : null,
        end: schedule?.end?.date ? { date: schedule.end.date } : null
      }
    }];
  }

  return [];
}

function buildPopupEntriesForTickets(ticketEntries, legacyPopups = [], duplicateMatches = [], { replaceExisting = false, popupPosition = 'first', replacementMatches = [] } = {}) {
  const normalizedTickets = Array.isArray(ticketEntries) ? ticketEntries : [];
  const matchedTicketIndexes = new Set();
  const matchingLegacyIndexes = [];
  const legacyToTicketMap = new Map();

  for (const match of duplicateMatches) {
    if (match && Number.isInteger(match.cmsIndex) && Number.isInteger(match.ticketIndex)) {
      legacyToTicketMap.set(match.cmsIndex, match.ticketIndex);
    }
  }

  for (const match of (replacementMatches || [])) {
    if (match && Number.isInteger(match.cmsIndex)) {
      const ticketIdx = Number.isInteger(match.ticketIndex)
        ? match.ticketIndex
        : (normalizedTickets.find((t) => !matchedTicketIndexes.has(t.ticketIndex))?.ticketIndex ?? 0);
      if (!legacyToTicketMap.has(match.cmsIndex) && !matchedTicketIndexes.has(ticketIdx)) {
        legacyToTicketMap.set(match.cmsIndex, ticketIdx);
      }
    }
  }

  if (replaceExisting && duplicateMatches.length === 0 && legacyToTicketMap.size === 0 && legacyPopups.length >= 1 && normalizedTickets.length >= 1) {
    legacyToTicketMap.set(0, normalizedTickets[0].ticketIndex ?? 0);
  }

  const legacyEntries = legacyPopups.map((legacy, legacyIndex) => {
    let ticket = null;
    if (legacyToTicketMap.has(legacyIndex)) {
      const tIndex = legacyToTicketMap.get(legacyIndex);
      ticket = normalizedTickets.find((c) => c.ticketIndex === tIndex) || null;
    }
    if (!ticket) {
      const legacyIdentity = popupImageIdentity(legacy?.sourceImageUrl);
      ticket = legacyIdentity
        ? normalizedTickets.find((candidate) => (
          !matchedTicketIndexes.has(candidate.ticketIndex)
          && popupImageIdentity(candidate.filename || (candidate.imagePath ? path.basename(candidate.imagePath) : (candidate.uploadPath ? path.basename(candidate.uploadPath) : ''))) === legacyIdentity
        ))
        : null;
    }
    if (ticket) {
      matchedTicketIndexes.add(ticket.ticketIndex);
      matchingLegacyIndexes.push(legacyIndex);
      return {
        imagePath: ticket.uploadPath || ticket.path || ticket.imagePath || legacy.imagePath,
        schedule: {
          start: ticket.schedule?.start || null,
          end: ticket.schedule?.end || legacy.end
        },
        imageLink: ticket.imageLink || legacy.imageLink || null,
        isTicket: true,
        ticketIndexes: [ticket.ticketIndex]
      };
    }
    return {
      imagePath: legacy.imagePath,
      schedule: {
        start: legacy.start || null,
        end: legacy.end || null
      },
      imageLink: legacy.imageLink || null,
      isTicket: false,
      ticketIndexes: []
    };
  });

  const newTicketEntries = [];
  for (const ticket of normalizedTickets) {
    if (matchedTicketIndexes.has(ticket.ticketIndex)) continue;
    newTicketEntries.push({
      imagePath: ticket.uploadPath || ticket.path || ticket.imagePath,
      schedule: ticket.schedule,
      imageLink: ticket.imageLink || null,
      isTicket: true,
      ticketIndexes: [ticket.ticketIndex]
    });
  }

  // Default: New ticket entries are placed at the top (Card 1 / first position) unless explicitly requested 'last'
  const entries = popupPosition === 'last'
    ? [...legacyEntries, ...newTicketEntries]
    : [...newTicketEntries, ...legacyEntries];

  return {
    entries,
    matchingLegacyIndex: matchingLegacyIndexes[0] ?? -1,
    matchingLegacyIndexes
  };
}

function buildPopupEntries(imagePath, schedule, legacyPopups, { ticketFilename = null, replaceExisting = false, popupPosition = 'first' } = {}) {
  const tickets = normalizeTicketPopupEntries(null, imagePath, schedule, ticketFilename);
  return buildPopupEntriesForTickets(tickets, legacyPopups, [], { replaceExisting, popupPosition });
}

module.exports = {
  setProgressHandler,
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
  popupItemsForReport,
  setTimeDelaySlider
};
