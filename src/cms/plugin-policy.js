'use strict';

function announcementPluginVersionFromText(value) {
  return /\b\d+(?:\.\d+){2,}\b/.exec(String(value || ''))?.[0] || null;
}

function announcementSectionVersionToken(version) {
  const digits = String(version || '').replace(/\D/g, '');
  return digits.length >= 3 ? digits : null;
}

function mustCreateFreshAnnouncementSection({
  pluginStateBeforeApply = null,
  pluginUpdated = false,
  legacySectionIds = []
} = {}) {
  return pluginStateBeforeApply === 'missing'
    || pluginStateBeforeApply === 'outdated'
    || pluginUpdated === true
    || legacySectionIds.length > 0;
}

module.exports = {
  announcementPluginVersionFromText,
  announcementSectionVersionToken,
  mustCreateFreshAnnouncementSection
};
