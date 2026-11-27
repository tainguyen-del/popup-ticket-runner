const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeSemanticTicket,
  resolveTicketSemantics,
  semanticPrompt,
  ticketTextForSemanticPrompt,
  resolveTicketVision,
  resolveTicketPopupVisionSet,
  resolveTicketPopupRemovalVision,
  removalVisionDecisionFromResponse,
  posterSchedulesFromResponse,
  requestGeminiTicketJson,
  SEMANTIC_SCHEMA,
  geminiResponseSchema,
  multiVisionPrompt,
  visionPrompt,
  isValidPosterScheduleEvidence,
  resolveVisualDuplicateConfirmation,
  resolvePopupOrderVision
} = require('../src/semantic-ticket');
const { applyArtworkSchedulePrecedence } = require('../src/run');

const baseTicket = {
  siteId: '16266',
  start: null,
  startDate: null,
  expiry: null,
  expiryDate: null,
  scheduleSource: null,
  scheduleEvidence: null,
  popupRequested: true,
  popupAction: 'create'
};

test('Gemini enrichment safely fills a missing dotted-date expiry with exact evidence', () => {
  const ticketText = 'ID#16266 - Website Support\nPlease upload this popup until 11.30.26';
  const { ticket, audit } = mergeSemanticTicket(baseTicket, {
    siteId: '16266',
    popupRequested: true,
    operation: 'create',
    startDate: null,
    endDate: '2026-11-30',
    confidence: 0.94,
    evidence: {
      siteId: 'ID#16266 - Website Support',
      operation: 'upload this popup',
      startDate: null,
      endDate: 'until 11.30.26'
    },
    warnings: []
  }, ticketText);

  assert.equal(ticket.expiryDate, '2026-11-30');
  assert.equal(ticket.expiry, '2026-11-30');
  assert.equal(audit.status, 'enriched');
  assert.deepEqual(audit.appliedFields, ['expiryDate']);
});

test('Gemini cannot overwrite a deterministic expiry with conflicting output', () => {
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, expiry: '2026-12-31', expiryDate: '2026-12-31' }, {
    siteId: '16266',
    popupRequested: true,
    operation: 'create',
    startDate: null,
    endDate: '2026-11-30',
    confidence: 0.98,
    evidence: { siteId: null, operation: null, startDate: null, endDate: 'until 11.30.26' },
    warnings: []
  }, 'ID#16266 - Website Support\nuntil 11.30.26');

  assert.equal(ticket.expiryDate, '2026-12-31');
  assert.match(audit.warnings.join(' '), /conflicts/i);
});

test('Gemini can safely promote an explicit Vietnamese popup removal', () => {
  const ticketText = 'ID#3317 - Update website\nNhờ team tắt popup này giúp tiệm.';
  const { ticket, audit } = mergeSemanticTicket(baseTicket, {
    siteId: '3317',
    popupRequested: true,
    operation: 'remove',
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    confidence: 0.93,
    evidence: {
      siteId: 'ID#3317 - Update website',
      operation: 'tắt popup này',
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, ticketText);

  assert.equal(ticket.popupAction, 'remove-one');
  assert.ok(audit.appliedFields.includes('popupAction'));
});

test('Gemini cannot reinterpret "hoan tat design Poster" as turning off a poster', () => {
  const ticketText = [
    'ID#5300 - Design poster',
    'Gui AE RECHECK sau khi hoan tat design Poster + Content: Yes',
    'Hi team, Nho team popup poster.'
  ].join('\n');
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, siteId: '5300' }, {
    siteId: '5300',
    popupRequested: true,
    operation: 'remove',
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    confidence: 0.99,
    evidence: {
      siteId: 'ID#5300 - Design poster',
      operation: 'hoan tat design Poster',
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, ticketText);

  assert.equal(ticket.popupAction, 'create');
  assert.equal(audit.appliedFields.includes('popupAction'), false);
});

test('Gemini cannot turn a negated new-popup instruction into replacement', () => {
  const ticketText = 'Remove this popup; do not add a new popup.';
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, popupAction: 'create' }, {
    siteId: null,
    popupRequested: true,
    operation: 'replace',
    popupPosition: null,
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    confidence: 0.99,
    evidence: {
      siteId: null,
      operation: ticketText,
      popupPosition: null,
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, ticketText);
  assert.equal(ticket.popupAction, 'create');
  assert.equal(audit.appliedFields.includes('popupAction'), false);
});

test('Gemini can add an explicit last popup position only with exact ticket evidence', () => {
  const ticketText = 'ID#5521 - Website Support\nPlease put this popup in the last position.';
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, popupPosition: null }, {
    siteId: '5521',
    popupRequested: true,
    operation: 'create',
    popupPosition: 'last',
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    confidence: 0.96,
    evidence: {
      siteId: 'ID#5521 - Website Support',
      operation: 'this popup',
      popupPosition: 'put this popup in the last position',
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, ticketText);
  assert.equal(ticket.popupPosition, 'last');
  assert.ok(audit.appliedFields.includes('popupPosition'));
});

test('converts the local semantic schema into a Gemini-compatible response schema', () => {
  const schema = geminiResponseSchema(SEMANTIC_SCHEMA);
  assert.equal(schema.properties.siteId.type, 'string');
  assert.equal(schema.properties.siteId.nullable, true);
  assert.equal(schema.properties.popupAttachmentIndex.type, 'integer');
  assert.equal(schema.properties.popupAttachmentIndex.nullable, true);
  assert.equal(schema.properties.popupPosition.nullable, true);
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.properties.evidence.additionalProperties, undefined);
  assert.doesNotMatch(JSON.stringify(schema), /"type"\s*:\s*\[/);
});

test('Gemini outage falls back to deterministic ticket data without throwing', async () => {
  const result = await resolveTicketSemantics(baseTicket, 'ID#16266 - Website Support', {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => { throw new Error('offline'); }
  });

  assert.equal(result.ticket.siteId, '16266');
  assert.equal(result.audit.status, 'unavailable');
  assert.equal(result.audit.provider, 'gemini');
});

test('retries a transient Gemini AbortError before returning semantic JSON', async () => {
  let calls = 0;
  const result = await requestGeminiTicketJson('Remove this popup.', {
    apiKey: 'test-key-not-a-real-secret',
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        error.code = 20;
        throw error;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ operation: 'remove' }) }] } }]
        })
      };
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.value, { operation: 'remove' });
});

