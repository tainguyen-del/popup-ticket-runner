'use strict';

function projectDomainsFromText(text) {
  const matches = String(text || '').match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi) || [];
  return [...new Set(matches.map((domain) => domain.toLowerCase()))];
}

function isPreviewProjectDomain(domain) {
  const value = String(domain || '').toLowerCase();
  return value === 'newzensite.online' || value.endsWith('.newzensite.online');
}

function chooseProjectCandidate(candidates) {
  if (!candidates.length) return { candidate: null, method: null, ambiguous: false };
  const customDomainCandidates = candidates.filter((candidate) => (
    candidate.domains.some((domain) => !isPreviewProjectDomain(domain))
  ));
  if (customDomainCandidates.length === 1) {
    return { candidate: customDomainCandidates[0], method: 'custom-domain', ambiguous: false };
  }
  if (customDomainCandidates.length > 1) return { candidate: null, method: null, ambiguous: true };
  if (candidates.length === 1) return { candidate: candidates[0], method: 'only-match', ambiguous: false };
  return { candidate: null, method: null, ambiguous: true };
}

function projectBaseUrl(projectUrl) {
  const match = String(projectUrl || '').match(/^(https:\/\/apps\.newzensite\.com\/organization-\d+\/projects\/\d+)/i);
  if (!match) throw new Error(`Unexpected NewZenSite project URL: ${projectUrl}`);
  return match[1];
}

module.exports = {
  projectDomainsFromText,
  isPreviewProjectDomain,
  chooseProjectCandidate,
  projectBaseUrl
};
