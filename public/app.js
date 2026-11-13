const form = document.querySelector('#ticket-form');
const ticketCard = document.querySelector('#ticket-card');
const input = document.querySelector('#ticket-url');
const button = document.querySelector('#run-button');
const loginOpen = document.querySelector('#login-open');
const loginCheck = document.querySelector('#login-check');
const loginMessage = document.querySelector('#login-message');
const sessionBadge = document.querySelector('#session-badge');
const geminiForm = document.querySelector('#gemini-form');
const geminiInput = document.querySelector('#gemini-key');
const geminiSave = document.querySelector('#gemini-save');
const geminiMessage = document.querySelector('#gemini-message');
const geminiBadge = document.querySelector('#gemini-badge');
const message = document.querySelector('#form-message');
const timeline = document.querySelector('#timeline');
const badge = document.querySelector('#status-badge');
const panel = document.querySelector('#result-panel');
const resultList = document.querySelector('#result-list');
const nextAction = document.querySelector('#next-action');
const resultHeading = document.querySelector('#result-heading');
const resultSummary = document.querySelector('#result-summary');
const storedJobKey = 'popup-ticket-runner:last-job';
let sessionState = null;
let geminiState = null;
let sessionRefreshTimer = null;
// A fresh local launch should immediately show the two isolated login tabs.
// Keep the one-shot marker in the browser tab so a refresh never opens an
// endless sequence of Chrome windows; the visible button remains available
// for a deliberate retry.
let autoLoginAttempted = sessionStorage.getItem('popup-ticket-runner:auto-login-attempted') === '1';

const stages = [
  ['queued', 'Đã nhận link ticket'],
  ['starting', 'Mở Chrome profile của tool'],
  ['crm', 'Đọc ticket CRM'],
  ['crm-loaded', 'Phân tích nội dung ticket'],
  ['ticket-semantics', 'Gemini đang đọc ngữ nghĩa ticket'],
  ['attachment-comment-scan', 'Quét ảnh trong ticket và comment'],
  ['attachment-vision-download', 'Tải ảnh cục bộ để Gemini Vision kiểm tra'],
  ['ticket-vision', 'Gemini Vision đang xác minh poster'],
  ['attachment-selection-failed', 'Không xác định được đầy đủ poster — CMS chưa thay đổi'],
  ['site-id', 'Nhận diện Website ID'],
  ['attachment-download', 'Tải poster từ ticket'],
  ['attachment-inline-download', 'Tải ảnh nhúng trong ticket về máy'],
  ['attachment-thumbnail', 'Chờ thumbnail poster'],
  ['attachment-hover', 'Hover thumbnail poster'],
  ['attachment-click', 'Bấm Download file'],
  ['attachment-archive-fallback', 'Tải toàn bộ attachment dự phòng'],
  ['attachment-downloaded', 'Đã tải và xác minh poster'],
  ['attachments-downloaded', 'Đã tải và xác minh toàn bộ poster'],
  ['attachment-upload-staged', 'Đã tạo bản poster tên an toàn cho CMS'],
  ['attachment-download-failed', 'Không tải được poster — CMS chưa thay đổi'],
  ['cms', 'Mở NewZenSite'],
  ['organization', 'Mở Organization fastboy'],
  ['project-search', 'Tìm project theo Website ID'],
  ['project-open', 'Mở project CMS'],
  ['plugin-check', 'Kiểm tra Announcement plugin'],
  ['timezone-check', 'Đọc địa chỉ và xác định timezone'],
  ['section-version-check', 'Kiểm tra phiên bản Announcement section'],
  ['legacy-popup-snapshot', 'Sao lưu popup cũ còn hạn trước khi thay section'],
  ['popup-image-check', 'Kiểm tra poster có bị trùng với popup hiện có'],
  ['popup-image-duplicate-failed', 'Ảnh popup bị trùng — tool không thêm lại và không Build'],
  ['plugin-apply', 'Cài/cập nhật/kích hoạt Announcement'],
  ['plugin-apply-failed', 'Không thể cập nhật Announcement — CMS đã dừng'],
  ['section-apply', 'Thay Announcement section cũ bằng section plugin mới khi cần'],
  ['section-apply-failed', 'Không thể tạo Popup section — CMS đã dừng'],
  ['popup-settings', 'Upload poster và cấu hình Popup settings'],
  ['popup-settings-failed', 'Không thể cấu hình Popup settings — CMS đã dừng'],
  ['popup-position', 'Sắp xếp poster theo vị trí được yêu cầu trong ticket'],
  ['popup-position-verification-failed', 'Không xác minh được vị trí poster — Build chưa chạy'],
  ['popup-removal-all', 'Gỡ toàn bộ popup hiện có theo ticket'],
  ['popup-removal-scan', 'Tải popup CMS để đối chiếu ảnh'],
  ['popup-removal-vision', 'Gemini Vision đang đối chiếu ảnh popup cần gỡ'],
  ['popup-removal-apply', 'Gỡ popup đã được Gemini xác nhận'],
  ['popup-removal-ambiguous-failed', 'Không xác định duy nhất popup cần gỡ — CMS chưa thay đổi'],
  ['popup-removal-not-found-failed', 'Không tìm thấy popup có ảnh trùng để gỡ — CMS chưa thay đổi'],
  ['popup-removal-verification-failed', 'Không xác minh được danh sách popup sau khi gỡ — Build chưa chạy'],
  ['build-start', 'Bắt đầu Build website'],
  ['build-save-all', 'Save all thay đổi trước khi Build'],
  ['build-confirm', 'Xác nhận Build'],
  ['build-wait', 'Chờ CMS Build hoàn tất'],
  ['build-progress', 'CMS đang Build'],
  ['build-complete', 'Popup đã lên website'],
  ['complete', 'Hoàn tất']
];