test('accepts a Gemini-selected poster only when its evidence belongs to that attachment comment', () => {
  const ticketText = [
    'ID#778 - Website Support',
    'Comment: Please upload the Holiday popup poster below until 12/31/2026.'
  ].join('\n');
  const candidates = [
    { index: 1, filename: 'logo.png', context: 'Company logo for reference' },
    { index: 2, filename: 'holiday-poster.png', context: 'Please upload the Holiday popup poster below until 12/31/2026.' }
  ];
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, siteId: '778' }, {
    siteId: '778',
    popupRequested: true,
    operation: 'create',
    startDate: null,
    endDate: '2026-12-31',
    popupAttachmentIndex: 2,
    confidence: 0.95,
    evidence: {
      siteId: 'ID#778 - Website Support',
      operation: 'upload the Holiday popup',
      startDate: null,
      endDate: 'until 12/31/2026',
      popupAttachmentIndex: 'Holiday popup poster'
    },
    warnings: []
  }, ticketText, undefined, candidates);

  assert.equal(ticket.popupAttachmentIndex, 2);
  assert.ok(audit.appliedFields.includes('popupAttachmentIndex'));
});

test('rejects a Gemini attachment choice when its evidence points at another image', () => {
  const candidates = [
    { index: 1, filename: 'logo.png', context: 'Company logo for reference' },
    { index: 2, filename: 'holiday-poster.png', context: 'Holiday popup poster to upload' }
  ];
  const { ticket, audit } = mergeSemanticTicket(baseTicket, {
    siteId: '16266', popupRequested: true, operation: 'create', startDate: null, endDate: null,
    popupAttachmentIndex: 1, confidence: 0.95,
    evidence: { siteId: null, operation: null, startDate: null, endDate: null, popupAttachmentIndex: 'Holiday popup poster' },
    warnings: []
  }, 'ID#16266 - Website Support\nHoliday popup poster to upload', undefined, candidates);

  assert.equal(ticket.popupAttachmentIndex, undefined);
  assert.match(audit.warnings.join(' '), /popupAttachmentIndex/i);
});

test('keeps the tail of a long ticket and attachment labels in the Gemini prompt', () => {
  const longTicket = `${'a'.repeat(42000)}\nComment at end: popup expires 12/31/2026`;
  assert.match(ticketTextForSemanticPrompt(longTicket), /Comment at end/);
  assert.match(semanticPrompt('Ticket comment text', [{ index: 2, filename: 'poster.png', context: 'Use this popup poster' }]), /Attachment #2: poster\.png/);
});

test('Gemini Vision sends only supplied local image bytes and returns a valid selected attachment', async () => {
  let request = null;
  const result = await resolveTicketVision('Replace the old Halloween popup with the attached winter poster.', [{
    index: 2,
    filename: 'winter-poster.png',
    context: 'New poster for popup',
    mimeType: 'image/png',
    base64: 'aW1hZ2UtYnl0ZXM='
  }], {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            popupAttachmentIndex: 2,
            posterSchedule: {
              attachmentIndex: 2,
              startDate: null,
              endDate: '2026-12-31',
              evidence: 'Valid through December 31',
              confidence: 0.94
            },
            confidence: 0.92,
            rationale: 'The image is the new winter promotion poster.',
            warnings: []
          }) }] } }]
        })
      };
    }
  });

  assert.equal(result.selection.index, 2);
  assert.equal(result.selection.posterSchedules[0].endDate, '2026-12-31');
  assert.equal(result.audit.status, 'selected');
  const imagePart = request.contents[0].parts.find((part) => part.inline_data);
  assert.equal(imagePart.inline_data.mime_type, 'image/png');
  assert.equal(imagePart.inline_data.data, 'aW1hZ2UtYnl0ZXM=');
});

