'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { appDataDirectory } = require('./app-paths');

const ROOT_DIR = path.resolve(__dirname, '..');
const KNOWLEDGE_FILE = path.join(ROOT_DIR, 'data', 'knowledge-base.json');

function userKnowledgeFile(root = ROOT_DIR) {
  return path.join(appDataDirectory(root), 'knowledge-base.json');
}

function readKnowledgeArray(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadKnowledgeBase(customPath = null) {
  if (customPath) return readKnowledgeArray(customPath);
  const bundled = readKnowledgeArray(KNOWLEDGE_FILE);
  const external = readKnowledgeArray(userKnowledgeFile());
  if (!external.length) return bundled;
  const merged = [...bundled];
  const seenSamples = new Set(bundled.map((item) => String(item?.ticketSample || '').trim()).filter(Boolean));
  for (const item of external) {
    const sample = String(item?.ticketSample || '').trim();
    if (!sample || seenSamples.has(sample)) continue;
    seenSamples.add(sample);
    merged.push(item);
  }
  return merged;
}

function saveKnowledgeBase(cases, customPath = null) {
  const targetPath = customPath || userKnowledgeFile();
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(cases, null, 2), 'utf8');
}

function formatCasesForPrompt(cases = null) {
  const list = cases || loadKnowledgeBase();
  if (!list.length) return '';

  const formatted = list.slice(0, 25).map((item, index) => {
    const expected = item.expected || {};
    const extras = [];
    if (typeof expected.isIndefinite === 'boolean') extras.push(`isIndefinite=${expected.isIndefinite}`);
    if (typeof expected.isMultiPoster === 'boolean') extras.push(`isMultiPoster=${expected.isMultiPoster}`);
    if (Number.isInteger(expected.durationSeconds)) extras.push(`durationSeconds=${expected.durationSeconds}`);
    return [
      `[Example ${index + 1}: ${item.title || 'Support Case'}]`,
      `Ticket text: "${String(item.ticketSample || '').replace(/\n/g, ' ')}"`,
      `Guidance: ${item.explanation}`,
      `Correct output facts: operation="${expected.operation}", expiry="${expected.expiry || 'null'}", popupPosition="${expected.popupPosition || 'null'}"${extras.length ? `, ${extras.join(', ')}` : ''}`
    ].join('\n');
  }).join('\n\n');

  return `--- LEARNED TEAM SUPPORT CASES (Few-Shot Reference) ---\nUse these verified cases from our support team to guide your extraction for similar phrasing:\n\n${formatted}\n--- END LEARNED CASES ---`;
}

function learnNewCase(newCase, customPath = null) {
  if (!newCase || !newCase.ticketSample) return false;
  const targetPath = customPath || userKnowledgeFile();
  const existingAll = customPath ? readKnowledgeArray(targetPath) : loadKnowledgeBase();
  const exists = existingAll.some((c) => String(c.ticketSample || '').trim() === newCase.ticketSample.trim());
  if (exists) return false;

  const targetCases = readKnowledgeArray(targetPath);
  targetCases.push({
    id: newCase.id || `case-${Date.now()}`,
    title: newCase.title || 'User Verified Case',
    ticketSample: newCase.ticketSample.trim(),
    explanation: newCase.explanation || 'Verified by team operator',
    expected: newCase.expected || {},
    createdAt: new Date().toISOString()
  });

  saveKnowledgeBase(targetCases, targetPath);
  return true;
}

module.exports = {
  KNOWLEDGE_FILE,
  userKnowledgeFile,
  loadKnowledgeBase,
  saveKnowledgeBase,
  formatCasesForPrompt,
  learnNewCase
};
