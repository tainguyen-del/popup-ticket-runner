const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ticketData,
  ticketMarkerPattern,
  buildPopupEntries,
  isInlineTicketImageUrl,
  resolveRemovalScopeFromAttachments,
  popupTicketEntriesFromDownloads,
  shouldUseTicketVision,
  planPopupItemTarget,
  resolveAddedPopupItemTarget,
  verifyPersistedPopupItem,
  resolvePopupItemByImageAndSchedule,
  attachmentMatchEvidence,
  projectDomainsFromText,
  chooseProjectCandidate,
  announcementPluginVersionFromText,
  mustCreateFreshAnnouncementSection
} = require('../src/run');
const { hasWebsiteIdHeader } = require('../src/crm/ticket-reader');

function parsed(text, ticketNumber) {
  return ticketData(text, `https://crm.fastboy.dev/tickets/detail/${ticketNumber}`);
}

test('keeps a missing start date empty and reads a Vietnamese expiry phrase', () => {
  const ticket = parsed([
    'ID#169 - Pop up website',
    '#1580297',
    'Nhờ team hỗ trợ đăng Poster (đính kèm) pop up giúp tiệm đến hết 12/31/2026'
  ].join('\n'), 1580297);
  assert.equal(ticket.siteId, '169');
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiryDate, '2026-12-31');
});

test('reads a dotted two-digit US expiry after until', () => {
  const ticket = parsed([
    'ID#16266 - Website Support_pop-up',
    '#1582375',
    'Nhờ team hỗ trợ pop-up ảnh này lên trang web tiệm until 11.30.26'
  ].join('\n'), 1582375);
  assert.equal(ticket.siteId, '16266');
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiryDate, '2026-11-30');
});

test('infers a shared end-of-month expiry from a Vietnamese two-poster request', () => {
  const ticket = parsed([
    'ID#2554 - Website Support',
    '#1580706',
    'Nov 4, 2026',
    // ASCII-folded representation keeps this regression independent of the
    // terminal code page used to run the local Windows test suite.
    'toi het thang 11',
    'Nhá» team há»— trá»£ pop-up poster lÃªn website giÃºp tiá»‡m tá»›i háº¿t thÃ¡ng 11 nha'
  ].join('\n'), 1580706);
  assert.equal(ticket.siteId, '2554');
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiryDate, '2026-11-30');
});

test('does not borrow the Website ID from an older CRM ticket tab', () => {
  const ticket = parsed([
    'ID#19834 - Website Support',
    '#1579195',
    'ID#169 - Pop up website',
    '#1580297',
    'Poster đính kèm, pop up đến hết 12/31/2026'
  ].join('\n'), 1580297);
  assert.equal(ticket.siteId, '169');
  assert.equal(ticket.startDate, null);
});

test('recognizes the CRM header format ID#ticket-number', () => {
  const marker = ticketMarkerPattern('1580447');
  assert.equal(marker.test('ID#1580447 - Website Support'), true);
  assert.equal(marker.test('ID#15804470 - Website Support'), false);
  assert.equal(marker.test('ID#1580446 - Website Support'), false);
});

test('reads the Website ID from an isolated CRM detail panel without the route ticket marker', () => {
  const ticket = parsed([
    'ID#398 - Website Support',
    'Holiday Closure',
    'Popup start date: 11/05/2026 9:30 AM',
    'Time end: 01/02/2027 11:59 PM'
  ].join('\n'), 1580447);
  assert.equal(ticket.siteId, '398');
  assert.equal(ticket.startDate, '2026-11-05');
  assert.equal(ticket.expiryDate, '2027-01-02');
});

test('reads ticket-provided popup start and end dates', () => {
  const ticket = parsed([
    'ID#398 - Website Support',
    '#1580447',
    'Popup start date: 11/05/2026 9:30 AM',
    'Time end: 12/31/2026 11:59 PM'
  ].join('\n'), 1580447);
  assert.equal(ticket.startDate, '2026-11-05');
  assert.equal(ticket.expiryDate, '2026-12-31');
});

test('rolls an explicit cross-year popup range forward when the end repeats the start year', () => {
  const ticket = parsed([
    'ID#398 - Website Support',
    'Dang popup tu ngay 11/19/2026 den ngay 01/02/2026 se go xuong'
  ].join('\n'), 1580447);
  assert.equal(ticket.startDate, '2026-11-19');
  assert.equal(ticket.expiryDate, '2027-01-02');
  assert.equal(ticket.endYearRolledOver, true);
  assert.equal(ticket.scheduleError, null);
});

