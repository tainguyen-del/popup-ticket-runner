'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KNOWLEDGE_FILE = path.resolve(__dirname, '..', 'data', 'knowledge-base.json');

function loadKnowledgeBase(customPath = null) {
  const targetPath = customPath || KNOWLEDGE_FILE;
  if (!fs.existsSync(targetPath)) return [];
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveKnowledgeBase(cases, customPath = null) {
  const targetPath = customPath || KNOWLEDGE_FILE;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(cases, null, 2), 'utf8');
}

function formatCasesForPrompt(cases = null) {
  const list = cases || loadKnowledgeBase();
  if (!list.length) return '';

  const formatted = list.slice(0, 10).map((item, index) => {
    return [
      `[Example ${index + 1}: ${item.title || 'Support Case'}]`,
      `Ticket text: "${item.ticketSample.replace(/\n/g, ' ')}"`,
      `Guidance: ${item.explanation}`,
      `Correct output facts: operation="${item.expected?.operation}", expiry="${item.expected?.expiry || 'null'}", popupPosition="${item.expected?.popupPosition || 'null'}"`
    ].join('\n');
  }).join('\n\n');

  return `--- LEARNED TEAM SUPPORT CASES (Few-Shot Reference) ---\nUse these verified cases from our support team to guide your extraction for similar phrasing:\n\n${formatted}\n--- END LEARNED CASES ---`;
}

function learnNewCase(newCase, customPath = null) {
  if (!newCase || !newCase.ticketSample) return false;
  const cases = loadKnowledgeBase(customPath);
  const exists = cases.some((c) => c.ticketSample.trim() === newCase.ticketSample.trim());
  if (exists) return false;

  cases.push({
    id: newCase.id || `case-${Date.now()}`,
    title: newCase.title || 'User Verified Case',
    ticketSample: newCase.ticketSample.trim(),
    explanation: newCase.explanation || 'Verified by team operator',
    expected: newCase.expected || {},
    createdAt: new Date().toISOString()
  });

  saveKnowledgeBase(cases, customPath);
  return true;
}

module.exports = {
  KNOWLEDGE_FILE,
  loadKnowledgeBase,
  saveKnowledgeBase,
  formatCasesForPrompt,
  learnNewCase
};