test('Gemini Vision rejects a selected index that was not among locally supplied images', async () => {
  const result = await resolveTicketVision('Popup ticket', [{
    index: 1, filename: 'poster.png', context: 'Popup', mimeType: 'image/png', base64: 'aQ=='
  }], {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          popupAttachmentIndex: 3,
          confidence: 0.99,
          rationale: 'not a local candidate',
          warnings: []
        }) }] } }]
      })
    })
  });

  assert.equal(result.selection, null);
  assert.equal(result.audit.status, 'ambiguous');
});

test('Gemini Vision selects a complete local two-poster set, not one arbitrary image', async () => {
  let request = null;
  const candidates = [
    { index: 1, filename: 'holiday-hours.png', context: 'Please publish both attached popup posters until end of month.', mimeType: 'image/png', base64: 'aG9saWRheQ==' },
    { index: 2, filename: 'special-offer.png', context: 'Please publish both attached popup posters until end of month.', mimeType: 'image/png', base64: 'b2ZmZXI=' }
  ];
  const result = await resolveTicketPopupVisionSet('Please publish the two attached popup posters until the end of November.', candidates, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            popupAttachmentIndices: [1, 2],
            posterSchedules: [
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
                confidence: 0.98
              }
            ],
            confidence: 0.94,
            rationale: 'Both images are distinct promotional posters requested in the ticket.',
            warnings: []
          }) }] } }]
        })
      };
    }
  });

  assert.deepEqual(result.selection.indices, [1, 2]);
  assert.deepEqual(result.selection.posterSchedules.map(({ attachmentIndex, startDate, endDate }) => ({
    attachmentIndex,
    startDate,
    endDate
  })), [
    { attachmentIndex: 1, startDate: '2026-11-01', endDate: '2026-12-31' },
    { attachmentIndex: 2, startDate: null, endDate: null }
  ]);
  assert.equal(result.audit.status, 'selected-set');
  assert.deepEqual(
    request.contents[0].parts.filter((part) => part.inline_data).map((part) => part.inline_data.data),
    candidates.map((candidate) => candidate.base64)
  );
  assert.ok(request.generationConfig.responseSchema.properties.posterSchedules);
  assert.match(request.contents[0].parts[0].text, /Closed on November 26.*null dates/i);
});

test('poster artwork schedules reject reversed ranges, closure dates, and unknown attachments without rejecting poster selection', () => {
  const candidates = [{ index: 1 }, { index: 2 }];
  const result = posterSchedulesFromResponse([
    {
      attachmentIndex: 1,
      startDate: '2026-12-31',
      endDate: '2026-11-01',
      evidence: 'Valid November 1 to December 31',
      confidence: 0.98
    },
    {
      attachmentIndex: 2,
      startDate: null,
      endDate: '2026-11-26',
      evidence: 'Closed on November 26, 2026',
      confidence: 0.99
    },
    {
      attachmentIndex: 3,
      startDate: null,
      endDate: '2026-12-31',
      evidence: 'Valid through December 31',
      confidence: 0.99
    }
  ], candidates, [1, 2]);

  assert.deepEqual(result.schedules.map(({ attachmentIndex, startDate, endDate }) => ({ attachmentIndex, startDate, endDate })), [
    { attachmentIndex: 1, startDate: null, endDate: null },
    { attachmentIndex: 2, startDate: null, endDate: null }
  ]);
  assert.match(result.warnings.join(' '), /reversed/i);
  assert.match(result.warnings.join(' '), /validity\/expiry evidence/i);
  assert.match(result.warnings.join(' '), /unknown or unselected/i);
});

test('poster artwork schedules accept promotional date ranges such as NOV 16 - DEC 7 and NOV 15 - DEC 31, 2026', () => {
  const candidates = [{ index: 1 }, { index: 2 }];
  const result = posterSchedulesFromResponse([
    {
      attachmentIndex: 1,
      startDate: '2026-11-16',
      endDate: '2026-12-07',
      evidence: 'NOV 16 – DEC 7',
      confidence: 0.95
    },
    {
      attachmentIndex: 2,
      startDate: '2026-11-15',
      endDate: '2026-12-31',
      evidence: 'NOV 15 – DEC 31, 2026',
      confidence: 0.96
    }
  ], candidates, [1, 2]);

  assert.deepEqual(result.schedules.map(({ attachmentIndex, startDate, endDate, evidence }) => ({
    attachmentIndex,
    startDate,
    endDate,
    evidence
  })), [
    { attachmentIndex: 1, startDate: '2026-11-16', endDate: '2026-12-07', evidence: 'NOV 16 – DEC 7' },
    { attachmentIndex: 2, startDate: '2026-11-15', endDate: '2026-12-31', evidence: 'NOV 15 – DEC 31, 2026' }
  ]);
  assert.equal(result.warnings.length, 0);
});