test('reads English range labels with incidental time text', () => {
  const ticket = parsed([
    'ID#398 - Website Support',
    'Show from November 19, 2026 at 9:30 AM through January 2, 2027 at 11:59 PM.'
  ].join('\n'), 1580447);
  assert.equal(ticket.startDate, '2026-11-19');
  assert.equal(ticket.expiryDate, '2027-01-02');
});

test('reads separately labelled dates while ignoring clock text', () => {
  const ticket = parsed([
    'ID#398 - Website Support',
    'Popup start date: 2026-11-19',
    'Start time: 14:05',
    'End date: 2027-01-02',
    'End time: 23:15'
  ].join('\n'), 1580447);
  assert.equal(ticket.startDate, '2026-11-19');
  assert.equal(ticket.expiryDate, '2027-01-02');
});

test('blocks an implausible reversed popup range instead of guessing a year', () => {
  const ticket = parsed([
    'ID#398 - Website Support',
    'Popup start: 03/01/2026; end: 02/01/2026'
  ].join('\n'), 1580447);
  assert.match(ticket.scheduleError, /before its start date/i);
});

test('marks a clear old-popup replacement request as replace', () => {
  const ticket = parsed([
    'ID#7134 - Website Support',
    '#1580592',
    'Gỡ popup cũ và add popup mới giúp tiệm.',
    'Expiry: 12/31/2026'
  ].join('\n'), 1580592);
  assert.equal(ticket.popupAction, 'replace');
  assert.equal(ticket.expiryDate, '2026-12-31');
});

test('treats Remove poster Halloween plus a popup update as replace', () => {
  const ticket = parsed([
    'ID#7134 - Website Support',
    '#1580592',
    'Team pop up giup, update muc coupon luon nha team.',
    'Remove poster Halloween a'
  ].join('\n'), 1580592);
  assert.equal(ticket.popupAction, 'replace');
});

test('recognizes a standalone poster removal without treating it as a replacement', () => {
  const ticket = parsed([
    'ID#7134 - Website Support',
    '#1580592',
    'Remove poster Halloween a'
  ].join('\n'), 1580592);
  assert.equal(ticket.popupRequested, true);
  assert.equal(ticket.popupAction, 'remove-one');
});

test('does not mistake "hoan tat design Poster" for a request to turn off a poster', () => {
  const ticket = parsed([
    'ID#5300 - Design poster',
    '#1590155',
    'Gui AE RECHECK sau khi hoan tat design Poster + Content: Yes',
    'Hi team, Nho team popup poster.',
    'EXP: 11/30/2026'
  ].join('\n'), 1590155);
  assert.equal(ticket.popupRequested, true);
  assert.equal(ticket.popupAction, 'create');
  assert.equal(ticket.expiryDate, '2026-11-30');
});

test('reads an explicit request to place the new popup at the end', () => {
  const ticket = parsed([
    'ID#5521 - Website Support',
    '#1591107',
    'Please add the attached popup poster. Popup position: last.'
  ].join('\n'), 1591107);
  assert.equal(ticket.popupPosition, 'last');
});

test('treats popup show cuối cùng as ordering and never borrows EXP as a start date', () => {
  const ticket = parsed([
    'ID - 2022 - Website Support',
    '#1591107',
    'Nhờ team hỗ trợ popup show cuối cùng nha',
    'EXP: 11/26/2026'
  ].join('\n'), 1591107);
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiryDate, '2026-11-26');
  assert.equal(ticket.popupPosition, 'last');
});

test('reads varied English and Vietnamese last-position instructions', () => {
  assert.equal(parsed('ID#5521 - Support\nKeep this poster at the bottom of the popup list.', 1591107).popupPosition, 'last');
  assert.equal(parsed('ID#5521 - Support\nCho ảnh popup này xuống vị trí cuối cùng.', 1591107).popupPosition, 'last');
});

test('does not treat last-updated metadata as a popup position request', () => {
  const ticket = parsed([
    'ID#5521 - Website Support',
    '#1591107',
    'Last updated by support. Please add the attached popup poster.'
  ].join('\n'), 1591107);
  assert.equal(ticket.popupPosition, null);
});

test('does not treat popup end date or end time as an ordering request', () => {
  assert.equal(parsed('ID#5521 - Support\nShow popup end date: 12/31/2026', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nSet popup end time 11:59 PM', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nShow announcement end date 2027-01-02', 1591107).popupPosition, null);
});

