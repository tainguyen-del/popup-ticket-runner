const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonObject, repairWrappedJson, resolveTimezoneFromData, usStateFromZip, usStateFromAddress, discoverProjectTimezone } = require('../src/run');

test('reads a NewZen setting.json address that contains non-breaking editor spaces', () => {
  const editorText = [
    'setting.json',
    '1',
    '2',
    '{',
    '\u00a0\u00a0"en": {',
    '\u00a0\u00a0\u00a0\u00a0"address": {',
    '\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0"content": "<p>3349\u00a0Valley Pike #1200, Winchester, VA 22602</p>"',
    '\u00a0\u00a0\u00a0\u00a0}',
    '\u00a0\u00a0}',
    '}'
  ].join('\n');
  const data = JSON.parse(repairWrappedJson(extractJsonObject(editorText)));
  const timezone = resolveTimezoneFromData(data);

  assert.equal(timezone.iana, 'America/New_York');
  assert.equal(timezone.cmsLabel, 'New York (UTC-05:00)');
  assert.match(timezone.address, /Winchester, VA 22602/);
});

test('resolves Cape Coral Florida from footer-style address text', () => {
  const timezone = resolveTimezoneFromData({
    footer: '<p>Top Nail Salon Cape Coral, FL 33909 | L V Nails & Spa | NE Pine Island Rd</p>'
  });

  assert.equal(timezone.state, 'FL');
  assert.equal(timezone.iana, 'America/New_York');
  assert.equal(timezone.cmsLabel, 'New York (UTC-05:00)');
});

test('resolves California Los Angeles timezone from CA 95605 with comma or dash', () => {
  const withComma = resolveTimezoneFromData({
    en: { address: { content: '<p>1025 Jefferson Blvd, West Sacramento, CA, 95605</p>' } }
  });
  assert.equal(withComma.state, 'CA');
  assert.equal(withComma.iana, 'America/Los_Angeles');
  assert.equal(withComma.cmsLabel, 'Los Angeles (UTC-08:00)');

  const withDash = resolveTimezoneFromData({
    address: '1025 Jefferson Blvd, West Sacramento, CA - 95605'
  });
  assert.equal(withDash.state, 'CA');
  assert.equal(withDash.iana, 'America/Los_Angeles');

  const fullNameWithComma = resolveTimezoneFromData({
    address: '1025 Jefferson Blvd, West Sacramento, California, 95605'
  });
  assert.equal(fullNameWithComma.state, 'CA');
  assert.equal(fullNameWithComma.iana, 'America/Los_Angeles');
});

test('resolves state and timezone from 5-digit zip code 95605 directly', () => {
  assert.equal(usStateFromZip('95605'), 'CA');
  assert.equal(usStateFromZip('33909'), 'FL');
  assert.equal(usStateFromZip('75001'), 'TX');
  assert.equal(usStateFromZip('10001'), 'NY');

  const zipAddress = resolveTimezoneFromData({
    address: '1025 Jefferson Blvd, West Sacramento 95605'
  });
  assert.equal(zipAddress.state, 'CA');
  assert.equal(zipAddress.iana, 'America/Los_Angeles');
});

test('resolves timezone from structured JSON fields in setting.json or footer.json', () => {
  const structured = resolveTimezoneFromData({
    contact: {
      address: '1025 Jefferson Blvd',
      city: 'West Sacramento',
      state: 'CA',
      zip: '95605'
    }
  });
  assert.equal(structured.state, 'CA');
  assert.equal(structured.iana, 'America/Los_Angeles');
  assert.equal(structured.cmsLabel, 'Los Angeles (UTC-08:00)');

  const zipOnlyStructured = resolveTimezoneFromData({
    footer: {
      city: 'West Sacramento',
      postal_code: '95605'
    }
  });
  assert.equal(zipOnlyStructured.state, 'CA');
  assert.equal(zipOnlyStructured.iana, 'America/Los_Angeles');
});

test('does not mistake a media filename number for a ZIP code before finding the real address', () => {
  const timezone = resolveTimezoneFromData({
    preview: 'https://nz-website-media-r2-pub.gocheckin.net/2989-8829/page/footer-preview-57321.webp',
    footer: 'Top Nail Salon Cape Coral, FL 33909 | L V Nails & Spa'
  });

  assert.equal(timezone.address, 'Top Nail Salon Cape Coral, FL 33909 | L V Nails & Spa');
  assert.equal(timezone.state, 'FL');
  assert.equal(timezone.iana, 'America/New_York');
});

test('accepts a spelled-out US state before a ZIP code', () => {
  const timezone = resolveTimezoneFromData({ address: '123 Main Street, Cape Coral, Florida 33909' });

  assert.equal(timezone.state, 'FL');
  assert.equal(timezone.iana, 'America/New_York');
});

test('covers every US state and Washington DC at state-default level', () => {
  const states = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
    'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
    'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
  ];
  for (const state of states) {
    const timezone = resolveTimezoneFromData({ address: `100 Main Street, Example, ${state} 12345` });
    assert.ok(timezone.iana, `${state} should have a state-default timezone`);
    assert.ok(timezone.cmsLabel, `${state} should have a CMS timezone label`);
  }
});

test('resolves Canadian addresses with postal codes to correct timezone', () => {
  const ontario = resolveTimezoneFromData({
    address: '279 Yonge St Unit 2, Barrie, ON L4N 7T9'
  });
  assert.equal(ontario.state, 'ON');
  assert.equal(ontario.iana, 'America/Toronto');
  assert.equal(ontario.cmsLabel, 'New York (UTC-05:00)');

  const bc = resolveTimezoneFromData({
    address: '123 Robson St, Vancouver, BC V6B 2B3'
  });
  assert.equal(bc.state, 'BC');
  assert.equal(bc.iana, 'America/Vancouver');
  assert.equal(bc.cmsLabel, 'Los Angeles (UTC-08:00)');
});

test('discoverProjectTimezone resolves timezone from ticket notes when CMS files are missing', async () => {
  const fakePage = {
    url: () => 'https://apps.newzensite.com/projects/12345/plugins',
    goto: async () => {},
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async () => {}
  };
  const tz = await discoverProjectTimezone(fakePage, 'https://apps.newzensite.com/projects/12345', {
    ticketText: 'Salon address: 1025 Jefferson Blvd, West Sacramento, CA 95605'
  });
  assert.equal(tz.state, 'CA');
  assert.equal(tz.iana, 'America/Los_Angeles');
  assert.equal(tz.cmsLabel, 'Los Angeles (UTC-08:00)');
  assert.equal(tz.source, 'ticket-text');
});