test('poster artwork schedules accept standard expiration evidence like EXP: 11/30/26, EXP. 11/30/2026, Expires, and Good Thru', () => {
  const candidates = [{ index: 1 }, { index: 2 }];
  const result = posterSchedulesFromResponse([
    {
      attachmentIndex: 1,
      startDate: null,
      endDate: '2026-11-30',
      evidence: 'EXP: 11/30/26',
      confidence: 0.95
    },
    {
      attachmentIndex: 2,
      startDate: null,
      endDate: '2026-12-31',
      evidence: 'EXP. 12/31/2026',
      confidence: 0.92
    }
  ], candidates, [1, 2]);

  assert.deepEqual(result.schedules.map(({ attachmentIndex, startDate, endDate, evidence }) => ({
    attachmentIndex,
    startDate,
    endDate,
    evidence
  })), [
    { attachmentIndex: 1, startDate: null, endDate: '2026-11-30', evidence: 'EXP: 11/30/26' },
    { attachmentIndex: 2, startDate: null, endDate: '2026-12-31', evidence: 'EXP. 12/31/2026' }
  ]);
  assert.equal(result.warnings.length, 0);
});

test('isValidPosterScheduleEvidence accepts standalone expiration dates like Dec 31, December 31, and 12/31/2026', () => {
  assert.equal(isValidPosterScheduleEvidence('Dec 31'), true);
  assert.equal(isValidPosterScheduleEvidence('December 31'), true);
  assert.equal(isValidPosterScheduleEvidence('Dec 31, 2026'), true);
  assert.equal(isValidPosterScheduleEvidence('12/31/2026'), true);
  assert.equal(isValidPosterScheduleEvidence('12/31'), true);
  assert.equal(isValidPosterScheduleEvidence('31 Dec'), true);
  assert.equal(isValidPosterScheduleEvidence('Valid until Dec 31'), true);
  assert.equal(isValidPosterScheduleEvidence('Closed on November 26'), false);
  assert.equal(isValidPosterScheduleEvidence('Nails & Spa promotion'), false);
});

test('poster artwork schedules accept standalone dates like Dec 31 from poster image (ticket 1604739)', () => {
  const candidates = [{ index: 1 }];
  const result = posterSchedulesFromResponse([
    {
      attachmentIndex: 1,
      startDate: null,
      endDate: '2026-12-31',
      evidence: 'Dec 31',
      confidence: 0.95
    }
  ], candidates, [1]);

  assert.deepEqual(result.schedules, [
    {
      attachmentIndex: 1,
      startDate: null,
      endDate: '2026-12-31',
      evidence: 'Dec 31',
      confidence: 0.95
    }
  ]);
  assert.equal(result.warnings.length, 0);
});

test('applyArtworkSchedulePrecedence enforces precedence: ticket note takes priority over poster artwork, but poster artwork date is adopted when ticket note has no expiry', () => {
  // Case 1: Ticket note has NO expiry date -> adopts poster artwork date (ticket 1604739)
  const ticketWithoutExpiry = {
    expiryDate: null,
    expiry: null,
    startDate: null,
    start: null,
    scheduleSource: null,
    popupAttachmentIndex: 1
  };
  const visionSchedules = [{
    attachmentIndex: 1,
    startDate: null,
    endDate: '2026-12-31',
    evidence: 'Dec 31',
    confidence: 0.95
  }];
  applyArtworkSchedulePrecedence(ticketWithoutExpiry, visionSchedules, 1);
  assert.equal(ticketWithoutExpiry.expiryDate, '2026-12-31');
  assert.equal(ticketWithoutExpiry.expiry, 'Dec 31');
  assert.equal(ticketWithoutExpiry.artworkExpiryDate, '2026-12-31');
  assert.equal(ticketWithoutExpiry.scheduleSource, 'poster-artwork');
  assert.equal(ticketWithoutExpiry.scheduleEvidence, 'Dec 31');

  // Case 2: Ticket note HAS an expiry date -> note takes precedence, but artworkExpiryDate is also recorded
  const ticketWithExplicitNote = {
    expiryDate: '2026-11-27',
    expiry: '11/27/2026',
    startDate: null,
    start: null,
    scheduleSource: 'ticket-text',
    popupAttachmentIndex: 1
  };
  applyArtworkSchedulePrecedence(ticketWithExplicitNote, visionSchedules, 1);
  assert.equal(ticketWithExplicitNote.expiryDate, '2026-11-27'); // Preserved from ticket note!
  assert.equal(ticketWithExplicitNote.artworkExpiryDate, '2026-12-31'); // Recorded from poster!
  assert.equal(ticketWithExplicitNote.scheduleSource, 'ticket-text');

  // Case 3: Indefinite ticket ("đến khi khách tắt") -> do not adopt dates
  const indefiniteTicket = {
    isIndefinite: true,
    expiryDate: null,
    expiry: null,
    popupAttachmentIndex: 1
  };
  applyArtworkSchedulePrecedence(indefiniteTicket, visionSchedules, 1);
  assert.equal(indefiniteTicket.expiryDate, null);
  assert.equal(indefiniteTicket.artworkExpiryDate, '2026-12-31');
});

