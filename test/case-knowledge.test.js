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

test('loads the knowledge base cases properly', () => {
  const cases = loadKnowledgeBase();
  assert.ok(Array.isArray(cases));
  assert.ok(cases.length >= 5);
  const replaceCase = cases.find((c) => c.id === 'case-replace-dual-action');
  assert.ok(replaceCase);
  assert.equal(replaceCase.expected.operation, 'replace');
});

test('formats learned cases for LLM prompt', () => {
  const promptSection = formatCasesForPrompt();
  assert.match(promptSection, /--- LEARNED TEAM SUPPORT CASES/);
  assert.match(promptSection, /ID#19191/);
  assert.match(promptSection, /ID - 19914/);
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
