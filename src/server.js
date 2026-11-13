#!/usr/bin/env node
// Local-only UI server. It never exposes CRM/CMS sessions outside this computer.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { SessionManager } = require('./session-manager');
const { appDataDirectory, runDirectoryRoots } = require('./app-paths');
const { GeminiKeyStore } = require('./gemini-key-store');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const REPORT_ROOTS = runDirectoryRoots(ROOT);
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const jobs = new Map();
let activeJobId = null;
const sessionManager = new SessionManager(ROOT);
let geminiKeyStore = new GeminiKeyStore({ dataDirectory: appDataDirectory(ROOT) });

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    events: job.events,
    error: job.error || null,
    result: job.result || null
  };
}

function safePlan(plan) {
  return {
    status: plan.status,
    error: plan.error || null,
    safety: plan.safety,
    organization: plan.organization,
    ticket: plan.ticket ? {
      siteId: plan.ticket.siteId || null,
      popupRequested: Boolean(plan.ticket.popupRequested),
      popupAction: plan.ticket.popupAction || 'create',
      popupPosition: plan.ticket.popupPosition || null,
      start: plan.ticket.start || null,
      startDate: plan.ticket.startDate || null,
      expiry: plan.ticket.expiry || null,
      expiryDate: plan.ticket.expiryDate || null,
      endYearRolledOver: Boolean(plan.ticket.endYearRolledOver),
      scheduleEvidence: plan.ticket.scheduleEvidence || null,
      attachmentAvailable: Boolean(plan.ticket.attachmentAvailable),
      attachmentCount: Number(plan.ticket.attachmentCount) || 0,
      popupAttachmentIndex: Number(plan.ticket.popupAttachmentIndex) || null,
      popupAttachmentIndexes: Array.isArray(plan.ticket.popupAttachmentIndexes)
        ? plan.ticket.popupAttachmentIndexes.map(Number).filter((index) => Number.isInteger(index) && index > 0)
        : [],
      popupAttachmentSelection: plan.ticket.popupAttachmentSelection || null,
      popupItems: Array.isArray(plan.ticket.popupItems) ? plan.ticket.popupItems.map((item) => ({
        attachmentIndex: Number(item.attachmentIndex) || null,
        filename: item.filename || null,
        startDate: item.startDate || null,
        expiryDate: item.expiryDate || null
      })) : [],
      removalScope: plan.ticket.removalScope || null
    } : null,
    attachmentPlan: plan.attachmentPlan ? {
      mode: plan.attachmentPlan.mode || null,
      required: Boolean(plan.attachmentPlan.required),
      ready: Boolean(plan.attachmentPlan.ready),
      attachmentCount: Number(plan.attachmentPlan.attachmentCount) || 0,
      selectedIndex: Number(plan.attachmentPlan.selectedIndex) || null,
      selectedIndexes: Array.isArray(plan.attachmentPlan.selectedIndexes)
        ? plan.attachmentPlan.selectedIndexes.map(Number).filter((index) => Number.isInteger(index) && index > 0)
        : [],
      reason: plan.attachmentPlan.reason || null
    } : null,
    semantic: plan.semantic ? {
      provider: plan.semantic.provider || null,
      model: plan.semantic.model || null,
      status: plan.semantic.status || null,
      appliedFields: Array.isArray(plan.semantic.appliedFields) ? plan.semantic.appliedFields : [],
      warnings: Array.isArray(plan.semantic.warnings) ? plan.semantic.warnings.slice(0, 4) : []
    } : null,
    vision: plan.vision ? {
      provider: plan.vision.provider || null,
      model: plan.vision.model || null,
      status: plan.vision.status || null,
      rationale: plan.vision.rationale || null,
      warnings: Array.isArray(plan.vision.warnings) ? plan.vision.warnings.slice(0, 4) : []
    } : null,
    removalVision: plan.removalVision ? {
      provider: plan.removalVision.provider || null,
      model: plan.removalVision.model || null,
      status: plan.removalVision.status || null,
      rationale: plan.removalVision.rationale || null,
      warnings: Array.isArray(plan.removalVision.warnings) ? plan.removalVision.warnings.slice(0, 4) : []
    } : null,
    attachment: plan.attachment ? {
      filename: plan.attachment.filename || null,
      cmsUploadFilename: plan.attachment.cmsUploadFilename || null,
      bytes: Number(plan.attachment.bytes) || null,
      sha256: plan.attachment.sha256 || null,
      source: plan.attachment.source || null,
      candidateIndex: Number(plan.attachment.candidateIndex) || null
    } : null,
    attachments: Array.isArray(plan.attachments) ? plan.attachments.map((attachment) => ({
      filename: attachment.filename || null,
      cmsUploadFilename: attachment.cmsUploadFilename || null,
      bytes: Number(attachment.bytes) || null,
      sha256: attachment.sha256 || null,
      source: attachment.source || null,
      candidateIndex: Number(attachment.candidateIndex) || null
    })) : [],
    duplicateImage: plan.duplicateImage ? {
      ticketFilename: plan.duplicateImage.ticketFilename || null,
      cmsImageUrl: plan.duplicateImage.cmsImageUrl || null,
      method: plan.duplicateImage.method || null
    } : null,
    cms: plan.cms ? {
      siteId: plan.cms.siteId || null,
      found: Boolean(plan.cms.found),
      candidateCount: Number(plan.cms.candidateCount) || 0,
      selectedDomain: plan.cms.selectedDomain || null,
      selectionMethod: plan.cms.selectionMethod || null,
      ambiguous: Boolean(plan.cms.ambiguous)
    } : null,
    plugin: plan.plugin ? {
      state: plan.plugin.state || null,
      version: plan.plugin.version || null,
      enabled: Boolean(plan.plugin.enabled),
      updateAvailable: Boolean(plan.plugin.updateAvailable),
      updated: Boolean(plan.plugin.updated)
    } : null,
    popupSection: plan.popupSection ? {
      exists: Boolean(plan.popupSection.exists),
      sectionId: plan.popupSection.sectionId || null,
      checked: Boolean(plan.popupSection.checked),
      created: Boolean(plan.popupSection.created),
      replaced: Boolean(plan.popupSection.replaced),
      removedCount: Number(plan.popupSection.removedCount) || 0
    } : null,
    legacyPopups: plan.legacyPopups ? {
      sectionCount: Number(plan.legacyPopups.sectionCount) || 0,
      preservedCount: Number(plan.legacyPopups.preservedCount) || 0,
      expiredCount: Number(plan.legacyPopups.expiredCount) || 0
    } : null,
    legacyRecovery: plan.legacyRecovery ? {
      resumed: Boolean(plan.legacyRecovery.resumed),
      preservedCount: Number(plan.legacyRecovery.preservedCount) || 0
    } : null,
    popup: plan.popup ? {
      imageConfigured: Boolean(plan.popup.imageConfigured),
      ticketPosterVerified: Boolean(plan.popup.ticketPosterVerified),
      ticketPosterCount: Number(plan.popup.ticketPosterCount) || 0,
      popupPosition: plan.popup.popupPosition || null,
      positionMoved: Boolean(plan.popup.positionMoved),
      ticketItems: Array.isArray(plan.popup.ticketItems) ? plan.popup.ticketItems.map((item) => ({
        attachmentIndex: Number(item.attachmentIndex) || null,
        imageUrl: item.imageUrl || null,
        start: item.start || null,
        end: item.end || null
      })) : [],
      start: plan.popup.start || null,
      expiry: plan.popup.expiry || null,
      timezone: plan.popup.timezone || null,
      timezoneControl: plan.popup.timezoneControl ? {
        applied: Boolean(plan.popup.timezoneControl.applied),
        supported: Boolean(plan.popup.timezoneControl.supported)
      } : null,
      replaced: Boolean(plan.popup.replaced),
      migratedLegacyPopups: Number(plan.popup.migratedLegacyPopups) || 0,
      ticketMergedWithLegacy: Boolean(plan.popup.ticketMergedWithLegacy),
      repaired: Boolean(plan.popup.repaired),
      removedEmptyItems: Number(plan.popup.removedEmptyItems) || 0,
      clearedStart: Boolean(plan.popup.clearedStart),
      deduplicated: Boolean(plan.popup.deduplicated),
      deduplicationMethod: plan.popup.deduplicationMethod || null,
      cmsImageUrl: plan.popup.cmsImageUrl || null,
      cmsImageUrls: Array.isArray(plan.popup.cmsImageUrls) ? plan.popup.cmsImageUrls.filter(Boolean) : [],
      published: Boolean(plan.popup.published)
    } : null,
    popupRemoval: plan.popupRemoval ? {
      scope: plan.popupRemoval.scope || null,
      changed: Boolean(plan.popupRemoval.changed),
      removedCount: Number(plan.popupRemoval.removedCount) || 0,
      sectionCount: Number(plan.popupRemoval.sectionCount) || 0,
      sectionId: plan.popupRemoval.sectionId || null,
      itemIndex: Number.isInteger(plan.popupRemoval.itemIndex) ? plan.popupRemoval.itemIndex : null,
      imageUrl: plan.popupRemoval.imageUrl || null,
      visionRationale: plan.popupRemoval.visionRationale || null,
      warnings: Array.isArray(plan.popupRemoval.warnings) ? plan.popupRemoval.warnings.slice(0, 4) : []
    } : null,
    build: plan.build ? {
      status: plan.build.status || null,
      evidence: plan.build.evidence || null,
      completedAt: plan.build.completedAt || null
    } : null,
    website: plan.website ? {
      liveUrl: plan.website.liveUrl || null,
      previewUrl: plan.website.previewUrl || null
    } : null,
    timezone: plan.timezone ? {
      iana: plan.timezone.iana || null,
      cmsLabel: plan.timezone.cmsLabel || null,
      source: plan.timezone.source || null
    } : null,
    nextAction: plan.nextAction || null
  };
}

