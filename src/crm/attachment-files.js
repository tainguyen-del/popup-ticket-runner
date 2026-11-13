'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function imageFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...imageFiles(item));
    else if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) result.push(item);
  }
  return result;
}

function validateDownloadedImage(imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error('CRM download completed but the poster file was not saved locally.');
  const stats = fs.statSync(imagePath);
  if (!stats.isFile() || stats.size === 0) throw new Error('CRM download created an empty poster file.');
  const bytes = fs.readFileSync(imagePath);
  const header = bytes.subarray(0, 12);
  const isPng = header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isGif = header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
  const isWebp = header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isPng && !isJpeg && !isGif && !isWebp) throw new Error('Downloaded attachment is not a valid PNG, JPEG, GIF, or WebP image.');
  const extension = isPng ? 'png' : isJpeg ? 'jpg' : isGif ? 'gif' : 'webp';
  return {
    path: imagePath,
    filename: path.basename(imagePath),
    bytes: stats.size,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    extension
  };
}

function cmsSafeUploadFilename(filename, sha256, extension = null) {
  const original = path.basename(String(filename || 'popup-poster'));
  const detectedExtension = String(extension || path.extname(original).slice(1) || 'png')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const imageExtension = /^(?:png|jpe?g|gif|webp)$/.test(detectedExtension)
    ? (detectedExtension === 'jpeg' ? 'jpg' : detectedExtension)
    : 'png';
  const rawBase = path.basename(original, path.extname(original))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0110\u0111]/g, (character) => character === '\u0110' ? 'D' : 'd')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/[-_.]+$/g, '')
    .replace(/^[-_.]+/g, '')
    .toLowerCase();
  const suffix = /^[a-f0-9]{12,}$/i.test(String(sha256 || ''))
    ? String(sha256).slice(0, 12).toLowerCase()
    : crypto.createHash('sha256').update(original).digest('hex').slice(0, 12);
  const base = (rawBase || 'poster').slice(0, 90);
  return `popup-${base}-${suffix}.${imageExtension}`;
}

function stageCmsUploadImage(attachment, runDir) {
  if (!attachment?.path) throw new Error('The ticket poster has no local file to stage for CMS upload.');
  const original = validateDownloadedImage(attachment.path);
  const uploadFilename = cmsSafeUploadFilename(
    attachment.filename || original.filename,
    attachment.sha256 || original.sha256,
    attachment.extension || original.extension
  );
  const uploadDirectory = path.join(runDir, 'attachment', 'cms-upload');
  fs.mkdirSync(uploadDirectory, { recursive: true });
  const uploadPath = path.join(uploadDirectory, uploadFilename);
  fs.copyFileSync(attachment.path, uploadPath);
  const staged = validateDownloadedImage(uploadPath);
  if (staged.sha256 !== original.sha256) {
    throw new Error('The CMS-safe poster copy did not match the downloaded ticket image. CMS upload was stopped.');
  }
  return {
    ...attachment,
    extension: attachment.extension || original.extension,
    uploadPath,
    uploadFilename
  };
}

function geminiVisionMimeType(imagePath) {
  const extension = path.extname(String(imagePath || '')).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return null;
}

function visionCandidatesFromDownloads(downloads, attachmentCandidates) {
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  let totalBytes = 0;
  const warnings = [];
  const candidates = [];
  for (const download of downloads) {
    const mimeType = geminiVisionMimeType(download.path);
    if (!mimeType) {
      warnings.push(`Attachment #${download.candidateIndex} is not a PNG, JPEG, or WebP Vision input.`);
      continue;
    }
    if (download.bytes > MAX_IMAGE_BYTES || totalBytes + download.bytes > MAX_TOTAL_BYTES) {
      warnings.push(`Attachment #${download.candidateIndex} was too large for the inline Vision request.`);
      continue;
    }
    totalBytes += download.bytes;
    const context = attachmentCandidates.find((candidate) => candidate.index === download.candidateIndex) || {};
    candidates.push({
      index: download.candidateIndex,
      filename: download.filename,
      context: context.context || '',
      mimeType,
      base64: fs.readFileSync(download.path).toString('base64')
    });
  }
  return { candidates, warnings };
}

function visionCandidateFromLocalImage(image, index, context = '') {
  const imagePath = image?.path || image?.imagePath;
  const mimeType = geminiVisionMimeType(imagePath);
  if (!imagePath || !mimeType) return null;
  let bytes = Number(image?.bytes) || 0;
  if (!bytes) {
    try { bytes = fs.statSync(imagePath).size; } catch { return null; }
  }
  if (bytes <= 0 || bytes > 4 * 1024 * 1024) return null;
  return {
    index,
    filename: image?.filename || path.basename(imagePath),
    context,
    mimeType,
    base64: fs.readFileSync(imagePath).toString('base64'),
    bytes
  };
}

function preparePopupRemovalVision(referenceImage, popupImages) {
  const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  const reference = visionCandidateFromLocalImage(referenceImage, 0, 'Reference image from this CRM ticket.');
  if (!reference) {
    return { reference: null, candidates: [], complete: false, warnings: ['The ticket reference image is not a supported PNG, JPEG, or WebP under 4 MB.'] };
  }
  let totalBytes = reference.bytes;
  const candidates = [];
  const warnings = [];
  for (const image of popupImages) {
    const candidate = visionCandidateFromLocalImage(image, image.visionIndex, `CMS section ${image.sectionId}, popup item ${image.itemIndex + 1}.`);
    if (!candidate) {
      warnings.push(`CMS popup item ${image.itemIndex + 1} could not be used as a Gemini Vision image.`);
      continue;
    }
    if (totalBytes + candidate.bytes > MAX_TOTAL_BYTES) {
      warnings.push('Not every CMS popup image fit in the Gemini Vision request; no popup was guessed.');
      return { reference, candidates: [], complete: false, warnings };
    }
    totalBytes += candidate.bytes;
    candidates.push(candidate);
  }
  return { reference, candidates, complete: candidates.length === popupImages.length, warnings };
}

module.exports = {
  imageFiles,
  validateDownloadedImage,
  cmsSafeUploadFilename,
  stageCmsUploadImage,
  geminiVisionMimeType,
  visionCandidatesFromDownloads,
  visionCandidateFromLocalImage,
  preparePopupRemovalVision
};
