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
  geminiResponseSchema
} = require('../src/semantic-ticket');

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
