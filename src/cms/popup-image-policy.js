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

const VISUAL_PIXEL_CANVAS_SIZE = 64;
const VISUAL_STRONG_SIMILARITY = 0.96;
const VISUAL_STRONG_PEARSON = 0.96;
const VISUAL_STRONG_CHANGED_RATIO = 0.04;
const VISUAL_CANDIDATE_SIMILARITY = 0.86;
const VISUAL_CANDIDATE_PEARSON = 0.84;
const VISUAL_CANDIDATE_CHANGED_RATIO = 0.22;
const VISUAL_STRICT_SIMILARITY = 0.90;
const VISUAL_STRICT_PEARSON = 0.90;
const VISUAL_STRICT_CHANGED_RATIO = 0.14;

function normalizeVisualMetrics(raw) {
  if (typeof raw === 'number') {
    const score = Number.isFinite(raw) ? raw : 0;
    return {
      pixelSimilarity: score,
      pearson: score,
      changedRatio: Math.max(0, 1 - score)
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { pixelSimilarity: 0, pearson: 0, changedRatio: 1 };
  }
  const pixelSimilarity = Number.isFinite(raw.pixelSimilarity) ? raw.pixelSimilarity : 0;
  const pearson = Number.isFinite(raw.pearson) ? raw.pearson : pixelSimilarity;
  const changedRatio = Number.isFinite(raw.changedRatio) ? raw.changedRatio : Math.max(0, 1 - pixelSimilarity);
  return { pixelSimilarity, pearson, changedRatio };
}

function classifyVisualSimilarity(metrics, hasConfirmCallback = false) {
  const { pixelSimilarity, pearson, changedRatio } = normalizeVisualMetrics(metrics);
  if (
    pixelSimilarity >= VISUAL_STRONG_SIMILARITY
    && pearson >= VISUAL_STRONG_PEARSON
    && changedRatio <= VISUAL_STRONG_CHANGED_RATIO
  ) {
    return { eligible: true, needsConfirmation: false, metrics: { pixelSimilarity, pearson, changedRatio } };
  }
  if (hasConfirmCallback) {
    const eligible = pixelSimilarity >= VISUAL_CANDIDATE_SIMILARITY
      && pearson >= VISUAL_CANDIDATE_PEARSON
      && changedRatio <= VISUAL_CANDIDATE_CHANGED_RATIO;
    return { eligible, needsConfirmation: eligible, metrics: { pixelSimilarity, pearson, changedRatio } };
  }
  const eligible = pixelSimilarity >= VISUAL_STRICT_SIMILARITY
    && pearson >= VISUAL_STRICT_PEARSON
    && changedRatio <= VISUAL_STRICT_CHANGED_RATIO;
  return { eligible, needsConfirmation: false, metrics: { pixelSimilarity, pearson, changedRatio } };
}

function preferVisualCandidate(candidate, currentBest) {
  if (!currentBest) return candidate;
  const candidateHasSchedule = !!(candidate.cms?.end || candidate.cms?.start);
  const bestHasSchedule = !!(currentBest.cms?.end || currentBest.cms?.start);
  if (candidateHasSchedule && !bestHasSchedule) return candidate;
  if (candidateHasSchedule === bestHasSchedule && candidate.similarity > currentBest.similarity) return candidate;
  return currentBest;
}

async function findDuplicatePopupImagesWithVision(page, ticketImages, cmsImages, {
  confirmVisualMatch = null,
  allowCrossAspectRatioConfirmation = false
} = {}) {
  const directMatches = findDuplicatePopupImages(ticketImages, cmsImages);
  if (directMatches.length) return directMatches;

  if (!page || !Array.isArray(ticketImages) || !Array.isArray(cmsImages)) return [];

  const hasConfirmCallback = typeof confirmVisualMatch === 'function';
  const matches = [];
  for (let ticketIndex = 0; ticketIndex < ticketImages.length; ticketIndex += 1) {
    const ticket = ticketImages[ticketIndex];
    const ticketPath = ticket?.uploadPath || ticket?.path || ticket?.imagePath;
    if (!ticketPath || !fs.existsSync(ticketPath)) continue;
    const ticketBase64 = fs.readFileSync(ticketPath).toString('base64');
    const ticketMime = ticketPath.endsWith('.png') ? 'image/png' : (ticketPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg');

    const candidates = [];
    const crossAspectCandidates = [];
    for (let cmsIndex = 0; cmsIndex < cmsImages.length; cmsIndex += 1) {
      const cms = cmsImages[cmsIndex];
      const cmsPath = cms?.imagePath || cms?.path || cms?.uploadPath;
      if (!cmsPath || !fs.existsSync(cmsPath)) continue;
      const cmsBase64 = fs.readFileSync(cmsPath).toString('base64');
      const cmsMime = cmsPath.endsWith('.png') ? 'image/png' : (cmsPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg');

      try {
        const rawMetrics = await page.evaluate(async ({ tData, tMime, cData, cMime, size, computeCrossAspect }) => {
          function load(data, mime) {
            return new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = reject;
              img.src = `data:${mime};base64,${data}`;
            });
          }
          function computeMetrics(d1, d2) {
            const pixelCount = d1.length / 4;
            const channelCount = pixelCount * 3;
            let diff = 0;
            let changedPixels = 0;
            let sum1 = 0;
            let sum2 = 0;
            for (let i = 0; i < d1.length; i += 4) {
              const dr = Math.abs(d1[i] - d2[i]);
              const dg = Math.abs(d1[i + 1] - d2[i + 1]);
              const db = Math.abs(d1[i + 2] - d2[i + 2]);
              const pixelDiff = dr + dg + db;
              diff += pixelDiff;
              if (pixelDiff > 60) changedPixels += 1;
              sum1 += d1[i] + d1[i + 1] + d1[i + 2];
              sum2 += d2[i] + d2[i + 1] + d2[i + 2];
            }
            const mean1 = sum1 / channelCount;
            const mean2 = sum2 / channelCount;
            let cov = 0;
            let var1 = 0;
            let var2 = 0;
            for (let i = 0; i < d1.length; i += 4) {
              for (let c = 0; c < 3; c += 1) {
                const a = d1[i + c] - mean1;
                const b = d2[i + c] - mean2;
                cov += a * b;
                var1 += a * a;
                var2 += b * b;
              }
            }
            const pixelSimilarity = 1 - (diff / (pixelCount * 255 * 3));
            const changedRatio = changedPixels / pixelCount;
            const denom = Math.sqrt(var1 * var2);
            const pearson = denom > 1e-6 ? (cov / denom) : (pixelSimilarity >= 0.99 ? 1 : 0);
            return { pixelSimilarity, pearson, changedRatio };
          }

          const [img1, img2] = await Promise.all([load(tData, tMime), load(cData, cMime)]);
          const ratio1 = img1.width / img1.height;
          const ratio2 = img2.width / img2.height;
          const ratioDiff = Math.abs(ratio1 - ratio2);
          if (ratioDiff > 0.15) {
            if (!computeCrossAspect) return { pixelSimilarity: 0, pearson: 0, changedRatio: 1, aspectMismatch: true };
            // Center-crop both to the overlapping aspect ratio to rank resized variants for Vision confirmation.
            const targetRatio = (ratio1 + ratio2) / 2;
            const drawCropped = (img) => {
              const r = img.width / img.height;
              let sx = 0; let sy = 0; let sw = img.width; let sh = img.height;
              if (r > targetRatio) {
                sw = img.height * targetRatio;
                sx = (img.width - sw) / 2;
              } else {
                sh = img.width / targetRatio;
                sy = (img.height - sh) / 2;
              }
              const canvas = document.createElement('canvas');
              canvas.width = size; canvas.height = size;
              canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
              return canvas.getContext('2d').getImageData(0, 0, size, size).data;
            };
            const cropped = computeMetrics(drawCropped(img1), drawCropped(img2));
            return { ...cropped, aspectMismatch: true };
          }

          const canvas1 = document.createElement('canvas');
          canvas1.width = size; canvas1.height = size;
          canvas1.getContext('2d').drawImage(img1, 0, 0, size, size);
          const d1 = canvas1.getContext('2d').getImageData(0, 0, size, size).data;

          const canvas2 = document.createElement('canvas');
          canvas2.width = size; canvas2.height = size;
          canvas2.getContext('2d').drawImage(img2, 0, 0, size, size);
          const d2 = canvas2.getContext('2d').getImageData(0, 0, size, size).data;

          return computeMetrics(d1, d2);
        }, {
          tData: ticketBase64,
          tMime: ticketMime,
          cData: cmsBase64,
          cMime: cmsMime,
          size: VISUAL_PIXEL_CANVAS_SIZE,
          computeCrossAspect: Boolean(allowCrossAspectRatioConfirmation && hasConfirmCallback)
        });

        if (rawMetrics?.aspectMismatch) {
          if (allowCrossAspectRatioConfirmation && hasConfirmCallback) {
            const normalized = normalizeVisualMetrics(rawMetrics);
            crossAspectCandidates.push({
              ticketIndex,
              cmsIndex,
              method: 'cross-aspect-visual-match',
              similarity: normalized.pixelSimilarity,
              pearson: normalized.pearson,
              changedRatio: normalized.changedRatio,
              needsConfirmation: true,
              ticket,
              cms,
              ticketBase64,
              ticketMime,
              cmsBase64,
              cmsMime
            });
          }
          continue;
        }

        const classified = classifyVisualSimilarity(rawMetrics, hasConfirmCallback);
        if (classified.eligible) {
          candidates.push({
            ticketIndex,
            cmsIndex,
            method: 'visual-similarity',
            similarity: classified.metrics.pixelSimilarity,
            pearson: classified.metrics.pearson,
            changedRatio: classified.metrics.changedRatio,
            needsConfirmation: classified.needsConfirmation,
            ticket,
            cms,
            ticketBase64,
            ticketMime,
            cmsBase64,
            cmsMime
          });
        }
      } catch {
        // Fall back gracefully on canvas error
      }
    }

    let bestMatch = null;
    candidates.sort((a, b) => {
      const aHas = !!(a.cms?.end || a.cms?.start);
      const bHas = !!(b.cms?.end || b.cms?.start);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return b.similarity - a.similarity;
    });

    for (const candidate of candidates) {
      if (!candidate.needsConfirmation || !hasConfirmCallback) {
        bestMatch = preferVisualCandidate(candidate, bestMatch);
        break;
      }
      const verdict = await confirmVisualMatch(candidate).catch(() => null);
      if (verdict?.confirmed === true) {
        bestMatch = preferVisualCandidate(candidate, bestMatch);
        break;
      }
      if (verdict?.confirmed === false) {
        continue;
      }
      // If Gemini Vision was unavailable or uncertain, only accept with strict canvas thresholds.
      if (
        candidate.similarity >= VISUAL_STRICT_SIMILARITY
        && candidate.pearson >= VISUAL_STRICT_PEARSON
        && candidate.changedRatio <= VISUAL_STRICT_CHANGED_RATIO
      ) {
        bestMatch = preferVisualCandidate(candidate, bestMatch);
        break;
      }
    }

    if (!bestMatch && allowCrossAspectRatioConfirmation && hasConfirmCallback && crossAspectCandidates.length > 0) {
      crossAspectCandidates.sort((a, b) => (b.pearson + b.similarity) - (a.pearson + a.similarity));
      const confirmedCrossAspect = [];
      for (const candidate of crossAspectCandidates.slice(0, 6)) {
        const verdict = await confirmVisualMatch(candidate).catch(() => null);
        if (verdict?.confirmed === true) {
          confirmedCrossAspect.push(candidate);
        }
      }
      if (confirmedCrossAspect.length === 1) {
        bestMatch = confirmedCrossAspect[0];
      }
    }

    if (bestMatch) {
      const { ticketBase64: _tb, ticketMime: _tm, cmsBase64: _cb, cmsMime: _cm, ...publicMatch } = bestMatch;
      matches.push(publicMatch);
    }
  }
  return matches;
}

module.exports = {
  decodedImageBasename,
  embeddedUploadHash,
  popupImageIdentity,
  normalizeVisualMetrics,
  classifyVisualSimilarity,
  findDuplicatePopupImages,
  findDuplicatePopupImagesWithVision
};
