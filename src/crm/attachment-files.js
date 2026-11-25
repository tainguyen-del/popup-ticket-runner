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

const CMS_MAX_UPLOAD_BYTES = 2.8 * 1024 * 1024; // 2.8MB threshold to strictly stay below CMS 3MB limit
const TARGET_OPTIMIZED_BYTES = 2.5 * 1024 * 1024; // 2.5MB target max for compressed images

async function compressImageForUpload(page, inputPath, { maxBytes = TARGET_OPTIMIZED_BYTES, maxDimension = 2048 } = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const inputBuffer = fs.readFileSync(inputPath);
  const inputExt = path.extname(inputPath).toLowerCase();
  const inputMime = inputExt === '.png' ? 'image/png' : (inputExt === '.webp' ? 'image/webp' : 'image/jpeg');
  const base64 = inputBuffer.toString('base64');

  const result = await page.evaluate(async ({ b64, mime, maxBytesTarget, maxDim }) => {
    function load(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load image in canvas'));
        img.src = src;
      });
    }
    const img = await load(`data:${mime};base64,${b64}`);
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;

    if (width > maxDim || height > maxDim) {
      const ratio = Math.min(maxDim / width, maxDim / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    let hasAlpha = false;
    try {
      const sample = ctx.getImageData(0, 0, width, height).data;
      for (let i = 3; i < sample.length; i += 16) {
        if (sample[i] < 250) { hasAlpha = true; break; }
      }
    } catch {
      hasAlpha = false;
    }

    const targetFormat = hasAlpha ? 'image/webp' : 'image/jpeg';
    const targetExtension = hasAlpha ? 'webp' : 'jpg';

    let quality = 0.90;
    let dataUrl = canvas.toDataURL(targetFormat, quality);
    function b64Size(url) {
      return Math.round((url.length - url.indexOf(',') - 1) * 3 / 4);
    }

    while (b64Size(dataUrl) > maxBytesTarget && quality > 0.4) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL(targetFormat, quality);
    }

    while (b64Size(dataUrl) > maxBytesTarget && (width > 800 || height > 800)) {
      width = Math.round(width * 0.85);
      height = Math.round(height * 0.85);
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      dataUrl = canvas.toDataURL(targetFormat, 0.80);
    }

    return {
      base64: dataUrl.split(',')[1],
      extension: targetExtension,
      mime: targetFormat,
      width,
      height
    };
  }, { b64: base64, mime: inputMime, maxBytesTarget: maxBytes, maxDim: maxDimension });

  return result;
}

async function createVisionPreview(page, inputPath, { maxDimension = 1920 } = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const inputBuffer = fs.readFileSync(inputPath);
    const inputExt = path.extname(inputPath).toLowerCase();
    const inputMime = inputExt === '.png' ? 'image/png' : (inputExt === '.webp' ? 'image/webp' : 'image/jpeg');
    const base64 = inputBuffer.toString('base64');

    const result = await page.evaluate(async ({ b64, mime, maxDim }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `data:${mime};base64,${b64}`;
      });
      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      return {
        base64: dataUrl.split(',')[1],
        mimeType: 'image/jpeg'
      };
    }, { b64: base64, mime: inputMime, maxDim: maxDimension });

    return result;
  } catch {
    return null;
  }
}

async function stageCmsUploadImage(attachment, runDir, { page = null, progress = null } = {}) {
  if (!attachment?.path) throw new Error('The ticket poster has no local file to stage for CMS upload.');
  const original = validateDownloadedImage(attachment.path);
  const uploadDirectory = path.join(runDir, 'attachment', 'cms-upload');
  fs.mkdirSync(uploadDirectory, { recursive: true });

  const originalBytes = attachment.bytes || original.bytes;
  const rawBuffer = fs.readFileSync(attachment.path);
  const rawMime = geminiVisionMimeType(attachment.path);
  const needsRepair = Boolean(rawMime && !isImageContainerComplete(rawBuffer, rawMime));
  const needsCompression = originalBytes > CMS_MAX_UPLOAD_BYTES || needsRepair;
  let stagedPath = null;
  let detectedExtension = attachment.extension || original.extension;
  let optimized = false;

  if (needsCompression && page) {
    if (typeof progress === 'function') {
      if (needsRepair && originalBytes <= CMS_MAX_UPLOAD_BYTES) {
        progress('image-optimize', 'Ảnh tải về từ CRM bị thiếu chunk cuối; đang phục hồi định dạng sạch để upload CMS...');
      } else {
        const mb = (originalBytes / 1024 / 1024).toFixed(2);
        progress('image-optimize', `Ảnh đính kèm ${mb}MB vượt quá giới hạn 3MB của CMS. Đang tự động nén tối ưu...`);
      }
    }
    try {
      const compressed = await compressImageForUpload(page, attachment.path, { maxBytes: TARGET_OPTIMIZED_BYTES });
      if (compressed && compressed.base64) {
        detectedExtension = compressed.extension;
        const uploadFilename = cmsSafeUploadFilename(
          attachment.filename || original.filename,
          attachment.sha256 || original.sha256,
          detectedExtension
        );
        stagedPath = path.join(uploadDirectory, uploadFilename);
        fs.writeFileSync(stagedPath, Buffer.from(compressed.base64, 'base64'));
        optimized = true;
      }
    } catch {
      stagedPath = null;
    }
  }

  if (!stagedPath) {
    const uploadFilename = cmsSafeUploadFilename(
      attachment.filename || original.filename,
      attachment.sha256 || original.sha256,
      detectedExtension
    );
    stagedPath = path.join(uploadDirectory, uploadFilename);
    fs.copyFileSync(attachment.path, stagedPath);
  }

  const staged = validateDownloadedImage(stagedPath);
  if (!optimized && staged.sha256 !== original.sha256) {
    throw new Error('The CMS-safe poster copy did not match the downloaded ticket image. CMS upload was stopped.');
  }

  if (optimized && typeof progress === 'function') {
    const origMb = (original.bytes / 1024 / 1024).toFixed(2);
    const newMb = (staged.bytes / 1024 / 1024).toFixed(2);
    progress('image-optimized', `Đã nén tối ưu poster từ ${origMb}MB xuống ${newMb}MB (chất lượng 90%) để upload CMS thành công.`);
  }

  return {
    ...attachment,
    extension: staged.extension,
    bytes: staged.bytes,
    sha256: staged.sha256,
    uploadPath: stagedPath,
    uploadFilename: path.basename(stagedPath),
    optimized,
    originalBytes
  };
}

