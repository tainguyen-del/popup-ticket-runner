'use strict';

function decodedImageBasename(value) {
  const raw = String(value || '');
  let basename = raw;
  try {
    basename = new URL(raw).pathname.split('/').pop() || raw;
  } catch {
    basename = raw.replace(/[?#].*$/, '').replace(/^.*[\\/]/, '');
  }
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function embeddedUploadHash(value) {
  const stem = decodedImageBasename(value)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]\d{3,}$/i, '');
  const match = /(?:^|[-_])([a-f0-9]{12,64})$/i.exec(stem);
  return match ? match[1].toLowerCase() : null;
}

function popupImageIdentity(value) {
  const stem = decodedImageBasename(value).replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]\d{3,}$/i, '')
    .replace(/[-_][a-f0-9]{12,64}$/i, '')
    .replace(/^index[-_]/i, '')
    .replace(/^popup[-_]/i, '');
  const identity = stem.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return identity.length >= 5 && /\d/.test(identity) ? identity : null;
}

function findDuplicatePopupImages(ticketImages, cmsImages) {
  const tickets = Array.isArray(ticketImages) ? ticketImages : [];
  const existing = Array.isArray(cmsImages) ? cmsImages : [];
  const matches = [];
  tickets.forEach((ticket, ticketIndex) => {
    const ticketHash = String(ticket?.sha256 || '').toLowerCase();
    const ticketIdentity = popupImageIdentity(ticket?.filename || ticket?.imagePath || ticket?.path);
    existing.forEach((cms, cmsIndex) => {
      const cmsHash = String(cms?.sha256 || '').toLowerCase();
      const cmsSource = cms?.sourceImageUrl || cms?.filename || cms?.imagePath;
      const cmsIdentity = popupImageIdentity(cmsSource);
      const cmsUploadHash = embeddedUploadHash(cmsSource);
      const method = ticketHash && cmsHash && ticketHash === cmsHash
        ? 'sha256'
        : ticketHash && cmsUploadHash && ticketHash.startsWith(cmsUploadHash)
          ? 'upload-hash-suffix'
          : !(ticketHash && cmsHash) && ticketIdentity && cmsIdentity && ticketIdentity === cmsIdentity
          ? 'filename-identity'
          : null;
      if (method) matches.push({ ticketIndex, cmsIndex, method, ticket, cms });
    });
  });
  return matches;
}

module.exports = {
  decodedImageBasename,
  embeddedUploadHash,
  popupImageIdentity,
  findDuplicatePopupImages
};