test('Gemini Vision refuses an incomplete or duplicate multi-poster set', async () => {
  const candidates = [
    { index: 1, filename: 'first.png', mimeType: 'image/png', base64: 'MQ==' },
    { index: 2, filename: 'second.png', mimeType: 'image/png', base64: 'Mg==' }
  ];
  const result = await resolveTicketPopupVisionSet('Publish both attached posters.', candidates, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          popupAttachmentIndices: [1, 1],
          confidence: 0.99,
          rationale: 'duplicate index',
          warnings: []
        }) }] } }]
      })
    })
  });
  assert.equal(result.selection, null);
  assert.equal(result.audit.status, 'ambiguous');
});

test('Gemini Vision removal compares one local ticket reference with local CMS candidates only', async () => {
  let request = null;
  const reference = {
    filename: 'ticket-old-poster.png',
    mimeType: 'image/png',
    base64: 'dGlja2V0LXJlZmVyZW5jZQ=='
  };
  const candidates = [
    { index: 1, filename: 'cms-other.webp', mimeType: 'image/webp', base64: 'Y21zLW90aGVy' },
    { index: 2, filename: 'cms-matching.webp', mimeType: 'image/webp', base64: 'Y21zLW1hdGNoaW5n' }
  ];
  const result = await resolveTicketPopupRemovalVision('Please remove the attached popup.', reference, candidates, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            outcome: 'matched',
            popupCandidateIndex: 2,
            confidence: 0.94,
            rationale: 'The second CMS image matches the attached poster.',
            warnings: []
          }) }] } }]
        })
      };
    }
  });

  assert.equal(result.selection.index, 2);
  assert.equal(result.audit.status, 'selected');
  const imageParts = request.contents[0].parts.filter((part) => part.inline_data);
  assert.deepEqual(imageParts.map((part) => part.inline_data.data), [
    reference.base64,
    candidates[0].base64,
    candidates[1].base64
  ]);
});

test('Gemini Vision removal refuses a low-confidence CMS match', async () => {
  const result = await resolveTicketPopupRemovalVision('Remove this popup.', {
    filename: 'ticket.png', mimeType: 'image/png', base64: 'dGlja2V0'
  }, [{ index: 1, filename: 'cms.png', mimeType: 'image/png', base64: 'Y21z' }], {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          outcome: 'matched',
          popupCandidateIndex: 1,
          confidence: 0.7,
          rationale: 'Maybe similar.',
          warnings: []
        }) }] } }]
      })
    })
  });
  assert.equal(result.selection, null);
  assert.equal(result.audit.status, 'ambiguous');
});

test('Gemini Vision removal reports a confident no-match separately from ambiguity', async () => {
  const result = await resolveTicketPopupRemovalVision('Remove this popup.', {
    filename: 'ticket.png', mimeType: 'image/png', base64: 'dGlja2V0'
  }, [{ index: 1, filename: 'cms.png', mimeType: 'image/png', base64: 'Y21z' }], {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          outcome: 'not_found',
          popupCandidateIndex: null,
          confidence: 0.97,
          rationale: 'None of the current CMS images is the reference campaign.',
          warnings: []
        }) }] } }]
      })
    })
  });
  assert.equal(result.selection, null);
  assert.equal(result.audit.status, 'not-found');
  assert.match(result.audit.rationale, /None of the current CMS images/);
});

test('Gemini Vision removal keeps an explicit uncertain result ambiguous', async () => {
  const result = await resolveTicketPopupRemovalVision('Remove this popup.', {
    filename: 'ticket.png', mimeType: 'image/png', base64: 'dGlja2V0'
  }, [{ index: 1, filename: 'cms.png', mimeType: 'image/png', base64: 'Y21z' }], {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          outcome: 'ambiguous',
          popupCandidateIndex: null,
          confidence: 0.62,
          rationale: 'The artwork is too small to distinguish two similar campaigns.',
          warnings: []
        }) }] } }]
      })
    })
  });
  assert.equal(result.selection, null);
  assert.equal(result.audit.status, 'ambiguous');
});

test('unsafe or contradictory removal Vision decisions are never accepted as a match or no-match', () => {
  const candidates = [{ index: 1 }];
  const unsafe = [
    { outcome: 'matched', popupCandidateIndex: null, confidence: 0.99, rationale: 'Missing target.' },
    { outcome: 'matched', popupCandidateIndex: 2, confidence: 0.99, rationale: 'Unknown target.' },
    { outcome: 'matched', popupCandidateIndex: 1, confidence: 0.89, rationale: 'Too uncertain.' },
    { outcome: 'not_found', popupCandidateIndex: 1, confidence: 0.99, rationale: 'Contradictory target.' },
    { outcome: 'not_found', popupCandidateIndex: null, confidence: 0.89, rationale: 'Too uncertain.' },
    { outcome: 'ambiguous', popupCandidateIndex: 1, confidence: 0.8, rationale: 'Contradictory ambiguity.' }
  ];
  for (const value of unsafe) {
    const decision = removalVisionDecisionFromResponse(value, candidates);
    assert.equal(decision?.outcome, 'ambiguous');
    assert.equal(decision?.selection, null);
  }
  assert.equal(removalVisionDecisionFromResponse({
    popupCandidateIndex: null,
    confidence: 0.99,
    rationale: 'Missing outcome.'
  }, candidates), null);
});

