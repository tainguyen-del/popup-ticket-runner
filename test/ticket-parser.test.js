const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ticketData,
  ticketMarkerPattern,
  buildPopupEntries,
  buildPopupEntriesForTickets,
  isInlineTicketImageUrl,
  resolveRemovalScopeFromAttachments,
  popupScheduleFromTicket,
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
const { extractPopupLink, normalizeExpiry, popupActionNeedsTicketImage } = require('../src/ticket-parser');

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

test('does not mistake words starting with exp like Express or Experience for an expiry date', () => {
  const ticket = parsed([
    'ID#20566 - Website Support',
    '#1454082',
    'add service "Express Eyelash Extensions $65 " vào giúp tiệm',
    'Nhờ team hỗ trợ gỡ pop up hình chân Pumpkin xuống và Pop up hình chân Christmas $68 (ảnh bên dưới) giúp tiệm'
  ].join('\n'), 1454082);
  assert.equal(ticket.siteId, '20566');
  assert.equal(ticket.expiry, null);
  assert.equal(ticket.expiryDate, null);
  assert.equal(ticket.scheduleError, null);
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
  assert.equal(parsed('ID#3317 - Support\nRemove every expired popup but keep active popups.', 1591107).popupAction, 'remove-expired');
  assert.equal(parsed('ID#3317 - Support\nRemove all expired popups; keep current promos.', 1591107).popupAction, 'remove-expired');
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

test('places new ticket popup at the first entry when migrating to a new section', () => {
  const { entries } = buildPopupEntries(
    'C:/tmp/ticket.png',
    { start: null, end: null },
    [
      { imagePath: 'C:/tmp/legacy-1.webp', sourceImageUrl: 'https://cdn.example/legacy-1.webp', start: null, end: null },
      { imagePath: 'C:/tmp/legacy-2.webp', sourceImageUrl: 'https://cdn.example/legacy-2.webp', start: null, end: null }
    ]
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].isTicket, true);
  assert.equal(entries[1].isTicket, false);
  assert.equal(entries[2].isTicket, false);

  const { entries: entriesLast } = buildPopupEntries(
    'C:/tmp/ticket.png',
    { start: null, end: null },
    [
      { imagePath: 'C:/tmp/legacy-1.webp', sourceImageUrl: 'https://cdn.example/legacy-1.webp', start: null, end: null },
      { imagePath: 'C:/tmp/legacy-2.webp', sourceImageUrl: 'https://cdn.example/legacy-2.webp', start: null, end: null }
    ],
    { popupPosition: 'last' }
  );
  assert.equal(entriesLast.length, 3);
  assert.equal(entriesLast[0].isTicket, false);
  assert.equal(entriesLast[1].isTicket, false);
  assert.equal(entriesLast[2].isTicket, true);
});

test('preserves the start date of an unmatched active legacy popup when migrating to a new section', () => {
  const { entries, matchingLegacyIndex } = buildPopupEntries(
    'C:/tmp/Oasis Loyalty Celebration.png',
    { start: null, end: { date: '2027-02-01' } },
    [{
      imagePath: 'C:/tmp/legacy-popup-1.webp',
      sourceImageUrl: 'https://cdn.example/Thanksgiving-Poster.webp',
      start: { date: '2026-11-22' },
      end: { date: '2026-11-26' }
    }]
  );
  assert.equal(matchingLegacyIndex, -1);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].isTicket, true);
  assert.equal(entries[0].schedule.start, null);
  assert.equal(entries[0].schedule.end?.date, '2027-02-01');
  assert.equal(entries[1].isTicket, false);
  assert.equal(entries[1].schedule.start?.date, '2026-11-22');
  assert.equal(entries[1].schedule.end?.date, '2026-11-26');
});

test('replaces matching legacy block in-place when duplicateMatches is provided', () => {
  const tickets = [{
    ticketIndex: 0,
    uploadPath: 'C:/tmp/Celine Holiday Gift Special.png',
    schedule: { start: null, end: null }
  }];
  const legacy = [
    { imagePath: 'C:/tmp/legacy-1.webp', sourceImageUrl: 'https://cdn.example/50-off.webp', end: { date: '2026-12-31' } },
    { imagePath: 'C:/tmp/legacy-2.webp', sourceImageUrl: 'https://cdn.example/holiday-gift.webp', end: { date: '2026-12-31' } }
  ];
  const duplicateMatches = [{
    ticketIndex: 0,
    cmsIndex: 1,
    method: 'visual-similarity',
    similarity: 0.97
  }];
  const { entries, matchingLegacyIndex } = buildPopupEntriesForTickets(tickets, legacy, duplicateMatches);
  assert.equal(matchingLegacyIndex, 1);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].imagePath, 'C:/tmp/legacy-1.webp');
  assert.equal(entries[0].isTicket, false);
  assert.equal(entries[1].imagePath, 'C:/tmp/Celine Holiday Gift Special.png');
  assert.equal(entries[1].isTicket, true);
  assert.equal(entries[1].schedule.end.date, '2026-12-31');
});