test('recognizes Vietnamese removal of a specific popup poster', () => {
  const ticket = parsed([
    'ID#3317 - Update website',
    '#1580734',
    'Nhờ team tắt popup này giúp tiệm'
  ].join('\n'), 1580734);
  assert.equal(ticket.popupRequested, true);
  assert.equal(ticket.popupAction, 'remove-one');
});

test('recognizes an explicit request to remove every popup', () => {
  const ticket = parsed([
    'ID#13566 - Website Support',
    '#1585226',
    'Vui lòng gỡ toàn bộ popup hiện có trên website.'
  ].join('\n'), 1585226);
  assert.equal(ticket.popupRequested, true);
  assert.equal(ticket.popupAction, 'remove-all');
});

test('never promotes remove-one to remove-all merely because CRM image detection found nothing', () => {
  assert.equal(
    resolveRemovalScopeFromAttachments({ popupAction: 'remove-one' }, []).popupAction,
    'remove-one'
  );
  assert.equal(
    resolveRemovalScopeFromAttachments({ popupAction: 'remove-one' }, [{ index: 1, filename: 'old-popup.png' }]).popupAction,
    'remove-one'
  );
});

test('requires the all/every quantifier to target popups in the same removal instruction', () => {
  assert.equal(parsed('ID#3317 - Support\nRemove this popup. Thanks all.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nRemove attached popup; leave all other popups unchanged.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nDelete this poster. Every other section stays.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nPlease remove every existing popup.', 1591107).popupAction, 'remove-all');
  assert.equal(parsed('ID#3317 - Support\nDo not remove all popups; remove only the attached popup.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nRemove attached popup but keep all remaining popups unchanged.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nRemove every expired popup but keep active popups.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nNever remove all popups; remove only attached popup.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nYou must not remove all popups; remove this one only.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nĐừng xóa toàn bộ popup, chỉ xóa popup trong ảnh.', 1591107).popupAction, 'remove-one');
});

test('does not treat natural-language popup expiry as an ordering request', () => {
  assert.equal(parsed('ID#5521 - Support\nKeep popup until end of December.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nPlease add popup at end of month.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nPopup is valid to the end of November.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nKeep popup until month end.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nĐể popup đến cuối tháng 11.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nGiữ popup đến cuối năm.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nKeep popup until the end of this month.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nKeep popup through end of current month.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nKeep poster until campaign end.', 1591107).popupPosition, null);
  assert.equal(parsed('ID#5521 - Support\nPlace popup until campaign end.', 1591107).popupPosition, null);
});

test('negated requests to add a new popup never turn removal into replacement', () => {
  assert.equal(parsed('ID#3317 - Support\nRemove this popup; do not add a new popup.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nDelete old banner only, no new popup should be added.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nKhông thêm popup mới, chỉ xóa popup cũ.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nNever add a new popup; remove the old popup.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nShould not add a popup; remove this poster.', 1591107).popupAction, 'remove-one');
  assert.equal(parsed('ID#3317 - Support\nĐừng thêm popup mới, chỉ tắt popup này.', 1591107).popupAction, 'remove-one');
});

test('recognizes only CRM rich-text storage images as inline ticket attachments', () => {
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/im/image-example.png'), true);
  assert.equal(isInlineTicketImageUrl('https://storage.fastboy.dev/crm/storage_objects/av/avatar-example.png'), false);
  assert.equal(isInlineTicketImageUrl('https://example.com/poster.png'), false);
});

test('does not invent a start date when moving a matching legacy popup', () => {
  const { entries, matchingLegacyIndex } = buildPopupEntries(
    'C:/tmp/Poster (11).png',
    { start: null, end: { date: '2026-11-30' } },
    [{
      imagePath: 'C:/tmp/legacy-popup-1.webp',
      sourceImageUrl: 'https://cdn.example/index-Poster(11)-12345.webp',
      start: { date: '2026-11-05' },
      end: null
    }]
  );
  assert.equal(matchingLegacyIndex, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].schedule.start, null);
  assert.equal(entries[0].schedule.end.date, '2026-11-30');
});

test('adds a second block only after the first popup entry', () => {
  const { entries } = buildPopupEntries(
    'C:/tmp/ticket.png',
    { start: null, end: null },
    [
      { imagePath: 'C:/tmp/legacy-1.webp', sourceImageUrl: 'https://cdn.example/legacy-1.webp', start: null, end: null },
      { imagePath: 'C:/tmp/legacy-2.webp', sourceImageUrl: 'https://cdn.example/legacy-2.webp', start: null, end: null }
    ]
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].isTicket, false);
  assert.equal(entries[1].isTicket, false);
  assert.equal(entries[2].isTicket, true);
});