test('multiVisionPrompt and visionPrompt clearly distinguish file upload posters from removal reference screenshots', () => {
  const candidates = [
    {
      index: 1,
      filename: 'artwork.jpg',
      kind: 'upload-card',
      context: 'Attached flyer'
    },
    {
      index: 2,
      filename: 'old-screenshot.png',
      kind: 'inline-image',
      precedingText: '1/ gỡ poster này xuống',
      isRemovalReference: true,
      context: '1/ gỡ poster này xuống'
    }
  ];
  const ticket = 'Hi team\n1/ gỡ poster này xuống\nThay bằng hình mới đính kèm';
  const prompt = multiVisionPrompt(ticket, candidates);
  assert.match(prompt, /EXCLUDE SCREENSHOTS/i);
  assert.match(prompt, /gỡ poster này xuống/i);
  assert.match(prompt, /REMOVAL REFERENCE/i);
  assert.match(prompt, /File upload attachment \/ "hình mới đính kèm"/i);

  const singlePrompt = visionPrompt(ticket, candidates);
  assert.match(singlePrompt, /EXCLUDE SCREENSHOTS/i);
  assert.match(singlePrompt, /REMOVAL REFERENCE/i);
});

test('multiVisionPrompt and visionPrompt include dual-action rule for gỡ [A] xuống và pop up [B]', () => {
  const prompt = multiVisionPrompt('test', []);
  assert.match(prompt, /gỡ pop up \[A\] xuống và pop up \[B\]/i);
  assert.match(prompt, /VERB meaning to CREATE\/PUBLISH popup B/i);

  const singlePrompt = visionPrompt('test', []);
  assert.match(singlePrompt, /gỡ pop up \[A\] xuống và pop up \[B\]/i);

  const semPrompt = semanticPrompt('test', []);
  assert.match(semPrompt, /gỡ \[A\] xuống và pop up \[B\]/i);
  assert.match(semPrompt, /VERB meaning to create\/publish popup B/i);
});

test('Gemini correctly resolves ticket 1605715 topic removal without attachments', () => {
  const ticketText = 'ID#4006 - Website Support\nNhờ team gỡ giúp em poster thông báo nghĩ lễ đang có trên cms và build web giúp em với ạ';
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, siteId: '4006' }, {
    siteId: '4006',
    popupRequested: true,
    operation: 'remove',
    actionSummary: 'Gỡ poster thông báo nghỉ lễ đang có trên CMS và Build web',
    removalTopic: 'thông báo nghĩ lễ',
    requiresAttachment: false,
    popupPosition: null,
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    popupLink: null,
    confidence: 0.98,
    evidence: {
      siteId: 'ID#4006',
      operation: 'gỡ giúp em poster thông báo nghĩ lễ đang có trên cms',
      popupPosition: null,
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, ticketText, undefined, []);

  assert.equal(ticket.siteId, '4006');
  assert.equal(ticket.popupAction, 'remove-one');
  assert.equal(ticket.removalScope, 'ticket-topic-remove-one');
  assert.equal(ticket.requiresAttachment, false);
  assert.equal(ticket.removalTopic, 'thông báo nghĩ lễ');
  assert.equal(ticket.actionSummary, 'Gỡ poster thông báo nghỉ lễ đang có trên CMS và Build web');
  assert.ok(audit.appliedFields.includes('popupAction'));
});

test('Gemini sets remove-all when ticket explicitly asks to remove all popups', () => {
  const ticketText = 'ID#9999 - Website Support\nNhờ team xóa toàn bộ popup đang chạy trên cms';
  const { ticket, audit } = mergeSemanticTicket({ ...baseTicket, siteId: '9999' }, {
    siteId: '9999',
    popupRequested: true,
    operation: 'remove-all',
    actionSummary: 'Xóa toàn bộ popup trên CMS',
    removalTopic: 'toàn bộ popup',
    requiresAttachment: false,
    popupPosition: null,
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    popupLink: null,
    confidence: 0.99,
    evidence: {
      siteId: 'ID#9999',
      operation: 'xóa toàn bộ popup đang chạy trên cms',
      popupPosition: null,
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, ticketText, undefined, []);

  assert.equal(ticket.siteId, '9999');
  assert.equal(ticket.popupAction, 'remove-all');
  assert.equal(ticket.hasInlineRemovalRequest, true);
  assert.ok(audit.appliedFields.includes('popupAction'));
});

test('Gemini Vision removal selects multiple candidate indices for multiple holiday announcements', async () => {
  const candidates = [
    { index: 1, filename: 'cms-holiday-1.webp', mimeType: 'image/webp', base64: 'aG9saWRheTE=' },
    { index: 2, filename: 'cms-discount.webp', mimeType: 'image/webp', base64: 'ZGlzY291bnQ=' },
    { index: 3, filename: 'cms-service.webp', mimeType: 'image/webp', base64: 'c2VydmljZQ==' },
    { index: 4, filename: 'cms-holiday-2.webp', mimeType: 'image/webp', base64: 'aG9saWRheTI=' }
  ];
  const result = await resolveTicketPopupRemovalVision('Xóa giúp poster pop up thông báo nghỉ trên website', null, candidates, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          outcome: 'matched',
          popupCandidateIndex: 1,
          popupCandidateIndices: [1, 4],
          confidence: 0.96,
          rationale: 'Cả ảnh #1 và #4 đều là thông báo nghỉ lễ Thanksgiving nên cần được gỡ.',
          warnings: []
        }) }] } }]
      })
    })
  });

  assert.equal(result.selection.index, 1);
  assert.deepEqual(result.selection.indices, [1, 4]);
  assert.equal(result.audit.status, 'selected');
});