function setBadge(label, kind) {
  badge.textContent = label;
  badge.className = `status-badge status-${kind}`;
}

function setLoginMessage(text = '', isError = false) {
  loginMessage.textContent = text;
  loginMessage.className = `form-message${isError ? ' is-error' : ''}`;
}

function updateTicketGate() {
  ticketCard.hidden = !(sessionState?.ready && geminiState?.configured);
}

function setGeminiMessage(text = '', isError = false) {
  geminiMessage.textContent = text;
  geminiMessage.className = `form-message${isError ? ' is-error' : ''}`;
}

function renderGemini(status) {
  geminiState = status || null;
  const configured = Boolean(status?.configured);
  const canSave = Boolean(status?.canSave);
  geminiBadge.textContent = configured ? 'Đã cấu hình' : 'Chưa cấu hình';
  geminiBadge.className = `status-badge status-${configured ? 'success' : 'warning'}`;
  geminiInput.disabled = !canSave;
  geminiSave.disabled = !canSave;
  geminiSave.textContent = configured ? 'Thay API key' : 'Lưu mã hóa';
  geminiInput.placeholder = configured ? 'Dán key mới nếu cần thay đổi' : 'Dán API key để cấu hình máy này';
  if (configured) {
    setGeminiMessage(status.source === 'environment'
      ? 'Gemini đang dùng key từ biến môi trường. Key không được gửi về giao diện.'
      : 'Gemini đã sẵn sàng. API key được mã hóa riêng cho tài khoản Windows trên máy này.');
  } else if (!canSave) {
    setGeminiMessage('Bản chạy local cần biến môi trường GEMINI_API_KEY. Bản portable có thể lưu key bằng kho mã hóa Windows.', true);
  } else {
    setGeminiMessage('Cần cấu hình Gemini để tool đọc ngữ nghĩa và ngày hết hạn nằm trong poster.', true);
  }
  updateTicketGate();
}

