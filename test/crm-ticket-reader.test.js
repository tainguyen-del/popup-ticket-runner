const test = require('node:test');
const assert = require('node:assert/strict');
const {
  browserProblem,
  ticketNumberFromUrl,
  ticketMarkerPattern,
  hasWebsiteIdHeader,
  isInlineTicketImageUrl,
  filenameFromImageUrl,
  isElementDisplayed
} = require('../src/crm/ticket-reader');

test('reads a CRM detail ticket number without accepting unrelated paths', () => {
  assert.equal(ticketNumberFromUrl('https://crm.fastboy.dev/tickets/detail/1590155'), '1590155');
  assert.equal(ticketNumberFromUrl('https://crm.fastboy.dev/tickets/views/technical'), null);
});

test('matches only the exact active ticket marker', () => {
  const marker = ticketMarkerPattern('1580447');
  assert.equal(marker.test('ID#1580447 - Website Support'), true);
  assert.equal(marker.test('ID#15804470 - Website Support'), false);
  assert.equal(marker.test('#1580446 - Website Support'), false);
});

test('recognizes a Website ID header separately from the CRM ticket number', () => {
  assert.equal(hasWebsiteIdHeader('ID#5300 - Design poster'), true);
  assert.equal(hasWebsiteIdHeader('#1590155'), false);
});

test('accepts only CRM storage object images as inline ticket attachments', () => {
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/im/poster.png'), true);
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/an/anh-man-hinh.png'), true);
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/16/1611-16714.png'), true);
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/c3/test.png'), true);
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/av/avatar.png'), false);
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/avatar/user.png'), false);
  assert.equal(isInlineTicketImageUrl('https://example.com/crm/storage_objects/im/poster.png'), false);
});

test('derives safe attachment filenames from image URLs', () => {
  assert.equal(filenameFromImageUrl('https://storage.fastboy.dev/crm/storage_objects/im/Poster%20One.png?x=1'), 'Poster%20One.png');
  assert.equal(filenameFromImageUrl('not-a-url', 'fallback.webp'), 'fallback.webp');
});

test('reports browser offline only when the page and navigator agree', () => {
  assert.equal(browserProblem('No internet connection', false), 'browser-offline');
  assert.equal(browserProblem('No internet connection', true), null);
  assert.equal(browserProblem('Ticket loaded', false), null);
});

test('isElementDisplayed returns true when locator is visible', async () => {
  const locator = {
    isVisible: async () => true,
    evaluate: async () => true
  };
  assert.equal(await isElementDisplayed(locator), true);
});

test('isElementDisplayed rejects zero-size controls when the window is minimized', async () => {
  const locator = {
    isVisible: async () => false,
    evaluate: async (fn) => {
      // Simulate an element that has display: block in DOM even if minimized (0x0 rect)
      const fakeElement = {
        parentElement: null,
        hidden: false,
        getAttribute: () => null,
        hasAttribute: () => false,
        getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
      };
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
        innerWidth: 0,
        innerHeight: 0
      };
      global.document = { documentElement: { clientWidth: 0, clientHeight: 0 } };
      global.Element = Object;
      try {
        return fn(fakeElement);
      } finally {
        delete global.window;
        delete global.document;
        delete global.Element;
      }
    }
  };
  assert.equal(await isElementDisplayed(locator), false);
});

test('isElementDisplayed returns false when element is display: none in DOM', async () => {
  const locator = {
    isVisible: async () => false,
    evaluate: async (fn) => {
      const fakeElement = {
        parentElement: null,
        hidden: false,
        getAttribute: () => null,
        hasAttribute: () => false,
        getBoundingClientRect: () => ({ width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20 })
      };
      global.window = {
        getComputedStyle: () => ({ display: 'none', visibility: 'visible', opacity: '1' }),
        innerWidth: 100,
        innerHeight: 100
      };
      global.document = { documentElement: { clientWidth: 100, clientHeight: 100 } };
      global.Element = Object;
      try {
        return fn(fakeElement);
      } finally {
        delete global.window;
        delete global.document;
        delete global.Element;
      }
    }
  };
  assert.equal(await isElementDisplayed(locator), false);
});

test('isElementDisplayed returns false when locator is null or throws', async () => {
  assert.equal(await isElementDisplayed(null), false);
  const throwingLocator = {
    isVisible: async () => { throw new Error('disconnected'); },
    evaluate: async () => { throw new Error('disconnected'); }
  };
  assert.equal(await isElementDisplayed(throwingLocator), false);
});