test('visionPrompt and semanticPrompt include explicit rules for comment replacement poster precedence', () => {
  const prompt = visionPrompt('Ticket text', [{ index: 1, filename: 'p1.png' }, { index: 2, filename: 'p2.png' }]);
  assert.match(prompt, /Nhờ team thay bằng poster này giúp|thay bằng poster này/i);
  assert.match(prompt, /REPLACES/);

  const multiPrompt = multiVisionPrompt('Ticket text', [{ index: 1, filename: 'p1.png' }, { index: 2, filename: 'p2.png' }]);
  assert.match(multiPrompt, /Nhờ team thay bằng poster này giúp|thay bằng poster này/i);

  const semPrompt = semanticPrompt('Ticket text', [{ index: 1, filename: 'p1.png' }, { index: 2, filename: 'p2.png' }]);
  assert.match(semPrompt, /Nhờ team thay bằng poster này giúp|thay bằng poster này/i);
});

test('resolveTicketPopupVisionSet stops model fallback on gemini-invalid-image and preserves errorDetail', async () => {
  let calls = 0;
  const candidates = [
    { index: 1, filename: 'p1.png', mimeType: 'image/png', base64: 'aG9saWRheQ==' },
    { index: 2, filename: 'p2.png', mimeType: 'image/png', base64: 'cG9zdGVy' }
  ];
  const result = await resolveTicketPopupVisionSet('Popup request', candidates, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: 'Unable to process input image. Please retry.' }
        })
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.selection, null);
  assert.equal(result.audit.status, 'unavailable');
  assert.equal(result.audit.errorCode, 'gemini-invalid-image');
  assert.match(result.audit.errorDetail, /Unable to process input image/);
});

test('resolveVisualDuplicateConfirmation distinguishes different announcements sharing salon branding', async () => {
  const ticketImg = { filename: 'thanksgiving.png', mimeType: 'image/png', base64: 'dGhhbmtz' };
  const cmsImg = { filename: 'monday.webp', mimeType: 'image/webp', base64: 'bW9uZGF5' };

  const different = await resolveVisualDuplicateConfirmation(ticketImg, cmsImg, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          samePosterArtwork: false,
          confidence: 0.96,
          rationale: 'Image 1 is Thanksgiving closure while Image 2 is Monday Special.'
        }) }] } }]
      })
    })
  });
  assert.equal(different.confirmed, false);
  assert.equal(different.audit.status, 'different');

  const sameArtwork = await resolveVisualDuplicateConfirmation(ticketImg, cmsImg, {
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          samePosterArtwork: true,
          confidence: 0.95,
          rationale: 'Both are the same Thanksgiving closure poster with updated expiry date.'
        }) }] } }]
      })
    })
  });
  assert.equal(sameArtwork.confirmed, true);
  assert.equal(sameArtwork.audit.status, 'matched');
});

test('mergeSemanticTicket allows Gemini create + requiresAttachment to override deterministic update-duration', () => {
  const deterministic = {
    ...baseTicket,
    popupAction: 'update-duration',
    popupDuration: { requestedSeconds: 10, delaySliderSeconds: 13, isExplicitSlider: false }
  };
  const { ticket, audit } = mergeSemanticTicket(deterministic, {
    siteId: '16266',
    popupRequested: true,
    operation: 'create',
    actionSummary: 'Tạo popup mới từ ảnh đính kèm với thời gian 10s',
    removalTopic: null,
    requiresAttachment: true,
    popupPosition: null,
    startDate: null,
    endDate: null,
    popupAttachmentIndex: 1,
    popupLink: null,
    confidence: 0.95,
    evidence: {
      siteId: 'ID#16266',
      operation: 'pop up giup tiem 10s',
      popupPosition: null,
      startDate: null,
      endDate: null,
      popupAttachmentIndex: 'poster.png'
    },
    warnings: []
  }, 'ID#16266\nNhờ team pop up giúp tiệm 10s', undefined, [{ index: 1, filename: 'poster.png', context: 'poster.png' }]);

  assert.equal(ticket.popupAction, 'create');
  assert.equal(ticket.popupDuration.requestedSeconds, 10);
  assert.ok(audit.appliedFields.includes('popupAction'));
});