test('keeps two staged ticket posters as distinct popup entries with the shared schedule', () => {
  const schedule = { start: null, end: { date: '2026-11-30' } };
  const entries = popupTicketEntriesFromDownloads([
    { candidateIndex: 1, filename: 'holiday-hours.png', sha256: 'one', uploadPath: 'C:/tmp/holiday-hours.png' },
    { candidateIndex: 2, filename: 'special-offer.png', sha256: 'two', uploadPath: 'C:/tmp/special-offer.png' }
  ], schedule);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.candidateIndex), [1, 2]);
  assert.deepEqual(entries.map((entry) => entry.schedule), [schedule, schedule]);
  assert.notEqual(entries[0].imagePath, entries[1].imagePath);
});

test('uses Vision for a single new poster so artwork-only dates can be read', () => {
  assert.equal(shouldUseTicketVision('create', 1), true);
  assert.equal(shouldUseTicketVision('replace', 1), true);
  assert.equal(shouldUseTicketVision('remove-one', 1), false);
  assert.equal(shouldUseTicketVision('create', 0), false);
});

test('uses a validated schedule per poster while ticket dates override artwork field by field', () => {
  const entries = popupTicketEntriesFromDownloads([
    { candidateIndex: 1, filename: 'gift-card.png', sha256: 'one', uploadPath: 'C:/tmp/gift-card.png' },
    { candidateIndex: 2, filename: 'holiday-closure.png', sha256: 'two', uploadPath: 'C:/tmp/holiday-closure.png' }
  ], {
    start: { date: '2026-11-15' },
    end: null
  }, [
    {
      attachmentIndex: 1,
      startDate: '2026-11-01',
      endDate: '2026-12-31',
      evidence: 'Valid November 1 to December 31',
      confidence: 0.97
    },
    {
      attachmentIndex: 2,
      startDate: null,
      endDate: null,
      evidence: null,
      confidence: 0
    }
  ]);

  assert.deepEqual(entries[0].schedule, {
    start: { date: '2026-11-15' },
    end: { date: '2026-12-31' }
  });
  assert.deepEqual(entries[1].schedule, {
    start: { date: '2026-11-15' },
    end: null
  });
});

test('rejects duplicate image data before a two-poster CMS workflow can start', () => {
  let error = null;
  try {
    popupTicketEntriesFromDownloads([
      { candidateIndex: 1, filename: 'one.png', sha256: 'same', uploadPath: 'C:/tmp/one.png' },
      { candidateIndex: 2, filename: 'two.png', sha256: 'same', uploadPath: 'C:/tmp/two.png' }
    ], { start: null, end: null });
  } catch (caught) {
    error = caught;
  }
  assert.match(error?.message || '', /identical image data|duplicate image/i);
  assert.equal(error?.stage, 'popup-image-duplicate');
});

test('targets the serialized blank popup card instead of an unstable status label', () => {
  const legacy = {
    time_start: '',
    time_end: '2026-11-30',
    image: 'https://cdn.example/legacy.webp',
    image_alt: '',
    link: '',
    html_code: ''
  };
  const blank = { time_start: '', time_end: '', image: '', image_alt: '', link: '', html_code: '' };
  assert.deepEqual(planPopupItemTarget([legacy, blank]), {
    targetIndex: 1,
    expectedCount: 2,
    addBlock: false
  });
  // `forceNewBlock` protects configured legacy content; it must not create a
  // second placeholder when CMS already has a blank one from an interrupted
  // run.  NewZen can insert its Add block result at the *front* of the list,
  // so relying on `current.length` would select the legacy popup instead.
  assert.deepEqual(planPopupItemTarget([legacy, blank], { forceNewBlock: true }), {
    targetIndex: 1,
    expectedCount: 2,
    addBlock: false
  });
  assert.deepEqual(planPopupItemTarget([]), {
    targetIndex: null,
    expectedCount: 1,
    addBlock: true
  });
});