function addEvent(job, stage, message, details = {}) {
  job.events.push({ stage, message, details, at: new Date().toISOString() });
}

function validTicketUrl(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.hostname === 'crm.fastboy.dev' && /^\/tickets\/detail\/\d+\/?$/.test(parsed.pathname)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function validExpiry(raw) {
  if (raw === undefined || raw === null || raw === '') return { valid: true, value: null };
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { valid: false, value: null };
  const date = new Date(`${raw}T00:00:00.000Z`);
  const isCalendarDate = !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === raw;
  return { valid: isCalendarDate, value: isCalendarDate ? raw : null };
}

function processOutputLine(job, line) {
  const progressPrefix = 'PROGRESS ';
  if (line.startsWith(progressPrefix)) {
    try {
      const event = JSON.parse(line.slice(progressPrefix.length));
      addEvent(job, event.stage || 'working', event.message || 'Đang xử lý', { siteId: event.siteId, status: event.status, websiteUrl: event.websiteUrl });
    } catch { /* ignore malformed diagnostic output */ }
    return;
  }
  const resultMatch = /^Result:\s+(.+plan\.json)$/i.exec(line);
  if (resultMatch) {
    const candidate = path.resolve(resultMatch[1]);
    if (REPORT_ROOTS.some((root) => candidate.startsWith(`${root}${path.sep}`))) job.planPath = candidate;
  }
}

function launchJob(ticketUrl, applyChanges = false, expiryOverride = null, buildRequested = false, downloadPoster = false) {
  const job = {
    id: crypto.randomUUID(),
    state: 'running',
    mode: applyChanges ? (buildRequested ? 'apply-build' : 'apply') : (downloadPoster ? 'scan-download' : 'scan'),
    createdAt: new Date().toISOString(),
    events: [],
    result: null,
    error: null,
    planPath: null
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  addEvent(job, 'queued', 'Đã nhận link ticket');

  // Let the operator see CRM and CMS actions in a separate app-owned Chrome
  // window. Headless execution remains available only as an explicit opt-out.
  const args = [path.join(ROOT, 'src', 'run.js'), '--ticket-url', ticketUrl];
  if (process.env.POPUP_TICKET_RUNNER_HEADLESS !== '1') args.push('--headed');
  if (applyChanges) args.push('--apply');
  if (downloadPoster) args.push('--download-poster');
  if (buildRequested) args.push('--build');
  if (expiryOverride) args.push('--expiry', expiryOverride);
  const runnerCwd = appDataDirectory(ROOT);
  fs.mkdirSync(runnerCwd, { recursive: true });
  const runnerEnv = { ...process.env };
  const geminiApiKey = geminiKeyStore.getKey();
  if (geminiApiKey) {
    runnerEnv.GEMINI_API_KEY = geminiApiKey;
    runnerEnv.POPUP_TICKET_RUNNER_GEMINI_KEY = geminiApiKey;
  }
  if (process.versions.electron) runnerEnv.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(process.execPath, args, {
    cwd: runnerCwd,
    shell: false,
    windowsHide: true,
    env: runnerEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdoutBuffer = '';
  let stderrBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    lines.forEach((line) => processOutputLine(job, line));
  });
  child.stderr.on('data', (chunk) => {
    job.hadStderr = true;
    // Keep only a short diagnostic fallback. The normal, structured report
    // remains plan.json; this is used only if the child dies before it exists.
    stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-4000);
  });
  const timeout = setTimeout(() => {
    if (job.state === 'running') {
      job.state = 'failed';
      job.error = 'Tool mất quá lâu để hoàn tất. Đóng Chrome profile của tool rồi thử lại.';
      addEvent(job, 'failed', job.error);
      child.kill();
    }
  }, 900000);
  child.on('error', () => {
    clearTimeout(timeout);
    job.state = 'failed';
    job.error = 'Không thể khởi động tool.';
    addEvent(job, 'failed', job.error);
    activeJobId = null;
  });
  child.on('close', () => {
    clearTimeout(timeout);
    if (stdoutBuffer) processOutputLine(job, stdoutBuffer);
    if (job.planPath && fs.existsSync(job.planPath)) {
      try {
        job.result = safePlan(JSON.parse(fs.readFileSync(job.planPath, 'utf8')));
        if (['ticket-not-loaded', 'browser-offline', 'login-required'].includes(job.result.status)) {
          sessionManager.requireLogin('Phiên CRM hoặc CMS đã hết hạn. Hãy đăng nhập lại trước khi chạy ticket tiếp theo.');
        }
        job.state = job.result.status?.startsWith('ready-') || ['awaiting-build-approval', 'popup-live', 'popup-removed', 'popup-removal-noop', 'popup-removal-awaiting-build'].includes(job.result.status) ? 'complete' : 'needs-attention';
        addEvent(job, job.state === 'complete' ? 'complete' : 'attention', job.result.nextAction || `Hoàn tất: ${job.result.status}`);
      } catch {
        job.state = 'failed';
        job.error = 'Không thể đọc báo cáo sau khi tool chạy.';
        addEvent(job, 'failed', job.error);
      }
    } else if (job.state !== 'failed') {
      job.state = 'failed';
      job.error = /ProcessSingleton|profile directory.*(?:in use|lock)|Lock file.*access is denied/i.test(stderrBuffer)
        ? 'Chrome profile của tool đang được một cửa sổ Chrome khác sử dụng. Đóng cửa sổ Chrome của tool, chờ vài giây rồi chạy lại. CMS chưa thay đổi.'
        : 'Tool kết thúc nhưng không tạo được báo cáo. Hãy thử lại; lần chạy tiếp theo sẽ lưu báo cáo lỗi chi tiết.';
      addEvent(job, 'failed', job.error);
    }
    activeJobId = null;
  });
  return job;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(new Error('Payload too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function serveAsset(request, response) {
  const requested = request.url === '/' ? 'index.html' : request.url.slice(1);
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) return json(response, 403, { error: 'Forbidden' });
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  fs.readFile(file, (error, data) => {
    if (error) return json(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, session: sessionManager.snapshot() });
  if (request.method === 'GET' && url.pathname === '/api/gemini') return json(response, 200, geminiKeyStore.status());
  if (request.method === 'POST' && url.pathname === '/api/gemini') {
    if (activeJobId) return json(response, 409, { error: 'Một ticket đang chạy. Hãy chờ hoàn tất trước khi đổi cấu hình Gemini.' });
    try {
      const payload = JSON.parse(await readBody(request));
      if (typeof payload.apiKey !== 'string') return json(response, 400, { error: 'Hãy nhập Gemini API key hợp lệ.' });
      return json(response, 200, geminiKeyStore.saveKey(payload.apiKey));
    } catch (error) {
      const status = ['gemini-key-invalid', 'gemini-secure-storage-unavailable'].includes(error?.code) ? 422 : 400;
      return json(response, status, { error: error?.message || 'Không thể lưu Gemini API key.' });
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, sessionManager.snapshot());
  if (request.method === 'POST' && url.pathname === '/api/session/login') {
    if (activeJobId) return json(response, 409, { error: 'Một ticket đang chạy. Hãy chờ hoàn tất trước khi đăng nhập lại.' });
    const session = await sessionManager.openLogin({ fresh: url.searchParams.get('fresh') === '1' });
    return json(response, session.error ? 500 : 202, session);
  }
  if (request.method === 'POST' && url.pathname === '/api/session/check') {
    if (activeJobId) return json(response, 409, { error: 'Một ticket đang chạy. Hãy chờ hoàn tất trước khi kiểm tra đăng nhập.' });
    const session = await sessionManager.verifyLogin();
    return json(response, session.ready ? 200 : 422, session);
  }
  if (request.method === 'POST' && url.pathname === '/api/session/cancel') {
    const session = await sessionManager.cancelLogin();
    return json(response, 200, session);
  }
  if (request.method === 'GET' && /^\/api\/jobs\/[0-9a-f-]+$/i.test(url.pathname)) {
    const job = jobs.get(url.pathname.split('/').pop());
    return job ? json(response, 200, publicJob(job)) : json(response, 404, { error: 'Job not found' });
  }
  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    if (!sessionManager.snapshot().ready) return json(response, 409, { error: 'Hãy đăng nhập và xác nhận cả CRM lẫn CMS trước khi chạy ticket.' });
    if (!geminiKeyStore.status().configured) return json(response, 409, { error: 'Hãy cấu hình Gemini API key trước khi chạy ticket.' });
    if (activeJobId) return json(response, 409, { error: 'Một ticket đang chạy. Hãy chờ hoàn tất trước khi chạy ticket khác.' });
    try {
      const payload = JSON.parse(await readBody(request));
      const ticketUrl = validTicketUrl(payload.ticketUrl);
      if (!ticketUrl) return json(response, 400, { error: 'Hãy nhập link ticket hợp lệ từ crm.fastboy.dev.' });
      if (payload.apply !== undefined && typeof payload.apply !== 'boolean') return json(response, 400, { error: 'Chế độ thay đổi CMS không hợp lệ.' });
      if (payload.build !== undefined && typeof payload.build !== 'boolean') return json(response, 400, { error: 'Chế độ Build không hợp lệ.' });
      if (payload.downloadPoster !== undefined && typeof payload.downloadPoster !== 'boolean') return json(response, 400, { error: 'Chế độ tải poster không hợp lệ.' });
      if (payload.build === true && payload.apply !== true) return json(response, 400, { error: 'Build chỉ được chạy cùng chế độ thay đổi CMS.' });
      const expiry = validExpiry(payload.expiry);
      if (!expiry.valid) return json(response, 400, { error: 'Ngày hết hạn cần có dạng YYYY-MM-DD.' });
      const job = launchJob(ticketUrl, payload.apply === true, expiry.value, payload.build === true, payload.downloadPoster === true);
      return json(response, 202, { id: job.id });
    } catch {
      return json(response, 400, { error: 'Dữ liệu gửi lên không hợp lệ.' });
    }
  }
  if (request.method === 'GET') return serveAsset(request, response);
  return json(response, 405, { error: 'Method not allowed' });
});

function startServer({ port = PORT, host = HOST, restoreSession = true, geminiKeyStore: configuredGeminiKeyStore = null } = {}) {
  if (configuredGeminiKeyStore) geminiKeyStore = configuredGeminiKeyStore;
  if (server.listening) {
    const address = server.address();
    return Promise.resolve({ server, host, port: typeof address === 'object' ? address.port : port });
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort = typeof address === 'object' ? address.port : port;
      console.log(`Popup Ticket Runner UI: http://${host}:${actualPort}`);
      // Opening the local page never touches Chrome. The explicit login
      // button is the only action that creates or restores the isolated
      // CRM/CMS Chrome window, so the operator can choose when to see it.
      // Restore a previously verified session in the background. The UI
      // remains responsive, and an explicit login click supersedes this
      // probe immediately if the operator wants to see the two tabs.
      if (restoreSession) void sessionManager.restoreStoredSession().catch(() => {});
      resolve({ server, host, port: actualPort });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function stopServer({ closeSession = true } = {}) {
  if (closeSession) await sessionManager.cancelLogin();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Server failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { startServer, stopServer, sessionManager };