async function requestGemini(options = {}) {
  const response = await fetch('/api/gemini', { cache: 'no-store', ...options });
  const data = await response.json().catch(() => null);
  if (!data) throw new Error('Không đọc được trạng thái Gemini.');
  if (!response.ok) throw new Error(data.error || 'Không thể cấu hình Gemini.');
  return data;
}

async function refreshGemini() {
  try {
    renderGemini(await requestGemini());
  } catch (error) {
    geminiState = null;
    geminiBadge.textContent = 'Lỗi kết nối';
    geminiBadge.className = 'status-badge status-error';
    setGeminiMessage(error.message, true);
    updateTicketGate();
  }
}

async function saveGemini() {
  const apiKey = geminiInput.value.trim();
  if (!apiKey) {
    setGeminiMessage('Hãy dán Gemini API key.', true);
    return;
  }
  geminiInput.disabled = true;
  geminiSave.disabled = true;
  setGeminiMessage('Đang mã hóa và lưu key trên máy này…');
  try {
    const status = await requestGemini({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    geminiInput.value = '';
    renderGemini(status);
  } catch (error) {
    setGeminiMessage(error.message, true);
    geminiInput.disabled = !geminiState?.canSave;
    geminiSave.disabled = !geminiState?.canSave;
  }
}

function renderSession(session) {
  sessionState = session || null;
  const ready = Boolean(session?.ready);
  updateTicketGate();
  if (ready) {
    sessionBadge.textContent = 'Đã sẵn sàng';
    sessionBadge.className = 'status-badge status-success';
    loginOpen.textContent = 'Hiện 2 tab CRM & CMS';
    loginOpen.disabled = false;
    loginCheck.disabled = true;
    setLoginMessage('CRM và CMS đã được xác nhận. Bấm “Hiện 2 tab CRM & CMS” bất cứ lúc nào để mở lại cửa sổ Chrome riêng của tool; không tạo hoặc thay đổi tab Chrome cá nhân.');
    return;
  }
  const busy = ['opening-login', 'checking-login'].includes(session?.state);
  const waiting = session?.state === 'awaiting-login';
  const restoring = session?.state === 'checking-login' && !session?.loginWindowOpen;
  const blocksLoginOpen = busy && !restoring;
  sessionBadge.textContent = busy ? 'Đang kiểm tra' : (waiting ? 'Chờ đăng nhập' : 'Cần đăng nhập');
  sessionBadge.className = `status-badge status-${busy ? 'running' : (waiting ? 'warning' : 'idle')}`;
  loginOpen.textContent = waiting
    ? (session?.loginWindowOpen ? 'Hiện cửa sổ đăng nhập' : 'Mở lại 2 tab đăng nhập')
    : 'Mở Chrome để đăng nhập một lần';
  // A background restore can take a while when CRM/CMS is slow. The user
  // must still be able to explicitly open the two login tabs right away.
  loginOpen.disabled = blocksLoginOpen;
  loginCheck.disabled = !session?.loginWindowOpen || busy;
  setLoginMessage(
    session?.error || (restoring
      ? 'Đang khôi phục phiên đăng nhập CRM và CMS đã lưu…'
      : waiting
      ? (session?.loginWindowOpen
        ? 'Cửa sổ Chrome riêng với 2 tab CRM và CMS vẫn đang mở. Đăng nhập trong cả hai tab một lần, rồi quay lại bấm “Tôi đã đăng nhập — Kiểm tra”.'
        : 'Cửa sổ đăng nhập trước đã đóng. Bấm “Mở lại 2 tab đăng nhập” để tool khôi phục lại trang Technical của CRM và CMS.')
      : 'Bạn cần đăng nhập CRM và CMS trước khi app được phép đọc ticket hoặc Website ID.'),
    Boolean(session?.error)
  );
}

async function requestSession(path) {
  const response = await fetch(path, { method: path === '/api/session' ? 'GET' : 'POST', cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!data) throw new Error('Không đọc được trạng thái đăng nhập.');
  if (!response.ok && !data.state) throw new Error(data.error || 'Không thể kiểm tra đăng nhập.');
  return data;
}

async function refreshSession() {
  try {
    const session = await requestSession('/api/session');
    renderSession(session);
    if (!autoLoginAttempted && session.state === 'required' && !session.ready && !session.error) {
      autoLoginAttempted = true;
      sessionStorage.setItem('popup-ticket-runner:auto-login-attempted', '1');
      // Let the local page paint its status before Chrome is launched. This
      // makes first use simple: open the local app, then sign in in the two
      // tabs that appear without needing a separate button click.
      setTimeout(() => { openLogin(); }, 100);
    }
    const pendingLoginTransition = ['opening-login', 'checking-login'].includes(session.state);
    if (pendingLoginTransition && !sessionRefreshTimer) {
      sessionRefreshTimer = setTimeout(() => {
        sessionRefreshTimer = null;
        refreshSession();
      }, 750);
    }
  } catch (error) {
    ticketCard.hidden = true;
    sessionBadge.textContent = 'Lỗi kết nối';
    sessionBadge.className = 'status-badge status-error';
    setLoginMessage(error.message, true);
  }
}

async function openLogin() {
  try {
    renderSession({ ...sessionState, state: 'opening-login', ready: false });
    // Always open or restore the app-owned Chrome profile. Restarting the
    // local UI server must not silently clear a verified CRM/CMS session.
    renderSession(await requestSession('/api/session/login'));
  } catch (error) {
    setLoginMessage(error.message, true);
    loginOpen.disabled = false;
  }
}

async function checkLogin() {
  try {
    renderSession({ ...sessionState, state: 'checking-login', ready: false, loginWindowOpen: true });
    renderSession(await requestSession('/api/session/check'));
  } catch (error) {
    setLoginMessage(error.message, true);
    loginCheck.disabled = false;
  }
}

function renderTimeline(events = [], state = 'idle') {
  // Show only steps emitted by the runner. A static list made harmless
  // alternatives look like unfinished work, especially after a successful run.
  const shown = [];
  const positionByStage = new Map();
  events.forEach((event) => {
    const position = positionByStage.get(event.stage);
    if (position === undefined) {
      positionByStage.set(event.stage, shown.length);
      shown.push(event);
    } else {
      // Keep the latest Build percentage without filling the report with a
      // row for every single progress update.
      shown[position] = event;
    }
  });
  timeline.replaceChildren();
  timeline.hidden = shown.length === 0;
  shown.forEach((event, index) => {
    const item = document.createElement('li');
    const failed = event.stage === 'failed' || event.stage === 'attention' || event.stage.endsWith('-failed') || event.stage.endsWith('-unconfirmed');
    const stateClass = failed ? 'failed' : (state === 'running' && index === shown.length - 1 ? 'active' : 'done');
    item.className = `timeline-item ${stateClass}`;
    const dot = document.createElement('span'); dot.className = 'timeline-dot'; dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = event.message || event.stage;
    item.append(dot, text);
    timeline.append(item);
  });
}

function field(label, value) {
  const term = document.createElement('dt'); term.textContent = label;
  const detail = document.createElement('dd'); detail.textContent = value;
  resultList.append(term, detail);
}

function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function domainUrl(raw) {
  const domain = String(raw || '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) return null;
  return safeHttpUrl(`https://${domain}/`);
}

function linkField(label, value, rawUrl) {
  const href = safeHttpUrl(rawUrl);
  if (!href) return field(label, value);
  const term = document.createElement('dt'); term.textContent = label;
  const detail = document.createElement('dd');
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = value;
  anchor.setAttribute('aria-label', `${label}: ${value} (mở tab mới)`);
  detail.append(anchor);
  resultList.append(term, detail);
}

function renderResult(result) {
  resultList.replaceChildren();
  if (!result) { nextAction.textContent = ''; return; }
  field('Trạng thái', result.status || 'Không rõ');
  if (result.ticket) {
    const actionLabel = result.ticket.popupAction === 'replace'
      ? 'Gỡ popup cũ, thêm popup mới'
      : result.ticket.popupAction === 'remove-one'
        ? 'Gỡ đúng popup khớp ảnh từ ticket'
        : result.ticket.popupAction === 'remove-all'
          ? 'Gỡ toàn bộ popup hiện có'
          : 'Thêm/cập nhật popup';
    field('Thao tác popup', actionLabel);
    field('Website ID', result.ticket.siteId || 'Chưa tìm thấy');
    if (result.ticket.popupPosition) field('Vị trí popup yêu cầu', result.ticket.popupPosition === 'last' ? 'Cuối danh sách' : 'Đầu danh sách');
    field('Yêu cầu popup', result.ticket.popupRequested ? 'Có' : 'Không thấy từ khóa — vẫn có thể chạy luồng popup đã xác nhận');
    const popupItemsWithSchedule = Array.isArray(result.ticket.popupItems)
      ? result.ticket.popupItems.filter((item) => item?.startDate || item?.expiryDate)
      : [];
    if (result.ticket.startDate) field('Ngày bắt đầu từ ticket', result.ticket.startDate);
    field(
      'Ngày hết hạn',
      result.ticket.expiryDate || result.ticket.expiry || (popupItemsWithSchedule.length ? 'Theo lịch riêng từng poster' : 'Không có trong ticket/poster')
    );
    if (result.ticket.endYearRolledOver) field('Năm kết thúc', 'Đã tự chuyển sang năm sau theo khoảng ngày trong ticket');
    field('Attachment poster', result.ticket.attachmentAvailable ? 'Đã phát hiện' : 'Không tìm thấy');
    if (result.ticket.attachmentCount > 1) {
      const selectedIndexes = Array.isArray(result.ticket.popupAttachmentIndexes)
        ? result.ticket.popupAttachmentIndexes
        : [];
      const selected = selectedIndexes.length
        ? ` · Gemini chọn ${selectedIndexes.length} ảnh (#${selectedIndexes.join(', #')})`
        : result.ticket.popupAttachmentIndex
          ? ` · Gemini chọn ảnh #${result.ticket.popupAttachmentIndex}`
          : ' · Chưa xác định được đầy đủ ảnh popup';
      field('Ảnh trong ticket/comment', `${result.ticket.attachmentCount} ảnh${selected}`);
    }
    popupItemsWithSchedule.forEach((item, index) => {
      const posterNumber = Number(item.attachmentIndex) || index + 1;
      const start = item.startDate ? `Từ ${item.startDate}` : null;
      const end = item.expiryDate ? `Đến ${item.expiryDate}` : null;
      field(`Lịch poster #${posterNumber}`, [start, end].filter(Boolean).join(' → '));
    });
  }
  if (result.duplicateImage) {
    field('Ảnh trùng', `${result.duplicateImage.ticketFilename || 'Poster từ ticket'} đã tồn tại trong Popup settings`);
    if (result.duplicateImage.method) field('Cách nhận diện ảnh trùng', result.duplicateImage.method);
  }
  if (result.semantic) {
    const applied = result.semantic.appliedFields?.length ? ` · Bổ sung: ${result.semantic.appliedFields.join(', ')}` : '';
    const label = result.semantic.status === 'enriched'
      ? `Gemini đã xác minh và bổ sung dữ liệu${applied}`
      : result.semantic.status === 'verified'
        ? 'Gemini đã xác minh ngữ nghĩa; parser cục bộ đã đủ dữ liệu'
        : result.semantic.status === 'unavailable'
          ? 'Gemini tạm không phản hồi; tool dùng parser cục bộ an toàn'
          : result.semantic.status === 'disabled'
            ? 'Gemini chưa được cấu hình; tool dùng parser cục bộ'
            : 'Gemini trả dữ liệu không đủ an toàn; tool dùng parser cục bộ';
    field('Đọc ngữ nghĩa ticket', label);
  }
  if (result.vision) {
    const visionLabel = result.vision.status === 'selected-set'
      ? `Gemini Vision đã xác nhận bộ poster${result.vision.rationale ? ` · ${result.vision.rationale}` : ''}`
      : result.vision.status === 'selected'
      ? `Gemini Vision đã xác nhận poster${result.vision.rationale ? ` · ${result.vision.rationale}` : ''}`
      : result.vision.status === 'ambiguous'
        ? 'Gemini Vision không chọn được duy nhất một poster'
        : result.vision.status === 'disabled'
          ? 'Gemini Vision chưa được cấu hình API key; chưa có yêu cầu nhận diện nào được gửi'
        : result.vision.status === 'skipped'
          ? 'Gemini Vision không có ảnh phù hợp để gửi'
          : 'Gemini Vision tạm không phản hồi; tool dùng lựa chọn theo comment';
    field('Kiểm tra ảnh bằng Vision', visionLabel);
  }
  if (Array.isArray(result.attachments) && result.attachments.length > 1) {
    result.attachments.forEach((attachment, index) => {
      const size = attachment.bytes ? ` · ${attachment.bytes.toLocaleString('vi-VN')} bytes` : '';
      field(`Poster đã tải #${index + 1}`, `${attachment.filename || 'Đã tải xong'}${size}`);
      if (attachment.cmsUploadFilename) field(`Tên file CMS #${index + 1}`, attachment.cmsUploadFilename);
    });
  } else if (result.attachment) {
    const size = result.attachment.bytes ? ` · ${result.attachment.bytes.toLocaleString('vi-VN')} bytes` : '';
    field('Poster đã tải', `${result.attachment.filename || 'Đã tải xong'}${size}`);
    if (result.attachment.cmsUploadFilename) field('Tên file upload CMS', result.attachment.cmsUploadFilename);
    const sourceLabel = result.attachment.source === 'hover-file'
      ? 'Hover thumbnail → Download file'
      : result.attachment.source === 'inline-ticket-image'
        ? 'Ảnh nhúng trong ticket → đã tải cục bộ'
      : result.attachment.source === 'vision-candidate-download'
        ? 'Gemini Vision: tải file từng thumbnail từ CRM'
      : 'Download all attachments (dự phòng)';
    field('Cách tải poster', sourceLabel);
  }
  if (result.cms) {
    field('Project trong fastboy', result.cms.found ? `Đã tìm thấy (${result.cms.siteId})` : 'Chưa tìm thấy');
    if (result.cms.selectedDomain) linkField('Domain được chọn', result.cms.selectedDomain, domainUrl(result.cms.selectedDomain));
    if (result.cms.ambiguous) field('Project trùng ID', 'Có nhiều project cùng ID nhưng không xác định được duy nhất domain thật; tool đã dừng an toàn');
  }
  if (result.plugin) {
    field('Announcement plugin', `${result.plugin.state || 'Không rõ'}${result.plugin.version ? ` · ${result.plugin.version}` : ''}`);
    field('Plugin đang bật', result.plugin.enabled ? 'Có' : 'Không');
    if (result.plugin.updated) field('Plugin cập nhật', 'Đã cập nhật phiên bản mới');
  }
  if (result.popupSection) {
    field(
      'Announcement Popup',
      result.popupSection.replaced
        ? `Đã xóa ${result.popupSection.removedCount || 1} section cũ và thêm section mới`
        : result.popupSection.created
        ? 'Đã thêm section — đang cấu hình Popup settings'
        : result.popupSection.exists
          ? 'Đã có — sẽ không tạo trùng'
          : 'Đang kiểm tra trong Page editor'
    );
  }
  if (result.legacyPopups) {
    field(
      'Popup cũ còn hạn',
      result.legacyPopups.preservedCount
        ? `Đã sao lưu ${result.legacyPopups.preservedCount} popup để đưa sang section mới`
        : 'Không có popup còn hạn — section mới sẽ chỉ có popup từ ticket'
    );
    if (result.legacyPopups.expiredCount) field('Popup cũ đã hết hạn', `${result.legacyPopups.expiredCount} popup không được chuyển`);
  }
  if (result.legacyRecovery?.resumed) {
    field('Khôi phục migration', `Đã dùng lại ${result.legacyRecovery.preservedCount || 1} popup đã sao lưu; không xóa/tạo section lần nữa`);
  }
  if (result.timezone) field('Popup timezone', result.timezone.iana || 'Không suy ra được');
  if (result.popup) {
    const configuredCount = result.popup.ticketPosterCount || result.popup.cmsImageUrls?.length || (result.popup.imageConfigured ? 1 : 0);
    field('Poster đã cấu hình', result.popup.imageConfigured ? `Đã upload và lưu ${configuredCount} poster` : 'Chưa cấu hình');
    if (result.popup.repaired) field('Dọn popup', `Đã xóa ${result.popup.removedEmptyItems || 1} item trống${result.popup.clearedStart ? ' và bỏ ngày bắt đầu không có trong ticket' : ''}`);
    if (result.popup.deduplicated) field('Nhận diện poster', 'Ảnh đã có trong Popup settings; chỉ cập nhật lịch, không tạo item trùng');
    if (result.popup.popupPosition) field('Vị trí poster đã xác minh', result.popup.popupPosition === 'last' ? 'Cuối danh sách' : 'Đầu danh sách');
    if (result.popup.replaced) field('Popup cũ', 'Đã gỡ đúng một popup cũ trước khi thêm poster mới');
    if (result.popup.migratedLegacyPopups) field('Popup đã chuyển', `${result.popup.migratedLegacyPopups} popup còn hạn đã được upload lại vào section mới`);
    if (result.popup.ticketMergedWithLegacy) field('Ticket hiện tại', 'Ảnh trùng popup cũ; đã cập nhật thời hạn trên popup đã chuyển, không tạo bản sao');
    if (result.popup.start) field('Popup bắt đầu', result.popup.start);
    if (result.popup.expiry) field('Popup tắt', result.popup.expiry);
    if (result.popup.timezone) field('Timezone đã lưu', result.popup.timezone);
    if (result.popup.timezoneControl && !result.popup.timezoneControl.supported) {
      field('Timezone trong plugin', 'Plugin phiên bản mới không có selector; tool dùng timezone từ địa chỉ project để tính ngày');
    }
    if (result.popup.published) field('Popup', 'Đã Build và xuất bản thành công');
  }
  if (result.removalVision) {
    const label = result.removalVision.status === 'selected'
      ? `Gemini Vision đã xác nhận ảnh popup cần gỡ${result.removalVision.rationale ? ` · ${result.removalVision.rationale}` : ''}`
      : result.removalVision.status === 'not-found'
        ? `Gemini Vision xác nhận không có popup nào trùng ảnh ticket${result.removalVision.rationale ? ` · ${result.removalVision.rationale}` : ''}`
      : result.removalVision.status === 'ambiguous'
        ? 'Gemini Vision không xác định duy nhất popup khớp ảnh ticket; tool không gỡ popup'
        : 'Gemini Vision không phản hồi; tool không gỡ popup';
    field('Đối chiếu ảnh gỡ popup', label);
  }
  if (result.popupRemoval) {
    const scope = result.popupRemoval.scope === 'all' ? 'toàn bộ popup' : 'popup khớp ảnh ticket';
    field('Gỡ popup', result.popupRemoval.changed
      ? `Đã gỡ ${result.popupRemoval.removedCount || 1} ${scope}`
      : `Không có ${scope} để gỡ`);
    if (result.popupRemoval.visionRationale) field('Lý do khớp ảnh', result.popupRemoval.visionRationale);
  }
  if (result.build) {
    field('CMS Build', result.build.status === 'success' ? 'Thành công' : result.build.status || 'Chưa xác nhận');
    if (result.build.evidence) field('Xác nhận từ CMS', result.build.evidence);
  }
  if (result.website) {
    const websiteUrl = result.website.liveUrl || result.website.previewUrl || null;
    if (websiteUrl) linkField('Website popup', websiteUrl, websiteUrl);
    else field('Website popup', 'CMS chưa trả về Live URL');
  }
  nextAction.textContent = result.nextAction || '';
}

function renderOutcome(job) {
  if (job.state === 'running' || job.state === 'idle') {
    panel.hidden = true;
    return;
  }
  const success = job.state === 'complete' && ['popup-live', 'popup-removed'].includes(job.result?.status);
  panel.hidden = false;
  panel.dataset.outcome = success ? 'success' : 'error';
  resultHeading.textContent = success
    ? (job.result?.status === 'popup-removed' ? '✓ Popup đã được gỡ khỏi website' : '✓ Popup đã lên website')
    : '⚠ Chưa thể xác nhận hoàn thành';
  resultSummary.textContent = success
    ? (job.result?.nextAction || 'CMS Build đã hoàn tất thành công.')
    : (job.error || job.result?.error || job.result?.nextAction || 'Tool đã dừng trước khi xác nhận CMS Build thành công.');
  renderResult(job.result);
}

async function fetchJob(id) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 404) sessionStorage.removeItem(storedJobKey);
    throw new Error('Không đọc được trạng thái tool.');
  }
  return response.json();
}

async function watch(id) {
  try {
    const job = await fetchJob(id);
    renderTimeline(job.events, job.state);
    renderOutcome(job);
    if (job.state === 'running') {
      button.disabled = true;
      setBadge('Đang xử lý', 'running');
      setTimeout(() => watch(id), 700);
      return;
    }
    button.disabled = false;
    if (job.state === 'complete' && ['popup-live', 'popup-removed'].includes(job.result?.status)) setBadge('Popup thành công', 'success');
    else setBadge('Có lỗi cần kiểm tra', 'error');
    if (job.error) { message.textContent = job.error; message.classList.add('is-error'); }
    if (['ticket-not-loaded', 'browser-offline', 'login-required'].includes(job.result?.status)) refreshSession();
  } catch (error) {
    button.disabled = false;
    setBadge('Lỗi kết nối', 'error');
    message.textContent = error.message;
    message.classList.add('is-error');
  }
}

async function startJob() {
  const ticketUrl = input.value.trim();
  message.textContent = ''; message.className = 'form-message'; panel.hidden = true; delete panel.dataset.outcome;
  if (!sessionState?.ready) {
    message.textContent = 'Hãy hoàn tất đăng nhập CRM và CMS trước.';
    message.classList.add('is-error');
    refreshSession();
    return;
  }
  if (!geminiState?.configured) {
    message.textContent = 'Hãy cấu hình Gemini API key trước khi chạy ticket.';
    message.classList.add('is-error');
    refreshGemini();
    return;
  }
  if (!ticketUrl) { message.textContent = 'Hãy dán link ticket CRM.'; message.classList.add('is-error'); return; }
  button.disabled = true;
  setBadge('Đang tạo popup & Build', 'running');
  renderTimeline([], 'running');
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketUrl, apply: true, build: true, downloadPoster: true, expiry: null })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thể chạy ticket.');
    sessionStorage.setItem(storedJobKey, data.id);
    watch(data.id);
  } catch (error) {
    button.disabled = false;
    setBadge('Không thể chạy', 'error');
    message.textContent = error.message; message.classList.add('is-error');
    if (/đăng nhập|login|required/i.test(error.message)) refreshSession();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  startJob();
});

loginOpen.addEventListener('click', openLogin);
loginCheck.addEventListener('click', checkLogin);
geminiForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveGemini();
});

const previousJobId = sessionStorage.getItem(storedJobKey);
if (previousJobId) watch(previousJobId);
else renderTimeline();
refreshSession();
refreshGemini();
