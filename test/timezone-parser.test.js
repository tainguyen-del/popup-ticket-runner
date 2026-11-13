const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonObject, repairWrappedJson, resolveTimezoneFromData } = require('../src/run');

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
