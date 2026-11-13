const test = require('node:test');
const assert = require('node:assert/strict');
const { attachmentPlanForTicket } = require('../src/attachment-plan');

test('uses no attachment for actions that do not need a ticket image', () => {
  assert.deepEqual(
    attachmentPlanForTicket({ popupAction: 'remove-all', attachmentCount: 3 }),
    {
      mode: 'none',
      required: false,
      ready: true,
      attachmentCount: 3,
      selectedIndex: null,
      selectedIndexes: [],
      reason: 'popup-action-does-not-require-ticket-image'
    }
  );
});

test('reports a missing required poster without guessing', () => {
  const plan = attachmentPlanForTicket({ popupAction: 'create', attachmentCount: 0 });
  assert.equal(plan.mode, 'none');
  assert.equal(plan.required, true);
  assert.equal(plan.ready, false);
  assert.equal(plan.reason, 'ticket-has-no-image-attachment');
});

test('automatically selects the sole image for create or replace', () => {
  for (const popupAction of ['create', 'replace']) {
    const plan = attachmentPlanForTicket({ popupAction, attachmentCount: 1 });
    assert.equal(plan.mode, 'single');
    assert.equal(plan.ready, true);
    assert.equal(plan.selectedIndex, 1);
    assert.deepEqual(plan.selectedIndexes, [1]);
  }
});

test('requires a verified poster set when create has multiple images', () => {
  const unresolved = attachmentPlanForTicket({
    popupAction: 'create',
    attachmentCount: 3,
    popupAttachmentIndex: 2
  });
  assert.equal(unresolved.mode, 'multi-set');
  assert.equal(unresolved.ready, false);
  assert.deepEqual(unresolved.selectedIndexes, []);

  const resolved = attachmentPlanForTicket({
    popupAction: 'create',
    attachmentCount: 3,
    popupAttachmentIndexes: [3, 1, 3]
  });
  assert.equal(resolved.mode, 'multi-set');
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.selectedIndexes, [3, 1]);
});

test('uses a separate reference-image mode for removing one popup', () => {
  const unresolved = attachmentPlanForTicket({
    popupAction: 'remove-one',
    attachmentCount: 3
  });
  assert.equal(unresolved.mode, 'removal-reference');
  assert.equal(unresolved.ready, false);
  assert.equal(unresolved.selectedIndex, null);

  const resolved = attachmentPlanForTicket({
    popupAction: 'remove-one',
    attachmentCount: 3,
    popupAttachmentIndex: 2
  });
  assert.equal(resolved.mode, 'removal-reference');
  assert.equal(resolved.ready, true);
  assert.equal(resolved.selectedIndex, 2);
  assert.deepEqual(resolved.selectedIndexes, [2]);
});

test('does not accept out-of-range verified indexes', () => {
  const plan = attachmentPlanForTicket({
    popupAction: 'replace',
    attachmentCount: 2,
    popupAttachmentIndexes: [0, 3, 'not-an-index']
  });
  assert.equal(plan.mode, 'multi-set');
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.selectedIndexes, []);
});

test('rejects invalid attachment counts', () => {
  assert.throws(
    () => attachmentPlanForTicket({ popupAction: 'create', attachmentCount: -1 }),
    /attachmentCount must be a non-negative integer/
  );
});