test('replaces Thanksgiving popup among 3 legacy popups and preserves other 2 popups', () => {
  const tickets = [{
    ticketIndex: 0,
    uploadPath: 'C:/tmp/thanksgiving-updated.png',
    filename: 'thanksgiving-updated.png',
    schedule: { start: null, end: null }
  }];
  const legacy = [
    { imagePath: 'C:/tmp/thanksgiving-old.webp', sourceImageUrl: 'https://cdn.example/thanksgiving-old.webp', end: null },
    { imagePath: 'C:/tmp/christmas.webp', sourceImageUrl: 'https://cdn.example/christmas.webp', end: { date: '2026-12-25' } },
    { imagePath: 'C:/tmp/feet-care.webp', sourceImageUrl: 'https://cdn.example/feet-care.webp', end: null }
  ];
  const duplicateMatches = [{
    ticketIndex: 0,
    cmsIndex: 0,
    method: 'visual-similarity',
    similarity: 0.88
  }];
  const { entries, matchingLegacyIndex } = buildPopupEntriesForTickets(tickets, legacy, duplicateMatches, { replaceExisting: true });
  assert.equal(matchingLegacyIndex, 0);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].imagePath, 'C:/tmp/thanksgiving-updated.png');
  assert.equal(entries[0].isTicket, true);
  assert.equal(entries[1].imagePath, 'C:/tmp/christmas.webp');
  assert.equal(entries[1].isTicket, false);
  assert.equal(entries[2].imagePath, 'C:/tmp/feet-care.webp');
  assert.equal(entries[2].isTicket, false);
});

test('replaces single legacy popup directly when replaceExisting is true and duplicateMatches is empty', () => {
  const tickets = [{
    ticketIndex: 0,
    uploadPath: 'C:/tmp/new-special-offer.png',
    filename: 'new-special-offer.png',
    schedule: { start: { date: '2026-11-14' }, end: { date: '2026-12-11' } }
  }];
  const legacy = [{
    imagePath: 'C:/tmp/old-grand-opening.webp',
    sourceImageUrl: 'https://cdn.example/old-grand-opening.webp',
    start: null,
    end: { date: '2026-12-11' }
  }];
  const { entries, matchingLegacyIndex } = buildPopupEntriesForTickets(tickets, legacy, [], { replaceExisting: true });
  assert.equal(matchingLegacyIndex, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].imagePath, 'C:/tmp/new-special-offer.png');
  assert.equal(entries[0].isTicket, true);
  assert.equal(entries[0].schedule.start.date, '2026-11-14');
  assert.equal(entries[0].schedule.end.date, '2026-12-11');
});

test('recognizes "Đến khi khách tắt" as an indefinite schedule without start/end dates', () => {
  const ticket = parsed('ID#18781 - Creating pop-ups\nNhờ team hỗ trợ tạo pop-ups cho website. Đến  khi khách tắt\nThank team.', 18781);
  assert.equal(ticket.isIndefinite, true);
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiryDate, null);
  assert.equal(ticket.start, null);
  assert.equal(ticket.expiry, null);
  assert.equal(ticket.scheduleSource, 'ticket-indefinite');
});

test('does not use artwork Vision dates when ticket instruction is indefinite (đến khi khách tắt)', () => {
  const ticket = parsed('ID#18781 - Creating pop-ups\nNhờ team hỗ trợ tạo pop-ups cho website. Đến khi khách tắt\nThank team.', 18781);
  const schedule = popupScheduleFromTicket(ticket);
  assert.equal(schedule.isIndefinite, true);
  assert.equal(schedule.start, null);
  assert.equal(schedule.end, null);

  const posterSchedules = [{
    attachmentIndex: 1,
    startDate: '2026-11-23',
    endDate: '2026-11-27',
    evidence: 'NOVEMBER 23-27, 2026 ONLY'
  }];

  const entries = popupTicketEntriesFromDownloads([
    { candidateIndex: 1, filename: 'promo.png', sha256: 'abc', uploadPath: 'C:/tmp/promo.png' }
  ], schedule, posterSchedules);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].schedule.start, null);
  assert.equal(entries[0].schedule.end, null);
});