function geminiVisionMimeType(imagePath) {
  const extension = path.extname(String(imagePath || '')).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return null;
}

function isImageContainerComplete(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mimeType === 'image/png') {
    if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
    let pos = 8;
    let lastChunk = null;
    while (pos + 12 <= buffer.length) {
      const len = buffer.readUInt32BE(pos);
      if (pos + 12 + len > buffer.length) return false;
      lastChunk = buffer.subarray(pos + 4, pos + 8).toString('ascii');
      pos += 12 + len;
    }
    return lastChunk === 'IEND' && pos === buffer.length;
  }
  if (mimeType === 'image/jpeg') {
    if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) return false;
    const tailStart = Math.max(0, buffer.length - 64);
    return buffer.subarray(tailStart).includes(Buffer.from([0xff, 0xd9]));
  }
  if (mimeType === 'image/webp') {
    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return false;
    const riffSize = buffer.readUInt32LE(4);
    return riffSize > 4 && (riffSize + 8) <= buffer.length + 1;
  }
  return true;
}

async function visionCandidatesFromDownloads(downloads, attachmentCandidates, { page = null, forcePreview = false } = {}) {
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_MULTI_RAW_BYTES = 1.2 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  let totalBytes = 0;
  const warnings = [];
  const candidates = [];
  for (const download of downloads) {
    let mimeType = geminiVisionMimeType(download.path);
    if (!mimeType) {
      warnings.push(`Attachment #${download.candidateIndex} is not a PNG, JPEG, or WebP Vision input.`);
      continue;
    }
    const rawBuffer = fs.readFileSync(download.path);
    const structurallyComplete = isImageContainerComplete(rawBuffer, mimeType);
    let base64 = null;
    let candidateBytes = download.bytes;
    const shouldOptimizeMulti = Boolean(page && downloads.length > 2 && download.bytes > MAX_MULTI_RAW_BYTES);
    const exceedsLimits = download.bytes > MAX_IMAGE_BYTES || (totalBytes + download.bytes > MAX_TOTAL_BYTES);
    if (forcePreview || !structurallyComplete || shouldOptimizeMulti || exceedsLimits) {
      if (page) {
        const preview = await createVisionPreview(page, download.path);
        if (preview && preview.base64) {
          base64 = preview.base64;
          mimeType = preview.mimeType;
          candidateBytes = Math.round(base64.length * 3 / 4);
        }
      }
      if ((!base64 && (!structurallyComplete || download.bytes > MAX_IMAGE_BYTES || totalBytes + download.bytes > MAX_TOTAL_BYTES))
        || (totalBytes + candidateBytes > MAX_TOTAL_BYTES)) {
        warnings.push(
          !structurallyComplete
            ? `Attachment #${download.candidateIndex} had truncated image bytes and could not be prepared locally.`
            : `Attachment #${download.candidateIndex} was too large for the inline Vision request.`
        );
        continue;
      }
    }
    if (!base64) {
      base64 = rawBuffer.toString('base64');
    }
    totalBytes += candidateBytes;
    const context = attachmentCandidates.find((candidate) => candidate.index === download.candidateIndex) || {};
    candidates.push({
      index: download.candidateIndex,
      filename: download.filename,
      context: context.context || '',
      precedingText: context.precedingText || '',
      kind: context.kind || 'unknown',
      isRemovalReference: context.isRemovalReference === true,
      mimeType,
      base64
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
  const reference = referenceImage
    ? visionCandidateFromLocalImage(referenceImage, 0, 'Reference image from this CRM ticket.')
    : null;
  if (referenceImage && !reference) {
    return { reference: null, candidates: [], complete: false, warnings: ['The ticket reference image is not a supported PNG, JPEG, or WebP under 4 MB.'] };
  }
  let totalBytes = reference ? reference.bytes : 0;
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
  CMS_MAX_UPLOAD_BYTES,
  compressImageForUpload,
  createVisionPreview,
  imageFiles,
  validateDownloadedImage,
  cmsSafeUploadFilename,
  stageCmsUploadImage,
  geminiVisionMimeType,
  isImageContainerComplete,
  visionCandidatesFromDownloads,
  visionCandidateFromLocalImage,
  preparePopupRemovalVision
};