test('resolves the actual blank card after NewZen prepends or appends Add block', () => {
  const legacy = {
    time_start: '',
    time_end: '2026-11-30',
    image: 'https://cdn.example/legacy.webp',
    image_alt: '',
    link: '',
    html_code: ''
  };
  const blank = { time_start: '', time_end: '', image: '', image_alt: '', link: '', html_code: '' };

  assert.deepEqual(resolveAddedPopupItemTarget([legacy], [blank, legacy]), {
    targetIndex: 0,
    expectedCount: 2,
    method: 'serialized-delta',
    reason: null
  });
  assert.deepEqual(resolveAddedPopupItemTarget([legacy], [legacy, blank]), {
    targetIndex: 1,
    expectedCount: 2,
    method: 'serialized-delta',
    reason: null
  });
});

test('verifies the ticket poster persisted in its exact popup card before Build', () => {
  const timezone = { iana: 'America/Los_Angeles' };
  const schedule = { start: null, end: { date: '2026-12-31' } };
  const legacy = {
    time_start: '', time_end: '2026-11-30', image: 'https://cdn.example/legacy.webp', image_alt: '', link: '', html_code: ''
  };
  const ticket = {
    time_start: '', time_end: '2026-12-31', image: 'https://cdn.example/ticket.webp', image_alt: '', link: '', html_code: ''
  };
  const persisted = verifyPersistedPopupItem({
    afterItems: [legacy, ticket], targetIndex: 1, expectedCount: 2, schedule, timezone
  });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.item.image, ticket.image);

  const wrongCard = verifyPersistedPopupItem({
    afterItems: [ticket, { time_start: '', time_end: '', image: '', image_alt: '', link: '', html_code: '' }],
    targetIndex: 1,
    expectedCount: 2,
    schedule,
    timezone
  });
  assert.equal(wrongCard.ok, false);
  assert.equal(wrongCard.reason, 'target-image-empty');

  const wrongSchedule = verifyPersistedPopupItem({
    afterItems: [legacy, { ...ticket, time_end: '2026-12-30' }],
    targetIndex: 1,
    expectedCount: 2,
    schedule,
    timezone
  });
  assert.equal(wrongSchedule.ok, false);
  assert.equal(wrongSchedule.reason, 'target-schedule-mismatch');
});

test('resolves persisted ticket posters after CMS reorders popup cards', () => {
  const timezone = { iana: 'America/Los_Angeles' };
  const schedule = { start: null, end: { date: '2026-11-30' } };
  const posterA = { time_start: '', time_end: '2026-11-30', image: 'https://cdn.example/poster-a.webp' };
  const posterB = { time_start: '', time_end: '2026-11-30', image: 'https://cdn.example/poster-b.webp' };
  const legacy = { time_start: '', time_end: '2026-12-31', image: 'https://cdn.example/legacy.webp' };
  const afterItems = [posterB, posterA, legacy];

  const resolvedA = resolvePopupItemByImageAndSchedule(afterItems, posterA.image, schedule, timezone);
  const resolvedB = resolvePopupItemByImageAndSchedule(afterItems, posterB.image, schedule, timezone);
  assert.equal(resolvedA.index, 1);
  assert.equal(resolvedA.item.image, posterA.image);
  assert.equal(resolvedB.index, 0);
  assert.equal(resolvedB.item.image, posterB.image);

  const duplicate = resolvePopupItemByImageAndSchedule([posterA, { ...posterA }], posterA.image, schedule, timezone);
  assert.equal(duplicate.item, null);
  assert.equal(duplicate.matches, 2);

  const wrongSchedule = resolvePopupItemByImageAndSchedule(afterItems, posterA.image, {
    start: null,
    end: { date: '2026-12-01' }
  }, timezone);
  assert.equal(wrongSchedule.item, null);
  assert.equal(wrongSchedule.matches, 0);
});

test('requires an explicitly requested popup date while leaving an absent start blank', () => {
  const timezone = { iana: 'America/Los_Angeles' };
  const correct = verifyPersistedPopupItem({
    afterItems: [{ time_start: '', time_end: '2027-01-02', image: 'https://cdn.example/ticket.webp' }],
    targetIndex: 0,
    expectedCount: 1,
    schedule: { start: null, end: { date: '2027-01-02' } },
    timezone
  });
  assert.equal(correct.ok, true);

  const inventedStart = verifyPersistedPopupItem({
    afterItems: [{ time_start: '2026-11-19', time_end: '2027-01-02', image: 'https://cdn.example/ticket.webp' }],
    targetIndex: 0,
    expectedCount: 1,
    schedule: { start: null, end: { date: '2027-01-02' } },
    timezone
  });
  assert.equal(inventedStart.ok, false);
  assert.equal(inventedStart.reason, 'target-schedule-mismatch');
});