test('does not mistake "from <store name>" in holiday greetings as a popup start date (ticket 1597915)', () => {
  const text = [
    'ID#2928 - SM SP [Design poster] THANKSGIVING NOTICE',
    'Nhờ team popup poster.',
    'EXP: 11/26/2026',
    'HAPPY THANKSGIVING FROM RADIANCE NAILS & SPA! ❤️',
    'Dear Valued Clients,',
    'Please be advised that our salon will be CLOSED on Thursday, November 26, 2026.'
  ].join('\n');
  const ticket = parsed(text, 2928);
  assert.equal(ticket.start, null);
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiry, '11/26/2026');
  assert.equal(ticket.expiryDate, '2026-11-26');
});

test('normalizes named month dates without year to the current calendar year', () => {
  const currentYear = new Date().getUTCFullYear();
  assert.equal(normalizeExpiry('November 26'), `${currentYear}-11-26`);
  assert.equal(normalizeExpiry('26 Nov'), `${currentYear}-11-26`);
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

  // CMS auto-fills time_start with today's date when Add block is clicked
  const blankWithCmsDefaultDate = { time_start: '2026-11-16 00:00', time_end: '', image: '', image_alt: '', link: '', html_code: '', open_new_tab: false };
  assert.deepEqual(resolveAddedPopupItemTarget([legacy], [legacy, blankWithCmsDefaultDate]), {
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

test('distinguishes singular popup requests from explicit multi-poster intent', () => {
  const { hasMultiPosterIntent } = require('../src/ticket-parser');

  // Singular or generic requests (should NOT be multi-poster)
  assert.equal(hasMultiPosterIntent('Hi team / Nhờ team pop up poster / Thanks team'), false);
  assert.equal(hasMultiPosterIntent('Nhờ team update website'), false);
  assert.equal(hasMultiPosterIntent('Nhờ team pop poster đính kèm nha'), false);
  assert.equal(hasMultiPosterIntent('Please upload this popup until 11.30.26'), false);
  assert.equal(hasMultiPosterIntent('ID# 11194 - Website Support - [Popup]\nHi team, nhờ team popup EXP: 12/31/2026\nAttachments (2)'), false);
  assert.equal(hasMultiPosterIntent('Team hỗ trợ gỡ popup cũ và pop poster mới đính kèm'), false);

  // Explicit multi-poster / plural requests
  assert.equal(hasMultiPosterIntent('Nhờ team pop up 2 poster đính kèm'), true);
  assert.equal(hasMultiPosterIntent('Team hỗ trợ popup cả 2 ảnh giúp mình'), true);
  assert.equal(hasMultiPosterIntent('Nhờ team pop 2 ảnh này lên web'), true);
  assert.equal(hasMultiPosterIntent('Pop up cả hai hình'), true);
  assert.equal(hasMultiPosterIntent('Please popup 2 posters'), true);
  assert.equal(hasMultiPosterIntent('Popup poster 1 và poster 2'), true);
  assert.equal(hasMultiPosterIntent('Please pop up both posters'), true);
  assert.equal(hasMultiPosterIntent('Nhờ team pop up cả 2 giúp mình'), true);
  assert.equal(hasMultiPosterIntent('Nhờ team treo 2 poster'), true);
  assert.equal(hasMultiPosterIntent('Treo cả 2 poster lên web'), true);
  assert.equal(hasMultiPosterIntent('Please add 2 separate popups'), true);
});

test('identifies replacement actions from direct replacement phrasing (update lai, thay, doi)', () => {
  const { hasAffirmativePopupReplace } = require('../src/ticket-parser');

  // Ticket 1594214 case: "Team update lại poster giúp tiệm nha."
  assert.equal(hasAffirmativePopupReplace('Team update lại poster giúp tiệm nha.'), true);
  assert.equal(parsed('ID#70 - Website Support\nTeam update lại poster giúp tiệm nha.', 1594214).popupAction, 'replace');

  // Other common replacement phrasings:
  assert.equal(hasAffirmativePopupReplace('Nhờ team cập nhật lại poster'), true);
  assert.equal(hasAffirmativePopupReplace('Nhờ team đổi poster này thành poster đính kèm'), true);
  assert.equal(hasAffirmativePopupReplace('Team thay poster giúp tiệm'), true);
  assert.equal(hasAffirmativePopupReplace('Nhờ team thay thế poster cũ'), true);
  assert.equal(hasAffirmativePopupReplace('Please replace the popup poster with the attached one'), true);
  assert.equal(hasAffirmativePopupReplace('Gỡ popup cũ và add popup mới'), true);

  // Pure create / add (should NOT be replace)
  assert.equal(hasAffirmativePopupReplace('Hi team / Nhờ team pop up poster / Thanks team'), false);
  assert.equal(hasAffirmativePopupReplace('Nhờ team đăng poster đính kèm'), false);
  assert.equal(hasAffirmativePopupReplace('Nhờ team update website'), false);
});

// ─── Mixed-action case (ticket 1595897) ─────────────────────────────────────

test('mixed add+remove ticket sets popupAction to create, not remove-one', () => {
  const ticket = parsed([
    'ID#5342 - Website Support',
    '#1595897',
    'popup 2 promo sau len web + tam remove poster sau'
  ].join('\n'), 1595897);
  assert.equal(ticket.popupAction, 'create', 'should be create, not remove-one');
  assert.equal(ticket.hasInlineRemovalRequest, true);
});

test('pure remove without add still sets popupAction to remove-one', () => {
  const ticket = parsed([
    'ID#5342 - Website Support',
    '#1591001',
    'Please remove the attached poster from the website.'
  ].join('\n'), 1591001);
  assert.equal(ticket.popupAction, 'remove-one');
  assert.equal(ticket.hasInlineRemovalRequest, false);
});

test('pure remove-all without add still sets popupAction to remove-all', () => {
  const ticket = parsed([
    'ID#5342 - Website Support',
    '#1591002',
    'Please remove every existing popup from the website.'
  ].join('\n'), 1591002);
  assert.equal(ticket.popupAction, 'remove-all');
  assert.equal(ticket.hasInlineRemovalRequest, false);
});

test('recognizes Vietnamese removal phrasing "xóa giúp poster pop up thông báo nghỉ" (ticket 1605715)', () => {
  const ticket = parsed([
    'ID#4006 - Website Support',
    '#1605715',
    'Hi team,',
    'Nhờ team xóa giúp poster pop up thông báo nghỉ trên website',
    'Tiệm đổi thời gian nghỉ lễ',
    'Thanks team'
  ].join('\n'), 1605715);
  assert.equal(ticket.popupAction, 'remove-one');
  assert.equal(ticket.popupRequested, true);
});

test('popupActionNeedsTicketImage returns false for remove-one when attachmentCount is 0', () => {
  assert.equal(popupActionNeedsTicketImage('remove-one', 0), false);
  assert.equal(popupActionNeedsTicketImage('remove-one', 1), true);
  assert.equal(popupActionNeedsTicketImage('create', 0), true);
  assert.equal(popupActionNeedsTicketImage('remove-all', 0), false);
});

// ─── Popup link extraction ───────────────────────────────────────────────────

test('extractPopupLink returns URL after a "link" keyword', () => {
  const url = extractPopupLink('Nhowf team pop up poster va direct toi link booking http://booking.gocheckin.net/v2/16675');
  assert.equal(url, 'http://booking.gocheckin.net/v2/16675');
});

test('extractPopupLink returns a bare https URL in the ticket', () => {
  const url = extractPopupLink('Pop up poster này và link https://example.com/page');
  assert.equal(url, 'https://example.com/page');
});

test('extractPopupLink strips trailing punctuation from URL', () => {
  const url = extractPopupLink('direct to link: http://booking.example.com/path.');
  assert.equal(url, 'http://booking.example.com/path');
});

test('extractPopupLink returns null when ticket has no URL', () => {
  const url = extractPopupLink('Nhờ team pop up poster đính kèm đến 12/31/2026');
  assert.equal(url, null);
});

test('extractPopupLink returns null for salon Link website URL without explicit popup linking instruction', () => {
  const text = [
    'ID#18781 - Creating pop-ups',
    'Link website: https://nailsalonprestige.com',
    'Nhờ team hỗ trợ tạo pop-ups cho website đến ngày 28/11/2026.',
    'Thank team.'
  ].join('\n');
  assert.equal(extractPopupLink(text), null);
});

test('extractPopupLink returns null for generic Website and Domain URLs', () => {
  const text = [
    'ID#12345 - Support',
    'Website: https://example.com',
    'Domain: https://example.com',
    'Nhờ team đăng popup giùm mình.'
  ].join('\n');
  assert.equal(extractPopupLink(text), null);
});

test('ticketData includes popupLink from ticket text', () => {
  const ticket = parsed([
    'ID#9876 - Website Support',
    '#1575574',
    'Nhowf team pop up poster va direct toi link booking http://booking.gocheckin.net/v2/16675'
  ].join('\n'), 1575574);
  assert.equal(ticket.popupLink, 'http://booking.gocheckin.net/v2/16675');
});

test('ticketData popupLink is null when no URL in ticket', () => {
  const ticket = parsed([
    'ID#9876 - Website Support',
    '#1575575',
    'Nho team pop up poster dinh kem'
  ].join('\n'), 1575575);
  assert.equal(ticket.popupLink, null);
});

test('ticketData extracts expiry date for holiday closure notice "thông báo nghỉ ngày thanksgiving 26" (ticket 1601781)', () => {
  const currentYear = new Date().getUTCFullYear();
  const ticket = parsed([
    'ID#20566 - Update website',
    '#1601781',
    'Nhờ team hỗ trợ thông báo nghỉ ngày thanksgiving 26.'
  ].join('\n'), 1601781);
  assert.equal(ticket.expiryDate, `${currentYear}-11-26`);
  assert.equal(ticket.startDate, null);
  const schedule = popupScheduleFromTicket(ticket);
  assert.equal(schedule.end?.date, `${currentYear}-11-26`);
  assert.equal(schedule.start, null);
});

test('ticketData extracts expiry date for "tiệm nghỉ lễ thanksgiving 26"', () => {
  const currentYear = new Date().getUTCFullYear();
  const ticket = parsed([
    'ID#18781 - Support',
    'Nhờ team pop up hình ảnh tiệm nghỉ lễ thanksgiving 26.'
  ].join('\n'), 1601782);
  assert.equal(ticket.expiryDate, `${currentYear}-11-26`);
  const schedule = popupScheduleFromTicket(ticket);
  assert.equal(schedule.end?.date, `${currentYear}-11-26`);
});

test('ticketData extracts expiry date for "thông báo tiệm nghỉ ngày 26/11"', () => {
  const currentYear = new Date().getUTCFullYear();
  const ticket = parsed([
    'ID#18781 - Support',
    'Thông báo tiệm nghỉ ngày 26/11, cảm ơn team.'
  ].join('\n'), 1601783);
  assert.equal(ticket.expiryDate, `${currentYear}-11-26`);
  const schedule = popupScheduleFromTicket(ticket);
  assert.equal(schedule.end?.date, `${currentYear}-11-26`);
});

test('ticketData does not set startDate for holiday closure "tiệm nghỉ từ 24/11 đến 26/11" but extracts expiry', () => {
  const currentYear = new Date().getUTCFullYear();
  const ticket = parsed([
    'ID#18781 - Support',
    'Nhờ team pop up poster tiệm nghỉ từ 24/11 đến 26/11.'
  ].join('\n'), 1601784);
  assert.equal(ticket.startDate, null);
  assert.equal(ticket.expiryDate, `${currentYear}-11-26`);
  const schedule = popupScheduleFromTicket(ticket);
  assert.equal(schedule.start, null);
  assert.equal(schedule.end?.date, `${currentYear}-11-26`);
});

test('does not set startDate when note mentions holiday closure or promotion without explicit popup launch date', () => {
  const currentYear = new Date().getUTCFullYear();
  const t1 = parsed('ID#100 - Support\nNhờ team up poster thông báo tiệm nghỉ từ 24/11 đến 26/11.', 100);
  assert.equal(t1.startDate, null);
  assert.equal(t1.expiryDate, `${currentYear}-11-26`);

  const t2 = parsed('ID#100 - Support\nNhờ team lên popup khuyến mãi từ 20/11 đến 30/11.', 101);
  assert.equal(t2.startDate, null);
  assert.equal(t2.expiryDate, `${currentYear}-11-30`);
});

test('sets startDate only when note explicitly requests popup start date', () => {
  const currentYear = new Date().getUTCFullYear();
  const t1 = parsed('ID#100 - Support\nNhờ team hẹn ngày 12/01/2026 mới lên popup, hạn tới 12/25/2026.', 102);
  assert.equal(t1.startDate, `${currentYear}-12-01`);
  assert.equal(t1.expiryDate, `${currentYear}-12-25`);

  const t2 = parsed('ID#100 - Support\nPopup start date: 12/01/2026\nEnd date: 12/25/2026', 103);
  assert.equal(t2.startDate, '2026-12-01');
  assert.equal(t2.expiryDate, '2026-12-25');

  const t3 = parsed('ID#100 - Support\nĐăng popup từ ngày 12/01/2026 đến ngày 12/25/2026', 104);
  assert.equal(t3.startDate, '2026-12-01');
  assert.equal(t3.expiryDate, '2026-12-25');
});

test('extractPopupDuration parses requested seconds and adds 3s open delay', () => {
  const { extractPopupDuration, POPUP_OPEN_DELAY_SECONDS } = require('../src/ticket-parser');
  assert.equal(POPUP_OPEN_DELAY_SECONDS, 3);

  const dur1 = extractPopupDuration('Nhờ team chỉnh popup xuất hiện lâu hơn tầm 10s giúp em.');
  assert.deepEqual(dur1, { requestedSeconds: 10, delaySliderSeconds: 13, isExplicitSlider: false });

  const dur2 = extractPopupDuration('Ticket yêu cầu popup hiển thị 10s');
  assert.deepEqual(dur2, { requestedSeconds: 10, delaySliderSeconds: 13, isExplicitSlider: false });

  const dur3 = extractPopupDuration('Chỉnh delay slider trong popup settings lên 13s');
  assert.deepEqual(dur3, { requestedSeconds: 10, delaySliderSeconds: 13, isExplicitSlider: true });

  const dur4 = extractPopupDuration('Nhờ team pop up poster đính kèm, hạn tới 11/26.');
  assert.equal(dur4, null);

  const dur5 = extractPopupDuration('Nhờ team hỗ trợ pop up poster bên dưới lên website khoảng 10s');
  assert.deepEqual(dur5, { requestedSeconds: 10, delaySliderSeconds: 13, isExplicitSlider: false });

  const unrelatedDuration = extractPopupDuration('Thời gian tải trang là 10s, popup giữ nguyên.');
  assert.equal(unrelatedDuration, null);
});

test('ticketData extracts popupDuration for ticket 11195 phrasing', () => {
  const ticket = parsed([
    'ID#11195 - Website support - Pop up poster',
    'Hi team',
    'Nhờ team hỗ trợ pop up poster bên dưới lên website khoảng 10s',
    'Exp: 11/26/2026',
    'Thank team'
  ].join('\n'), 11195);

  assert.equal(ticket.siteId, '11195');
  assert.equal(ticket.popupAction, 'create');
  assert.ok(ticket.popupDuration);
  assert.equal(ticket.popupDuration.requestedSeconds, 10);
  assert.equal(ticket.popupDuration.delaySliderSeconds, 13);
  assert.equal(ticket.expiryDate, '2026-11-26');
});

test('ticketData detects popupAction "update-duration" for duration-only ticket without poster upload (ticket 1602842)', () => {
  const ticket = parsed([
    'ID#3349 - Chỉnh thời gian popup',
    'Nhờ team chỉnh popup xuất hiện lâu hơn tầm 10s giúp em.',
    'Thank team.'
  ].join('\n'), 1602842);

  assert.equal(ticket.popupAction, 'update-duration');
  assert.ok(ticket.popupDuration);
  assert.equal(ticket.popupDuration.requestedSeconds, 10);
  assert.equal(ticket.popupDuration.delaySliderSeconds, 13);
});

test('ticketData preserves popupDuration while keeping popupAction "create" when poster is also uploaded', () => {
  const ticket = parsed([
    'ID#3349 - Up poster mới',
    'Nhờ team up poster đính kèm và chỉnh popup hiển thị 10s giúp em.',
    'Hạn tới cuối tháng.',
    'Thank team.'
  ].join('\n'), 1602843);

  assert.equal(ticket.popupAction, 'create');
  assert.ok(ticket.popupDuration);
  assert.equal(ticket.popupDuration.requestedSeconds, 10);
  assert.equal(ticket.popupDuration.delaySliderSeconds, 13);
});

test('ticketData extracts expiry 2026-11-27 from "ẩn sau 11/27/2026" without picking CRM header date (ticket 1603527)', () => {
  const body = [
    'ID#9412 - SUPPORT - WEBSITE -THANKSGIVING CLOSED',
    'Download',
    'Reload',
    'Open',
    'Normal',
    'Nov 21, 2026 5:00 AMCelestial Beauty Loungevia Mai Anh (Laila)(assign)- Last update assignee by Tai Nguyen (TE)',
    '',
    'Hi team,',
    '',
    'Nhờ team pop-up poster và ẩn sau 11/27/2026 dùm',
    '',
    'Thanks team'
  ].join('\n');
  const ticket = parsed(body, 1603527);
  assert.equal(ticket.expiryDate, '2026-11-27');
  assert.equal(ticket.siteId, '9412');
  assert.equal(ticket.popupAction, 'create');
});

test('ticketData extracts expiry dates with Vietnamese removal/hiding phrasing variants', () => {
  const currentYear = new Date().getUTCFullYear();
  const t1 = parsed('ID#100 - Support\nNhờ team up poster tắt sau 11/27/2026 giúp', 100);
  assert.equal(t1.expiryDate, `${currentYear}-11-27`);

  const t2 = parsed('ID#100 - Support\nNhờ team gỡ sau ngày 28/11/2026', 101);
  assert.equal(t2.expiryDate, `${currentYear}-11-28`);

  const t3 = parsed('ID#100 - Support\nNhờ team ẩn vào ngày 11/30/2026', 102);
  assert.equal(t3.expiryDate, `${currentYear}-11-30`);

  const t4 = parsed('ID#100 - Support\nPlease pop up poster and hide after 11/27/2026', 103);
  assert.equal(t4.expiryDate, `${currentYear}-11-27`);
});

test('extractPopupDuration avoids street addresses, decades, and bare slider indexes while handling create + duration phrasing', () => {
  const { extractPopupDuration } = require('../src/ticket-parser');
  assert.equal(extractPopupDuration('ID#2001\nNhờ team pop up giúp tiệm ở 15 S Main St, cảm ơn.'), null);
  assert.equal(extractPopupDuration('ID#2002\nNhờ team đăng banner trên slider 1 của trang chủ.'), null);
  assert.equal(extractPopupDuration('ID#2003\nPop up poster 90s retro night'), null);

  const addressCreate = parsed('ID#2001\nNhờ team pop up giúp tiệm ở 15 S Main St', 1608801);
  assert.equal(addressCreate.popupDuration, null);
  assert.equal(addressCreate.popupAction, 'create');

  const newPopupWithDuration = parsed('ID#2004\nNhờ team up popup mới lên web hiển thị 10s giúp em.', 1608802);
  assert.equal(newPopupWithDuration.popupAction, 'create');
  assert.equal(newPopupWithDuration.popupDuration.requestedSeconds, 10);
  assert.equal(newPopupWithDuration.popupDuration.delaySliderSeconds, 13);
});

test('supports 2 coupon pop up without misreading keep-existing counts and parses keep/order/size directives (tickets 1609697 & 1607802)', () => {
  const {
    hasMultiPosterIntent,
    hasAffirmativePopupReplace,
    keepsExistingPopups,
    extractPopupOrderSequence,
    requestedAspectRatio,
    hasSizeOrReuploadInstruction
  } = require('../src/ticket-parser');

  // Ticket 1609697: "2 coupon pop up đính kèm" MUST count as multi-poster
  const t1609697 = 'ID#17333 - Update website\nNhờ team update 2 coupon pop up đính kèm, vẫn giữu nguyên coupon đang pop up\nThứ tự: Giftcard - Weekly Appreciation - Weekly Special';
  assert.equal(hasMultiPosterIntent(t1609697), true);
  assert.equal(keepsExistingPopups(t1609697), true);
  assert.deepEqual(extractPopupOrderSequence(t1609697), ['Giftcard', 'Weekly Appreciation', 'Weekly Special']);

  // Ticket 1607802: "vẫn giữ 2 coupon pop hiện có" keeps 2 OLD popups; only 1 NEW poster is requested
  const t1607802 = 'ID#18757 - Update coupon pop up\nNhờ team update coupon pop up, đính kèm tuy nhiên vẫn giữ 2 coupon pop hiện có\nTheo thứ tự coupon: Giftcard - Weekly Appreciation - Weekly Special\nNhờ team up lại ảnh này, vì đúng size 1x1';
  assert.equal(hasMultiPosterIntent(t1607802), false);
  assert.equal(keepsExistingPopups(t1607802), true);
  assert.equal(hasAffirmativePopupReplace(t1607802), true);
  assert.equal(hasSizeOrReuploadInstruction(t1607802), true);
  assert.deepEqual(requestedAspectRatio(t1607802), { label: '1:1', ratio: 1 });
  assert.deepEqual(extractPopupOrderSequence(t1607802), ['Giftcard', 'Weekly Appreciation', 'Weekly Special']);

  assert.equal(keepsExistingPopups('Không giữ popup cũ nữa'), false);
});

test('scopes multi-round CRM conversations to uncompleted active request and ignores Facebook removals and update-content phrases (tickets 1609899 & 9343)', () => {
  const {
    hasAffirmativePopupRemoval,
    hasAffirmativePopupReplace,
    hasAffirmativeExpiredRemoval,
    explicitRemoveAllRequested
  } = require('../src/ticket-parser');

  // Ticket 1609899: Old completed round removed "20% gift card" + old FB post removal; new active comment creates a popup.
  const t1609899 = [
    'ID#4832 - Take care - Hỗ trợ vấn đề website',
    'Khách cần hỗ trợ gỡ poster đăng trên facebook ở ticket https://crm.fastboy.dev/tickets/detail/1609332',
    'Sau đó sẽ điều chỉnh lại nội dung theo nội dung sms',
    'Conversations',
    'Reload',
    'Hau Do - AE 02',
    '(assign)',
    'hau_do@fastboy.net',
    'Nov 27, 2026 11:17 PM',
    'Hi team,',
    'Nhờ team hỗ trợ popup poster lên website giúp khách nha',
    'EXP: 11/27/2026',
    'Thank team',
    'Tai Nguyen (TE)',
    'tai_nguyen@fastboy.net',
    'Nov 27, 2026 11:15 PM',
    'Hi team,',
    'Đã update theo yêu cầu',
    'Thanks',
    'Hau Do - AE 02',
    '(assign)',
    'hau_do@fastboy.net',
    'Nov 27, 2026 10:55 PM',
    'Nhờ team hỗ trợ remove poster 20% gift card nha',
    'SM Leader - Huỳnh Hào',
    '(assign)',
    'hao_huynh@fastboy.net',
    'Nov 26, 2026 7:06 AM',
    'Xoá bài trên FB -Done',
    'Fastboy CRM @ 2026 Created by Fastboy'
  ].join('\n');

  const parsed1609899 = parsed(t1609899, 1609899);
  assert.equal(parsed1609899.siteId, '4832');
  assert.equal(parsed1609899.popupAction, 'create');
  assert.equal(parsed1609899.hasInlineRemovalRequest, false);
  assert.equal(parsed1609899.expiryDate, '2026-11-27');

  // Non-website social removal alone must never be treated as removing a CMS website popup.
  assert.equal(hasAffirmativePopupRemoval('Khách cần hỗ trợ gỡ poster đăng trên facebook'), false);
  assert.equal(hasAffirmativePopupRemoval('Xoá bài trên FB -Done'), false);

  // "update lại content" in a ticket mentioning popup must never trigger popup replacement (ID#9343).
  assert.equal(hasAffirmativePopupReplace('Nhờ team popup poster.\nAE update lại content'), false);
  const parsed9343 = parsed('ID#9343 - Design poster\nNhờ team popup poster.\nEXP: 01/01/2027\nAE update lại content', 9343);
  assert.equal(parsed9343.popupAction, 'create');

  // Expired popup removal requests map strictly to 'remove-expired' (never 'remove-all' or 'remove-one').
  assert.equal(hasAffirmativeExpiredRemoval('Nhờ team xóa các popup đã hết hạn giúp khách'), true);
  assert.equal(hasAffirmativeExpiredRemoval('Xóa toàn bộ popup đã hết hạn trên CMS'), true);
  assert.equal(explicitRemoveAllRequested('Xóa toàn bộ popup đã hết hạn trên CMS'), false);
  assert.equal(hasAffirmativePopupRemoval('Xóa các popup đã hết hạn giúp tiệm'), false);
  assert.equal(hasAffirmativeExpiredRemoval('Không xóa popup hết hạn'), false);

  const expiredTicket = parsed('ID#4832 - Update website\nNhờ team xóa các popup đã hết hạn giúp website', 1609900);
  assert.equal(expiredTicket.popupAction, 'remove-expired');
  assert.equal(popupActionNeedsTicketImage(expiredTicket.popupAction, 0), false);

  // Ticket 1610769: "Auto turn off poster: 1/01/2027" is an expiry date for a new popup, NOT a removal/replace command.
  const t1610769 = [
    'ID#12333 - Website Support',
    'Hi team',
    'Nhờ team popup Poster giúp khách nhé.',
    'Auto turn off poster: 1/01/2027',
    'Thanks team'
  ].join('\n');
  assert.equal(hasAffirmativePopupRemoval(t1610769), false);
  assert.equal(hasAffirmativePopupReplace(t1610769), false);
  const parsed1610769 = parsed(t1610769, 1610769);
  assert.equal(parsed1610769.siteId, '12333');
  assert.equal(parsed1610769.popupAction, 'create');
  assert.equal(parsed1610769.hasInlineRemovalRequest, false);
  assert.equal(parsed1610769.expiryDate, '2027-01-01');

  // Ticket 1611044: "exp: không có" + CRM composer UI chrome must never leak into expiry or block run.
  const t1611044 = [
    'ID#17639 - Support Website',
    'Nov 28, 2026 4:16 AM Nails & Beauty Spa',
    'Hi team nhờ team pop-up giúp khách',
    'exp: không có',
    'Thanks team',
    'Show task',
    'Show Jira issues',
    'Add conversations',
    'Internal note',
    'Upload',
    'Send note',
    'Conversations',
    'Reload',
    'No data'
  ].join('\n');
  const parsed1611044 = parsed(t1611044, 1611044);
  assert.equal(parsed1611044.siteId, '17639');
  assert.equal(parsed1611044.popupAction, 'create');
  assert.equal(parsed1611044.isIndefinite, true);
  assert.equal(parsed1611044.expiry, null);
  assert.equal(parsed1611044.expiryDate, null);

  // Unparseable non-date text after exp: stays line-scoped and does not set false blocking expiry strings
  const nonDateExp = parsed('ID#17639 - Support\nNhờ team popup poster.\nexp: hỏi lại khách sau\nThanks team', 1611045);
  assert.equal(nonDateExp.expiry, null);
  assert.equal(nonDateExp.expiryDate, null);
});
