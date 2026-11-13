const test = require('node:test');
const assert = require('node:assert/strict');
const {
  browserProblem,
  ticketNumberFromUrl,
  ticketMarkerPattern,
  hasWebsiteIdHeader,
  isInlineTicketImageUrl,
  filenameFromImageUrl
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