test('recognizes a renamed CRM attachment by its SHA-256 fingerprint', () => {
  assert.equal(
    attachmentMatchEvidence(
      { filename: 'old-name.png', bytes: 12, sha256: 'a'.repeat(64) },
      { filename: 'renamed-poster.png', bytes: 99, sha256: 'a'.repeat(64) }
    ),
    'sha256'
  );
});

test('uses old filename and size evidence only when a historical hash is absent', () => {
  assert.equal(
    attachmentMatchEvidence(
      { filename: 'Poster (11).png', bytes: 2403396 },
      { filename: 'Poster (11).png', bytes: 2403396, sha256: 'b'.repeat(64) }
    ),
    'legacy-filename-and-size'
  );
  assert.equal(
    attachmentMatchEvidence(
      { filename: 'Poster (11).png', bytes: 2403396, sha256: 'a'.repeat(64) },
      { filename: 'Poster (11).png', bytes: 2403396, sha256: 'b'.repeat(64) }
    ),
    null
  );
});

test('prefers the custom-domain card when duplicate Website IDs include a preview', () => {
  const preview = { locatorIndex: 0, domains: projectDomainsFromText('2989\n2989-7381.newzensite.online\nTemplate fnail02c\nStatus Active') };
  const live = { locatorIndex: 1, domains: projectDomainsFromText('2989\nlvnailspacepecorl.com\nTemplate newzen-nail10\nStatus Active') };
  const selection = chooseProjectCandidate([preview, live]);
  assert.equal(selection.ambiguous, false);
  assert.equal(selection.method, 'custom-domain');
  assert.equal(selection.candidate.locatorIndex, 1);
});

test('stops when duplicate Website IDs have more than one custom domain', () => {
  const selection = chooseProjectCandidate([
    { locatorIndex: 0, domains: ['first-salon.com'] },
    { locatorIndex: 1, domains: ['second-salon.com'] }
  ]);
  assert.equal(selection.ambiguous, true);
  assert.equal(selection.candidate, null);
});

test('uses the only preview card when it is the sole matching Website ID', () => {
  const selection = chooseProjectCandidate([
    { locatorIndex: 0, domains: ['2989-7381.newzensite.online'] }
  ]);
  assert.equal(selection.ambiguous, false);
  assert.equal(selection.method, 'only-match');
});

test('always creates a fresh Announcement section after a plugin update', () => {
  assert.equal(mustCreateFreshAnnouncementSection({
    pluginStateBeforeApply: 'outdated',
    pluginUpdated: false,
    legacySectionIds: []
  }), true);
  assert.equal(mustCreateFreshAnnouncementSection({
    pluginStateBeforeApply: 'current',
    pluginUpdated: true,
    legacySectionIds: []
  }), true);
});

test('reads Announcement plugin version without relying on a fixed CMS table column', () => {
  assert.equal(announcementPluginVersionFromText('Announcement 1.0.38 Installed'), '1.0.38');
  assert.equal(announcementPluginVersionFromText('Version: 2.12.4'), '2.12.4');
  assert.equal(announcementPluginVersionFromText('Announcement plugin'), null);
});

test('creates a fresh section for a detected old Announcement block even when plugin status is current', () => {
  assert.equal(mustCreateFreshAnnouncementSection({
    pluginStateBeforeApply: 'current',
    pluginUpdated: false,
    legacySectionIds: ['item_block_section#123']
  }), true);
  assert.equal(mustCreateFreshAnnouncementSection({
    pluginStateBeforeApply: 'current',
    pluginUpdated: false,
    legacySectionIds: []
  }), false);
});

test('reads bare Website ID from ticket header without ID prefix', () => {
  const body = [
    '11194 - Website Support - [Popup]',
    'Download',
    'Reload',
    'Open',
    'High',
    'Nov 12, 2026 10:43 PMRoyal Luxe Nails & Spavia Vinh Nguyen',
    '',
    'Hi team,',
    '',
    'Nội dung hỗ trợ: Nhờ team popup EXP: 12/31/2026',
    '',
    'Link website: https://royalluxenailsspacg.com/',
    '',
    'Thanks team - Vinh Nguyen - AE 02'
  ].join('\n');
  assert.equal(hasWebsiteIdHeader(body), true);
  const ticket = parsed(body, 1591702);
  assert.equal(ticket.siteId, '11194');
  assert.equal(ticket.expiryDate, '2026-12-31');
  assert.equal(ticket.popupRequested, true);
});
