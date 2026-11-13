'use strict';

const fs = require('node:fs');

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

async function findDuplicatePopupImagesWithVision(page, ticketImages, cmsImages) {
  const directMatches = findDuplicatePopupImages(ticketImages, cmsImages);
  if (directMatches.length) return directMatches;

  if (!page || !Array.isArray(ticketImages) || !Array.isArray(cmsImages)) return [];

  const matches = [];
  for (let ticketIndex = 0; ticketIndex < ticketImages.length; ticketIndex += 1) {
    const ticket = ticketImages[ticketIndex];
    const ticketPath = ticket?.uploadPath || ticket?.path || ticket?.imagePath;
    if (!ticketPath || !fs.existsSync(ticketPath)) continue;
    const ticketBase64 = fs.readFileSync(ticketPath).toString('base64');
    const ticketMime = ticketPath.endsWith('.png') ? 'image/png' : (ticketPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg');

    let bestMatch = null;
    for (let cmsIndex = 0; cmsIndex < cmsImages.length; cmsIndex += 1) {
      const cms = cmsImages[cmsIndex];
      const cmsPath = cms?.imagePath || cms?.path || cms?.uploadPath;
      if (!cmsPath || !fs.existsSync(cmsPath)) continue;
      const cmsBase64 = fs.readFileSync(cmsPath).toString('base64');
      const cmsMime = cmsPath.endsWith('.png') ? 'image/png' : (cmsPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg');

      try {
        const similarity = await page.evaluate(async ({ tData, tMime, cData, cMime }) => {
          function load(data, mime) {
            return new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = reject;
              img.src = `data:${mime};base64,${data}`;
            });
          }
          const [img1, img2] = await Promise.all([load(tData, tMime), load(cData, cMime)]);
          const ratio1 = img1.width / img1.height;
          const ratio2 = img2.width / img2.height;
          if (Math.abs(ratio1 - ratio2) > 0.15) return 0;

          const canvas1 = document.createElement('canvas');
          canvas1.width = 32; canvas1.height = 32;
          const ctx1 = canvas1.getContext('2d');
          ctx1.drawImage(img1, 0, 0, 32, 32);
          const d1 = ctx1.getImageData(0, 0, 32, 32).data;

          const canvas2 = document.createElement('canvas');
          canvas2.width = 32; canvas2.height = 32;
          const ctx2 = canvas2.getContext('2d');
          ctx2.drawImage(img2, 0, 0, 32, 32);
          const d2 = ctx2.getImageData(0, 0, 32, 32).data;

          let diff = 0;
          for (let i = 0; i < d1.length; i += 4) {
            diff += Math.abs(d1[i] - d2[i]) + Math.abs(d1[i+1] - d2[i+1]) + Math.abs(d1[i+2] - d2[i+2]);
          }
          const maxDiff = (d1.length / 4) * 255 * 3;
          return 1 - (diff / maxDiff);
        }, { tData: ticketBase64, tMime: ticketMime, cData: cmsBase64, cMime: cmsMime });

        if (similarity >= 0.90) {
          const candidate = {
            ticketIndex,
            cmsIndex,
            method: 'visual-similarity',
            similarity,
            ticket,
            cms
          };
          if (!bestMatch) {
            bestMatch = candidate;
          } else {
            const candidateHasSchedule = !!(candidate.cms?.end || candidate.cms?.start);
            const bestHasSchedule = !!(bestMatch.cms?.end || bestMatch.cms?.start);
            if (candidateHasSchedule && !bestHasSchedule) {
              bestMatch = candidate;
            } else if (candidateHasSchedule === bestHasSchedule && candidate.similarity > bestMatch.similarity) {
              bestMatch = candidate;
            }
          }
        }
      } catch {
        // Fall back gracefully on canvas error
      }
    }
    if (bestMatch) matches.push(bestMatch);
  }
  return matches;
}

module.exports = {
  decodedImageBasename,
  embeddedUploadHash,
  popupImageIdentity,
  findDuplicatePopupImages,
  findDuplicatePopupImagesWithVision
};
