const test = require('node:test');
const assert = require('node:assert/strict');
const {
  projectDomainsFromText,
  isPreviewProjectDomain,
  chooseProjectCandidate,
  projectBaseUrl
} = require('../src/cms/project-selector');
const {
  announcementPluginVersionFromText,
  announcementSectionVersionToken,
  mustCreateFreshAnnouncementSection
} = require('../src/cms/plugin-policy');

test('extracts normalized unique project domains', () => {
  assert.deepEqual(
    projectDomainsFromText('2989\nSITE.EXAMPLE.COM\n2989-7381.newzensite.online\nsite.example.com'),
    ['site.example.com', '2989-7381.newzensite.online']
  );
});

test('recognizes NewZen preview domains', () => {
  assert.equal(isPreviewProjectDomain('2989-7381.newzensite.online'), true);
  assert.equal(isPreviewProjectDomain('newzensite.online'), true);
  assert.equal(isPreviewProjectDomain('salon.example.com'), false);
});

test('selects the sole custom-domain project when duplicate IDs exist', () => {
  const preview = { locatorIndex: 0, domains: ['2989-7381.newzensite.online'] };
  const live = { locatorIndex: 1, domains: ['lvnailspacepecorl.com'] };
  assert.deepEqual(chooseProjectCandidate([preview, live]), {
    candidate: live,
    method: 'custom-domain',
    ambiguous: false
  });
});

test('keeps project selection ambiguous when multiple live domains exist', () => {
  const first = { locatorIndex: 0, domains: ['one.example.com'] };
  const second = { locatorIndex: 1, domains: ['two.example.com'] };
  assert.deepEqual(chooseProjectCandidate([first, second]), {
    candidate: null,
    method: null,
    ambiguous: true
  });
});

test('parses the stable project base URL and rejects unrelated URLs', () => {
  assert.equal(
    projectBaseUrl('https://apps.newzensite.com/organization-9/projects/123/pages/index'),
    'https://apps.newzensite.com/organization-9/projects/123'
  );
  assert.throws(() => projectBaseUrl('https://example.com/projects/123'), /Unexpected NewZenSite project URL/);
});

test('reads Announcement plugin and section version tokens', () => {
  assert.equal(announcementPluginVersionFromText('Announcement 1.0.38 Active'), '1.0.38');
  assert.equal(announcementPluginVersionFromText('No version'), null);
  assert.equal(announcementSectionVersionToken('1.0.38'), '1038');
  assert.equal(announcementSectionVersionToken('1.0'), null);
});

test('requires a fresh section after install, update, or any legacy section', () => {
  assert.equal(mustCreateFreshAnnouncementSection({ pluginStateBeforeApply: 'missing' }), true);
  assert.equal(mustCreateFreshAnnouncementSection({ pluginStateBeforeApply: 'outdated' }), true);
  assert.equal(mustCreateFreshAnnouncementSection({ pluginUpdated: true }), true);
  assert.equal(mustCreateFreshAnnouncementSection({ legacySectionIds: ['announcement-1034'] }), true);
  assert.equal(mustCreateFreshAnnouncementSection({ pluginStateBeforeApply: 'current' }), false);
});