test('visionPrompt exposes pixel sizes and resolvePopupOrderVision maps custom order labels to entries', async () => {
  const prompt = visionPrompt('Nhờ team up lại ảnh này, vì đúng size 1x1', [
    { index: 1, filename: 'old.png', width: 682, height: 1024, aspectLabel: '0.67 (portrait)', context: 'old poster' },
    { index: 2, filename: 'new.webp', width: 1024, height: 1024, aspectLabel: '1:1 (square)', context: 'size 1x1' }
  ]);
  assert.match(prompt, /\[Size: 682x1024, Aspect: 0\.67 \(portrait\)\]/);
  assert.match(prompt, /\[Size: 1024x1024, Aspect: 1:1 \(square\)\]/);
  assert.match(prompt, /DIFFERENT SIZE \/ ASPECT RATIO RE-UPLOAD/);

  const entries = [
    { index: 1, filename: 'weekly-appreciation.png', isTicket: true, mimeType: 'image/png', base64: 'MQ==' },
    { index: 2, filename: 'giftcard.png', isTicket: true, mimeType: 'image/png', base64: 'Mg==' },
    { index: 3, filename: 'weekly-special.webp', isTicket: false, mimeType: 'image/webp', base64: 'Mw==' }
  ];
  const orderResult = await resolvePopupOrderVision(
    ['Giftcard', 'Weekly Appreciation', 'Weekly Special'],
    entries,
    {
      apiKey: 'test-key-not-a-real-secret',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            orderedIndices: [2, 1, 3],
            confidence: 0.97,
            rationale: 'Entry #2 is Giftcard, Entry #1 is Weekly Appreciation, Entry #3 is Weekly Special.'
          }) }] } }]
        })
      })
    }
  );
  assert.deepEqual(orderResult.orderedIndices, [2, 1, 3]);
  assert.equal(orderResult.audit.status, 'ordered');
});

test('mergeSemanticTicket respects uncompleted active comments for create vs replace and validates remove-expired', () => {
  const multiRoundText = [
    'ID#4832 - Support',
    'Conversations',
    'Reload',
    'Hau Do',
    'hau_do@fastboy.net',
    'Nov 27, 2026 11:17 PM',
    'Nhờ team hỗ trợ popup poster lên website giúp khách nha',
    'EXP: 11/27/2026',
    'Tai Nguyen (TE)',
    'tai_nguyen@fastboy.net',
    'Nov 27, 2026 11:15 PM',
    'Đã update theo yêu cầu',
    'Hau Do',
    'hau_do@fastboy.net',
    'Nov 27, 2026 10:55 PM',
    'Nhờ team hỗ trợ remove poster 20% gift card nha',
    'Fastboy CRM @ 2026 Created by Fastboy'
  ].join('\n');

  const mergedCreate = mergeSemanticTicket({ ...baseTicket, siteId: '4832', popupAction: 'replace' }, {
    siteId: '4832',
    popupRequested: true,
    operation: 'create',
    actionSummary: 'Tạo popup mới từ poster đính kèm',
    removalTopic: null,
    requiresAttachment: true,
    popupPosition: null,
    startDate: null,
    endDate: '2026-11-27',
    popupAttachmentIndex: 1,
    popupLink: null,
    confidence: 0.95,
    evidence: {
      siteId: 'ID#4832',
      operation: 'popup poster lên website',
      popupPosition: null,
      startDate: null,
      endDate: 'EXP: 11/27/2026',
      popupAttachmentIndex: 'black-friday.png'
    },
    warnings: []
  }, multiRoundText, undefined, [{ index: 1, filename: 'black-friday.png', context: 'black-friday.png' }]);
  assert.equal(mergedCreate.ticket.popupAction, 'create');

  const expiredText = 'ID#4832 - Update website\nNhờ team xóa các popup đã hết hạn trên CMS';
  const mergedExpired = mergeSemanticTicket({ ...baseTicket, siteId: '4832', popupAction: 'create' }, {
    siteId: '4832',
    popupRequested: true,
    operation: 'remove-expired',
    actionSummary: 'Xóa các popup đã hết hạn trên CMS',
    removalTopic: null,
    requiresAttachment: false,
    popupPosition: null,
    startDate: null,
    endDate: null,
    popupAttachmentIndex: null,
    popupLink: null,
    confidence: 0.94,
    evidence: {
      siteId: 'ID#4832',
      operation: 'xóa các popup đã hết hạn',
      popupPosition: null,
      startDate: null,
      endDate: null,
      popupAttachmentIndex: null
    },
    warnings: []
  }, expiredText);
  assert.equal(mergedExpired.ticket.popupAction, 'remove-expired');
  assert.equal(mergedExpired.ticket.requiresAttachment, false);
});

