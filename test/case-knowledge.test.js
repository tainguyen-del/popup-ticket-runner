const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  loadKnowledgeBase,
  formatCasesForPrompt,
  learnNewCase
} = require('../src/case-knowledge');

test('loads the knowledge base cases properly including auto-turn-off example', () => {
  const cases = loadKnowledgeBase();
  assert.ok(Array.isArray(cases));
  assert.ok(cases.length >= 6);
  const replaceCase = cases.find((c) => c.id === 'case-replace-dual-action');
  assert.ok(replaceCase);
  assert.equal(replaceCase.expected.operation, 'replace');
  const autoTurnOffCase = cases.find((c) => c.id === 'case-auto-turn-off-expiry');
  assert.ok(autoTurnOffCase);
  assert.equal(autoTurnOffCase.expected.operation, 'create');
  assert.equal(autoTurnOffCase.expected.expiry, '2027-01-01');
});

test('formats learned cases for LLM prompt', () => {
  const promptSection = formatCasesForPrompt();
  assert.match(promptSection, /--- LEARNED TEAM SUPPORT CASES/);
  assert.match(promptSection, /ID#19191/);
  assert.match(promptSection, /ID - 19914/);
  assert.match(promptSection, /Auto turn off poster: 1\/01\/2027/);
});

test('merges writable AppData user knowledge base cases on top of bundled cases', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-kb-appdata-'));
  const prevDataDir = process.env.POPUP_TICKET_RUNNER_DATA_DIR;
  process.env.POPUP_TICKET_RUNNER_DATA_DIR = tempDir;
  try {
    const added = learnNewCase({
      id: 'user-custom-1',
      title: 'Custom shop phrase',
      ticketSample: 'Dẹp popup cũ giùm shop ID#54321',
      explanation: 'Dẹp nghĩa là remove',
      expected: { siteId: '54321', operation: 'remove' }
    });
    assert.equal(added, true);
    const merged = loadKnowledgeBase();
    assert.ok(merged.some((c) => c.id === 'case-auto-turn-off-expiry'));
    assert.ok(merged.some((c) => c.id === 'user-custom-1'));
  } finally {
    if (prevDataDir === undefined) delete process.env.POPUP_TICKET_RUNNER_DATA_DIR;
    else process.env.POPUP_TICKET_RUNNER_DATA_DIR = prevDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('learns and persists a new unique support case', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-kb-test-'));
  const tempFile = path.join(tempDir, 'kb.json');
  try {
    const initialAdded = learnNewCase({
      id: 'test-case-1',
      title: 'Special promotion case',
      ticketSample: 'Nhờ team thêm popup Black Friday cho site 99999',
      explanation: 'Action create with Black Friday promotion',
      expected: { siteId: '99999', operation: 'create' }
    }, tempFile);
    assert.equal(initialAdded, true);

    const loaded = loadKnowledgeBase(tempFile);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].expected.siteId, '99999');

    // Duplicate check
    const duplicateAdded = learnNewCase({
      ticketSample: 'Nhờ team thêm popup Black Friday cho site 99999'
    }, tempFile);
    assert.equal(duplicateAdded, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
