'use strict';

const MONTH_NUMBERS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
  october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const DATE_TOKEN_SOURCE = String.raw`(?:\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.](?:20)?\d{2}\b|\b\d{1,2}[/.]\d{1,2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s*(?:20\d{2})?\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+20\d{2})?\b|\bthanksgiving(?:\s+day)?\s+\d{1,2}\b|\b\d{1,2}\s+thanksgiving\b)`;

function calendarDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}

function getThanksgivingDate(year) {
  const nov1Day = (new Date(Date.UTC(year, 10, 1))).getUTCDay();
  const firstThursday = ((11 - nov1Day) % 7) + 1;
  const fourthThursday = firstThursday + 21;
  return calendarDate(year, 11, fourthThursday);
}

const POPUP_OPEN_DELAY_SECONDS = 3;

function extractPopupDuration(text) {
  if (!text) return null;
  const raw = String(text || '');
  const folded = foldTicketText(raw).replace(/[\t\r\f\v ]+/g, ' ');

  // 1. Explicit delay-slider expression (e.g. "delay slider 13s", "time delay 13").
  // Require a duration unit when bare "slider" is used so website hero references
  // like "slider 1" or "banner slider 2" are never misread as popup delay seconds.
  const sliderMatch = /(?:(?:delay\s*slider|slider\s*delay|time\s*delay)\b[^.;\n]{0,60}?\b(\d{1,3})\s*(?:s|giay|seconds?|sec)?|\bslider\b[^.;\n]{0,60}?\b(\d{1,3})\s*(?:giay|seconds?|sec)|slider\b[^.;\n]{0,60}?\b(\d{1,3})s)\b/i.exec(folded);
  if (sliderMatch) {
    const rawVal = parseInt(sliderMatch[1] || sliderMatch[2] || sliderMatch[3], 10);
    if (rawVal > 0 && rawVal <= 120) {
      return {
        requestedSeconds: rawVal >= POPUP_OPEN_DELAY_SECONDS ? rawVal - POPUP_OPEN_DELAY_SECONDS : rawVal,
        delaySliderSeconds: rawVal,
        isExplicitSlider: true
      };
    }
  }

  // 2. Duration / display time requests for popup
  const patterns = [
    /\b(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b[^.;\n]{0,40}?\b(?:hien\s*thi|xuat\s*hien|chay|hien|show|display|duration|thoi\s*gian|delay)\b[^.;\n]{0,30}?\b(\d{1,3})\s*(?:s|giay|seconds?|sec)\b/gi,
    /\b(?:hien\s*thi|xuat\s*hien|chay|hien|show|display|thoi\s*gian|duration)\b[^.;\n]{0,30}?\b(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b[^.;\n]{0,30}?\b(\d{1,3})\s*(?:s|giay|seconds?|sec)\b/gi,
    /\b(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b[^.;\n]{0,40}?\b(?:lau\s*hon|dai\s*hon|longer)\b[^.;\n]{0,30}?\b(\d{1,3})\s*(?:s|giay|seconds?|sec)\b/gi,
    /\b(?:thoi\s*gian|time)\s*(?:cho\s*)?(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b[^.;\n]{0,30}?\b(\d{1,3})\s*(?:s|giay|seconds?|sec)\b/gi,
    /\b(?:chinh|cai|set|tang|de|cho)\s+(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b[^.;\n]{0,80}?\b(\d{1,3})\s*(?:s|giay|seconds?|sec)\b/gi,
    /\b(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b[^.;\n]{0,80}?\b(\d{1,3})(?:s|\s*(?:giay|seconds?|sec))\b/gi
  ];

  // Guard against US street direction numbers like "15 S Main St" or decade eras ("80s", "90s")
  const rawAddressSouthPattern = /\b\d{1,3}\s+S\.?(?=\s+[A-Z0-9])/g;
  const addressSouthNumbers = new Set([...raw.matchAll(rawAddressSouthPattern)].map((m) => m[0].trim().split(/\s+/)[0]));

  for (let pIndex = 0; pIndex < patterns.length; pIndex += 1) {
    const pattern = patterns[pIndex];
    for (const match of folded.matchAll(pattern)) {
      const rawSec = parseInt(match[1], 10);
      const token = match[0];
      if (pIndex === 5 && /^(?:70|80|90)s$/i.test(`${match[1]}s`) && /\b(?:70|80|90)s\b/i.test(token)) {
        continue;
      }
      if (addressSouthNumbers.has(match[1]) && new RegExp(String.raw`\b${match[1]}\s+S\b`, 'i').test(token)) {
        continue;
      }
      if (rawSec > 0 && rawSec <= 120) {
        return {
          requestedSeconds: rawSec,
          delaySliderSeconds: rawSec + POPUP_OPEN_DELAY_SECONDS,
          isExplicitSlider: false
        };
      }
    }
  }

  return null;
}

function hasAffirmativePosterUpload(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const posterEntity = /\b(?:posters?|banners?|hinh|anh|file|dinh\s*kem|attachment|image)\b/i;
  const uploadAction = /\b(?:add(?:ed)?|creat(?:e|ed)|upload(?:ed)?|publish(?:ed)?|them|tao|dang|up|len(?:\s+web)?|treo|gan|chen)\b/gi;
  for (const match of folded.matchAll(uploadAction)) {
    if (actionIsNegated(folded, match.index)) continue;
    const { start, end } = clauseBounds(folded, match.index);
    const clause = folded.slice(start, end);
    if (posterEntity.test(clause)) return true;
    // Also detect explicit creation/upload of a new popup (e.g. "tao popup moi", "up popup nay len web")
    if (/\b(?:new\s+pop[\s-]*ups?|pop[\s-]*ups?\s+(?:moi|nay)|(?:them|tao|dang|up|upload|add|create|publish)\s+(?:giup\s+)?(?:em\s+|tiem\s+)?(?:cai\s+)?pop[\s-]*up\b)\b/i.test(clause)) {
      return true;
    }
  }
  const popupAsVerb = /\bpop[\s-]*up\s+(?:cho\s+tiem|cho\s+web|cho|giup(?:\s+(?:em|tiem|anh|chi))?)?\s*(?:poster|banner|image|anh|hinh|tam\s+(?:hinh|anh)|file|dinh\s*kem)\b/gi;
  for (const match of folded.matchAll(popupAsVerb)) {
    if (!actionIsNegated(folded, match.index)) return true;
  }
  return false;
}

function foldTicketText(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function clauseBounds(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const endings = [text.indexOf('.', index), text.indexOf(';', index), text.indexOf('\n', index)]
    .filter((value) => value >= 0);
  const end = endings.length ? Math.min(...endings) : text.length;
  return { start, end };
}

function actionIsNegated(text, actionIndex) {
  const { start } = clauseBounds(text, actionIndex);
  const prefix = text.slice(start, actionIndex).slice(-100);
  const contrast = [...prefix.matchAll(/\b(?:but|however|only|chi|nhung)\b/gi)].at(-1);
  const scopedPrefix = contrast ? prefix.slice(contrast.index + contrast[0].length) : prefix;
  return /\b(?:do\s+not|don\W?t|dont|never|(?:must|should|shall)\s+not|can\W?t|cannot|not\s+to|no(?:\s+need\s+to)?|without|khong(?:\s+can)?|dung)\b[^.;\n]{0,60}$/i.test(scopedPrefix);
}

function isCompletionReplyComment(text) {
  const folded = foldTicketText(text).replace(/\s+/g, ' ').trim();
  if (!folded || folded.length > 220) return false;
  if (/\b(?:nho\s+team|please\b|can\s+ho\s+tro|giup\s+khach|sau\s+do\s+se|thay\s+bang|up\s+lai|xoa\s+popup|go\s+popup|popup\s+poster|remove\s+poster)\b/i.test(folded)) {
    return false;
  }
  return /^(?:hi\s+team\s*,?\s*)?(?:(?:da|done)\s+(?:update(?:\s+theo\s+yeu\s+cau)?|cap\s*nhat(?:\s+theo\s+yeu\s+cau)?|up|xu\s*ly|ho\s*tro|xong|hoan\s*tat|go|xoa)|done\b|completed?\b|updated?\b|finished\b|.{0,60}-\s*done\b)(?:[\s.,!?:;-]*(?:thanks?|thank\s+team|cam\s+on|a|nha))*$/i.test(folded);
}

function parseConversationComments(raw) {
  const text = String(raw || '');
  const convMatch = /(?:^|\n)Conversations\s*(?:\n|$)/i.exec(text);
  if (!convMatch) return [];
  let section = text.slice(convMatch.index + convMatch[0].length);
  section = section.replace(/^\s*Reload\s*(?:\n|$)/i, '');
  const footerMatch = /\nFastboy CRM\s*@/i.exec(section);
  if (footerMatch) section = section.slice(0, footerMatch.index);
  const lines = section.split(/\r?\n/);
  const timestampPattern = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+20\d{2}\s+\d{1,2}:\d{2}\s*(?:AM|PM)$/i;
  const tsIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (timestampPattern.test(lines[i].trim())) tsIndices.push(i);
  }
  if (!tsIndices.length) return [];
  const comments = [];
  for (let k = 0; k < tsIndices.length; k += 1) {
    const tsIdx = tsIndices[k];
    const nextTsIdx = k + 1 < tsIndices.length ? tsIndices[k + 1] : lines.length;
    let bodyEnd = nextTsIdx;
    if (k + 1 < tsIndices.length) {
      // Strip the next comment's author/assign/email header lines (1 to 3 lines before next timestamp)
      let headerStart = nextTsIdx - 1;
      let steps = 0;
      while (headerStart > tsIdx && steps < 3) {
        const candidate = lines[headerStart].trim();
        if (!candidate || candidate === '(assign)' || /@/.test(candidate) || steps === 2 || headerStart === nextTsIdx - 1) {
          headerStart -= 1;
          steps += 1;
        } else {
          break;
        }
      }
      // Trim up to email + optional (assign) + author line right above next timestamp
      let metaLines = 1; // at least author or email line immediately before timestamp
      if (nextTsIdx - 2 > tsIdx && (lines[nextTsIdx - 2].trim() === '(assign)' || /@/.test(lines[nextTsIdx - 1]))) {
        metaLines = 2;
      }
      if (nextTsIdx - 3 > tsIdx && lines[nextTsIdx - 2].trim() === '(assign)') {
        metaLines = 3;
      }
      bodyEnd = Math.max(tsIdx + 1, nextTsIdx - metaLines);
    }
    const body = lines.slice(tsIdx + 1, bodyEnd).join('\n').trim();
    comments.push({
      timestamp: lines[tsIdx].trim(),
      body
    });
  }
  return comments;
}

function activeTicketRequestText(body) {
  const raw = String(body || '');
  const comments = parseConversationComments(raw);
  if (!comments.length) return raw;
  const completionIdx = comments.findIndex((comment) => isCompletionReplyComment(comment.body));
  if (completionIdx <= 0) return raw;
  const recentText = comments
    .slice(0, completionIdx)
    .map((comment) => comment.body)
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (!recentText) return raw;
  const hasActionSignal = /\b(?:pop[\s-]*up|announcement|poster|banner|coupon|voucher|hinh|anh|exp|expiry|until|het\s*han|seconds?|giay|delay|size|1x1)\b/i
    .test(foldTicketText(recentText));
  return hasActionSignal ? recentText : raw;
}

function removalTargetIsNonWebsiteChannel(folded, matchIndex) {
  const { start, end } = clauseBounds(folded, matchIndex);
  const clause = folded.slice(start, end);
  if (/(?:-\s*done\b|\bda\s+(?:xoa|go|xong)\b)/i.test(clause)) return true;
  const mentionsSocial = /\b(?:dang\s+tren|tren|on)\s+(?:facebook|fb|fanpage|instagram|ig|tiktok|social(?:\s*media)?|google(?:\s*business)?|gbp)\b/i.test(clause);
  const mentionsWebsite = /\b(?:website|web|site|cms|pop[\s-]*up)\b/i.test(clause);
  return mentionsSocial && !mentionsWebsite;
}

function hasAffirmativePopupRemoval(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const entity = String.raw`(?:pop[\s-]*ups?|announcements?|posters?|banners?|halloween|holiday|thong\s*bao(?:\s*nghi(?:\s*le)?)?)`;
  if (!new RegExp(String.raw`\b${entity}\b`, 'i').test(folded)) return false;
  const patterns = [
    new RegExp(String.raw`\b(?:go|xoa)\s+(?:giup|ho|dum|gium)?\s*(?:(?:em|e|team|ad|admin)\s*)?(?:(?:toan\s+bo|tat\s+ca|het)\s+)?${entity}\b`, 'gi'),
    new RegExp(String.raw`\b(?:tat|thay)\s+(?:(?:toan\s+bo|tat\s+ca)\s+)?${entity}\b`, 'gi'),
    new RegExp(String.raw`\b(?:remove|delete|replace|turn\s+off)\b[^.;]{0,40}\b${entity}\b`, 'gi'),
    /\b(?:remove|delete|turn\s+off)\b[^.;]{0,20}\b(?:this|that|attached)\s+(?:one|image)\b/gi
  ];
  return patterns.some((pattern) => {
    for (const match of folded.matchAll(pattern)) {
      if (!actionIsNegated(folded, match.index)) {
        if (removalTargetIsNonWebsiteChannel(folded, match.index)) continue;
        if (removalTargetIsExpiredOnly(folded, match.index)) continue;
        const prefix = folded.slice(Math.max(0, match.index - 30), match.index);
        if (/\b(?:schedule|lich|hen(?:\s+gio)?|timer)\s*$/i.test(prefix.trim())) continue;
        return true;
      }
    }
    return false;
  });
}

function hasAffirmativePopupUpdate(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const entityPattern = /\b(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b/i;
  const actionPattern = /\b(?:add(?:ed)?|creat(?:e|ed)|updat(?:e|ed)|replac(?:e|ed)|upload(?:ed)?|publish(?:ed)?|launch(?:ed)?|setup|set\s+up|them|tao|cap\s*nhat|thay|dang|cai(?:\s+dat)?|len(?:\s+web)?)\b/gi;
  for (const match of folded.matchAll(actionPattern)) {
    if (actionIsNegated(folded, match.index)) continue;
    const { start, end } = clauseBounds(folded, match.index);
    if (entityPattern.test(folded.slice(start, end))) return true;
  }
  const popupAsVerb = /\bpop[\s-]*up\s+(?:cho|giup|poster|banner|image|anh|hinh|file|dinh\s*kem|nay)\b/gi;
  for (const match of folded.matchAll(popupAsVerb)) {
    if (!actionIsNegated(folded, match.index)) {
      const prefix = folded.slice(Math.max(0, match.index - 20), match.index);
      if (!/\b(?:go|xoa|tat|remove|delete|turn\s+off)\s*$/i.test(prefix.trim())) {
        return true;
      }
    }
  }
  return false;
}

function hasAffirmativePopupReplace(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const entity = String.raw`(?:pop[\s-]*ups?|announcements?|posters?|banners?|hinh|anh|coupons?|vouchers?)`;
  if (!new RegExp(String.raw`\b${entity}\b`, 'i').test(folded)) return false;

  const patterns = [
    new RegExp(String.raw`\b(?:update\s*lai|up\s*lai|dang\s*lai|cap\s*nhat\s*lai|thay\s*lai|doi|thay\s*doi|thay\s*the|replace|change|swap)\b[^.;\n]{0,40}\b${entity}\b`, 'gi'),
    new RegExp(String.raw`\b${entity}\b[^.;\n]{0,40}\b(?:update\s*lai|up\s*lai|dang\s*lai|cap\s*nhat\s*lai|thay\s*lai|doi|thay\s*doi|thay\s*the|replace|change|swap)\b`, 'gi'),
    new RegExp(String.raw`\bthay\b[^.;\n]{0,30}\b${entity}\b`, 'gi'),
    /\b(?:update|up|dang|cap\s*nhat|thay|doi)\s+lai\b(?!\s+(?:content|noi\s*dung|bai(?:\s+(?:viet|dang))?|caption|sms|tin\s*nhan|google|facebook|fb|menu|gia|gio|text)\b)/gi
  ];

  for (const pattern of patterns) {
    for (const match of folded.matchAll(pattern)) {
      if (!actionIsNegated(folded, match.index)) return true;
    }
  }

  const removesExisting = hasAffirmativePopupRemoval(folded);
  const addsOrUpdates = hasAffirmativePopupUpdate(folded);
  const isScheduledRemoval = /\b(?:schedule|lich|hen(?:\s+gio)?)\s+go\b/i.test(folded);
  // "tam remove" (tạm = temporary) is a separate inline removal, not a replace.
  // Also treat "add X + remove Y" with an explicit separator as independent actions.
  const isTemporaryRemoval = /\btam\s+(?:remove|go|xoa|tat)\b/i.test(folded);
  const isSeparatedAction = /\b(?:popup|poster|banner)\b[^.;\n]{0,80}[+&]\s*(?:tam\s+)?(?:remove|go|xoa|tat)\b/i.test(folded);
  return removesExisting && addsOrUpdates && !isScheduledRemoval && !isTemporaryRemoval && !isSeparatedAction;
}

function removalTargetIsExpiredOnly(folded, matchIndex) {
  const { start, end } = clauseBounds(folded, matchIndex);
  const clause = folded.slice(start, end);
  return /\b(?:da\s+)?(?:het\s*han|qua\s*han|expired)\b/i.test(clause);
}

function hasAffirmativeExpiredRemoval(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const entity = String.raw`(?:pop[\s-]*ups?|announcements?|posters?|banners?)`;
  const patterns = [
    new RegExp(String.raw`\b(?:go|xoa|don(?:\s+dep)?|tat|remove|delete|clear|clean(?:\s+up)?|purge)\b[^.;\n]{0,45}\b(?:cac\s+|nhung\s+|toan\s+bo\s+|tat\s+ca\s+|all\s+)?${entity}\b[^.;\n]{0,30}\b(?:da\s+)?(?:het\s*han|qua\s*han)\b`, 'gi'),
    new RegExp(String.raw`\b(?:remove|delete|clear|clean(?:\s+up)?|purge)\b[^.;\n]{0,45}\bexpired\s+(?:${entity})\b`, 'gi'),
    new RegExp(String.raw`\b${entity}\b[^.;\n]{0,25}\b(?:da\s+)?(?:het\s*han|qua\s*han|expired)\b[^.;\n]{0,35}\b(?:go|xoa|don|tat|remove|delete|clear|clean)\b`, 'gi')
  ];
  for (const pattern of patterns) {
    for (const match of folded.matchAll(pattern)) {
      if (actionIsNegated(folded, match.index)) continue;
      if (removalTargetIsNonWebsiteChannel(folded, match.index)) continue;
      return true;
    }
  }
  return false;
}

function explicitRemoveAllRequested(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const patterns = [
    /\b(?:remove|delete|turn\s+off)\s+(?:all|every)\s+(?:of\s+the\s+)?(?:(?:current|existing)\s+)?(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b/gi,
    /\b(?:all|every)\s+(?:(?:current|existing)\s+)?(?:pop[\s-]*ups?|announcements?|posters?|banners?)\s+(?:(?:should|must|need\s+to)\s+)?(?:be\s+)?(?:removed|deleted|turned\s+off)\b/gi,
    /\b(?:remove|delete)\s+the\s+entire\s+(?:popup|announcement)\s+(?:list|section)\b/gi,
    /\b(?:go|xoa|tat)\s+(?:toan\s+bo|tat\s+ca)\s+(?:cac\s+)?(?:pop[\s-]*ups?|announcements?|posters?|banners?)\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of folded.matchAll(pattern)) {
      if (actionIsNegated(folded, match.index)) continue;
      if (removalTargetIsExpiredOnly(folded, match.index)) continue;
      const { end } = clauseBounds(folded, match.index);
      const tail = folded.slice(match.index + match[0].length, end);
      if (/\b(?:except|but\s+keep|leave|tru|ngoai\s+tru)\b/i.test(tail)) continue;
      return true;
    }
  }
  return false;
}

function hasIndefiniteScheduleInstruction(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim().toLowerCase();
  if (!folded) return false;

  const patterns = [
    /\b(?:den|toi|cho\s+den|cho\s+toi|chay\s+den)\s+(?:khi|nao|luc)?\s*(?:khach|client|customer)\s*(?:bao|yeu\s*cau\s*)?(?:tat|go|stop|remove|turn\s*off)\b/i,
    /\b(?:khi\s*nao|chung\s*nao)\s+(?:khach|client|customer)\s*(?:bao|yeu\s*cau\s*)?(?:tat|go|stop|remove|turn\s*off)\b/i,
    /\b(?:den|cho\s+den)\s+khi\s+co\s+thong\s*bao\s+moi\b/i,
    /\b(?:khong\s+(?:co\s+)?(?:han|ngay\s*(?:het\s*han|ket\s*thuc))|khong\s*(?:set|cai|de)\s*han)\b/i,
    /\bchay\s+(?:lien\s*tuc|vo\s+thoi\s+han)\b/i,
    /\buntil\s+(?:client|customer)\s+(?:asks?\s+to\s+)?(?:turn\s*off|remove|stop)\b/i,
    /\b(?:no\s+exp(?:iry|iration)?|no\s+end\s*date|indefinite|run\s+continuously)\b/i
  ];

  return patterns.some((pattern) => pattern.test(folded));
}

function stripKeepExistingClauses(foldedText) {
  return String(foldedText || '')
    // Do not mistake "vẫn giữ 2 coupon hiện có" / "keep 2 existing popups" for uploading 2 new posters.
    .replace(/\b(?:van\s+)?giu{1,2}(?:\s+(?:lai|nguyen))?\s+(?:ca\s*)?(?:\d+|hai|ba|bon|two|three|both)?\s*(?:(?:coupon|voucher|flyer|poster|pop[\s-]*up|anh|hinh|slide|card|item)s?\s*)*[^.\n,;]{0,40}\b(?:hien\s+co|dang\s+co|dang\s+chay|dang\s+pop(?:\s*up)?|hien\s+tai|cu|existing|current)\b/gi, ' ')
    .replace(/\bkeep(?:ing)?\s+(?:all\s+)?(?:the\s+)?(?:existing|current|\d+|two|three|both)\s+(?:existing|current\s+)?(?:coupon|voucher|flyer|poster|pop[\s-]*up|image|card)s?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMultiPosterIntent(text) {
  const folded = stripKeepExistingClauses(
    foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim()
  );
  if (!folded) return false;

  const pluralNoun = String.raw`(?:(?:coupon|voucher|flyer|promo(?:tion)?|poster|banner|anh|hinh|image)\s+)*(?:posters?|pop[\s-]*ups?|banners?|coupons?|vouchers?|flyers?|(?:hinh\s+)?anh|(?:tam\s+)?hinh)`;
  const patterns = [
    new RegExp(String.raw`\b(?:2|3|4|hai|ba|bon|two|three)\s*${pluralNoun}\b`, 'i'),
    /\b(?:2|3|4|hai|ba|bon|two|three)\s+(?:anh|hinh|image|file)s?\s+(?:dinh\s*kem|moi|ben\s+duoi|pop[\s-]*up)\b/i,
    new RegExp(String.raw`\b(?:ca\s*2|ca\s*hai|both)\s*(?:${pluralNoun}|anh|hinh|file)?\b`, 'i'),
    new RegExp(String.raw`\b(?:pop(?:\s*up)?|dang|up|update|cap\s*nhat|them|tao|treo|cai(?:\s+dat)?)\s+(?:ca\s*2|ca\s*hai|2|hai|3|ba)\s*(?:${pluralNoun}|anh|hinh|file)?\b`, 'i'),
    /\b(?:pop(?:\s*up)?|dang|up|them|tao|treo)\s+(?:posters|pop[\s-]*ups|coupons)\b/i,
    /\b(?:poster|popup|coupon|voucher|anh|hinh)\s*(?:1|mot|one)\s*(?:va|and|,|&)\s*(?:poster|popup|coupon|voucher|anh|hinh)?\s*(?:2|hai|two)\b/i,
    /\b(?:multiple|several|both)\s+(?:(?:coupon|voucher|flyer|poster|banner)\s+)*(?:posters?|pop[\s-]*ups?|banners?|coupons?|vouchers?)\b/i,
    /\b(?:2|3|two|three)\s+separate\s+(?:pop[\s-]*ups?|coupons?|posters?)\b/i
  ];

  return patterns.some((pattern) => pattern.test(folded));
}

function keepsExistingPopups(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  if (!folded) return false;
  const patterns = [
    /\b(?:van\s+)?giu{1,2}(?:\s+(?:lai|nguyen))?\s+(?:het|toan\s+bo|tat\s+ca|cac|\d+|hai|ba)?\s*(?:coupon|voucher|flyer|poster|pop[\s-]*up|anh|hinh|card|cai|slide)[^.\n;]{0,45}\b(?:hien\s+co|dang\s+co|dang\s+chay|dang\s+pop(?:\s*up)?|hien\s+tai|cu)\b/gi,
    /\bvan\s+giu{1,2}(?:\s+(?:lai|nguyen))?\b/gi,
    /\bkeep(?:ing)?(?:\s+all)?\s+(?:the\s+)?(?:existing|current)\s+(?:pop[\s-]*ups?|coupons?|posters?|banners?)\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of folded.matchAll(pattern)) {
      if (!actionIsNegated(folded, match.index)) return true;
    }
  }
  return false;
}

function extractPopupOrderSequence(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const linePattern = /(?:theo\s+)?(?:th[uưứ]\s*t[uự]|order(?:\s+of\s+(?:pop[\s-]*ups?|coupons?|posters?))?)(?:\s+(?:coupon|pop[\s-]*ups?|posters?|hi[eể]n\s*th[iị]))?\s*[:=-]\s*([^\n\r]+)/gi;
  for (const match of raw.matchAll(linePattern)) {
    const rhs = String(match[1] || '').trim();
    if (!rhs) continue;
    const parts = rhs
      .split(/(?:\s+[-–—]\s+|\s*(?:->|=>|>|,|\/|;|\|)\s*)/)
      .map((part) => part.replace(/^\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim())
      .filter((part) => part.length >= 2);
    if (parts.length < 2) continue;
    if (parts.every((part) => /^(?:first|last|top|bottom|dau|cuoi)$/i.test(foldTicketText(part)))) continue;
    return parts;
  }
  return [];
}

function requestedAspectRatio(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  if (!folded) return null;
  if (/\b(?:size\s*)?(?:1\s*[x:]\s*1|vuong|square)\b/i.test(folded)) {
    return { label: '1:1', ratio: 1 };
  }
  const ratioMatch = /\b(?:size|ti\s*le|ratio|khung)\s*[:=-]?\s*(\d{1,4})\s*[x:]\s*(\d{1,4})\b/i.exec(folded);
  if (ratioMatch) {
    const w = Number(ratioMatch[1]);
    const h = Number(ratioMatch[2]);
    if (w > 0 && h > 0) {
      return { label: `${w}:${h}`, ratio: w / h };
    }
  }
  return null;
}

function hasSizeOrReuploadInstruction(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  if (!folded) return false;
  return Boolean(requestedAspectRatio(folded))
    || /\b(?:up|upload|dang|gui|update|cap\s*nhat|sua|chinh)\s+lai\s+(?:anh|hinh|poster|popup|coupon)\b/i.test(folded)
    || /\b(?:dung|chuan|khac|sai|doi|fix|wrong|different|correct)\s+size\b/i.test(folded)
    || /\bsize\s+(?:moi|khac|vuong|1\s*[x:]\s*1)\b/i.test(folded);
}

function requestedPopupPosition(text) {
  const folded = foldTicketText(text).replace(/\s+/g, ' ').trim();
  // Position words overlap schedule labels such as "popup end date". Mask
  // those labels before matching so an expiry instruction never reorders a
  // popup card.
  const positionText = folded
    .replace(/\b(?:popup\s+)?(?:time\s*end|end\s*(?:date|time)|expiry\s*(?:date|time)?|expiration\s*(?:date|time)?)\b/g, ' schedule-field ')
    .replace(/\b(?:until|through|till|valid\s+(?:to|until)|expires?\s+(?:at|on|by)?|at|to)\s+(?:the\s+)?end\s+of\s+(?:(?:the|this|current)\s+)?(?:day|week|month|year|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g, ' schedule-field ')
    .replace(/\b(?:until|through|till|valid\s+(?:to|until)|expires?\s+(?:at|on|by)?|at|to)\s+(?:the\s+)?(?:(?:this|current)\s+)?(?:day|week|month|year)\s+end\b/g, ' schedule-field ')
    .replace(/\b(?:den|toi)\s+(?:ngay\s+)?cuoi\s+(?:ngay|tuan|thang(?:\s+\d{1,2})?|nam)\b/g, ' schedule-field ')
    .replace(/\s+/g, ' ')
    .trim();
  const entity = String.raw`(?:pop[\s-]*up|announcement|poster|banner|image|anh|hinh)`;
  const positionLabel = String.raw`(?:position|order|vi\s*tri|thu\s*tu)`;
  const placementVerb = String.raw`(?:move|put|place|arrange|make|keep|dua|xep|de|dat|cho|giu)`;
  const strongPlacementVerb = String.raw`(?:move|put|place|arrange|dua|xep|dat)`;
  // Bare "end/cuoi" is also ordinary expiry language. Generic placement
  // requires an unambiguous order word; bare end/cuoi is allowed only beside
  // an explicit position label, list/slider, or strong move verb.
  const last = String.raw`(?:last|final|bottom|cuoi\s*cung|duoi\s*cung)`;
  const positionLast = String.raw`(?:${last}|end|cuoi)`;
  const first = String.raw`(?:first|top|beginning|dau(?:\s*tien)?|tren\s*cung)`;
  const matches = (word) => [
    new RegExp(String.raw`\b${positionLabel}\b\s*(?::|=|-)?\s*(?:at|to|is|la|o)?\s*\b${word}\b`, 'i'),
    new RegExp(String.raw`\b${entity}\b[^.]{0,70}\b${positionLabel}\b[^.]{0,24}\b${word}\b`, 'i'),
    new RegExp(String.raw`\b${entity}\b[^.]{0,18}\b(?:show|display|hien\s*thi)\b\s+(?:o\s+)?(?:vi\s*tri\s+)?\b${word}\b`, 'i'),
    new RegExp(String.raw`\b${placementVerb}\b[^.]{0,50}\b${entity}\b[^.]{0,35}\b(?:at|to|in|as|the|o|xuong|len|nam)?\s*(?:the\s+|vi\s*tri\s+)?\b${word}\b(?:\s+(?:position|place|slot|item|one|vi\s*tri))?`, 'i'),
    new RegExp(String.raw`\b${entity}\b[^.]{0,35}\b(?:should\s+be|is|at|to|in|as|o|xuong|len|nam\s+o|dat\s+o|de\s+o)\s+(?:the\s+|vi\s*tri\s+)?\b${word}\b`, 'i'),
    new RegExp(String.raw`\b${word}\b\s+(?:position|place|slot|item|one|vi\s*tri)\b`, 'i')
  ].some((pattern) => pattern.test(positionText));
  const explicitLastPosition = [
    new RegExp(String.raw`\b${positionLabel}\b\s*(?::|=|-)?\s*(?:at|to|is|la|o)?\s*\b${positionLast}\b`, 'i'),
    new RegExp(String.raw`\b${strongPlacementVerb}\b[^.]{0,50}\b${entity}\b\s+(?:(?:this|nay)\s+)?(?:to|at|in|as|o|xuong|nam\s+o)\s+(?:the\s+|vi\s*tri\s+)?(?:end|cuoi)\b`, 'i')
  ].some((pattern) => pattern.test(positionText));
  const explicitBottom = /\b(?:bottom|end|cuoi(?:\s*cung)?|duoi\s*cung)\b\s+(?:of|cua)\s+(?:the\s+)?\b(?:popup|slider|list|danh\s*sach)\b/i.test(positionText);
  const wantsLast = matches(last) || explicitLastPosition || explicitBottom;
  const wantsFirst = matches(first);
  if (wantsLast === wantsFirst) return null;
  return wantsLast ? 'last' : 'first';
}

function normalizeExpiry(raw) {
  if (!raw) return null;
  const iso = raw.match(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  // CRM support tickets serve US websites, so explicit slash dates are read
  // as MM/DD/YYYY. D/M is accepted only when the first number exceeds 12.
  const us = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (us) {
    const first = Number(us[1]);
    const second = Number(us[2]);
    return first > 12 && second <= 12
      ? calendarDate(Number(us[3]), second, first)
      : calendarDate(Number(us[3]), first, second);
  }
  const compact = raw.match(/\b(\d{1,2})[/.](\d{1,2})[/.]((?:20)?\d{2})\b/);
  if (compact) {
    const first = Number(compact[1]);
    const second = Number(compact[2]);
    const year = compact[3].length === 2 ? 2000 + Number(compact[3]) : Number(compact[3]);
    return first > 12 && second <= 12
      ? calendarDate(year, second, first)
      : calendarDate(year, first, second);
  }
  const named = raw.match(/\b([a-z]+)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (named && MONTH_NUMBERS[named[1].toLowerCase()]) {
    return calendarDate(Number(named[3]), MONTH_NUMBERS[named[1].toLowerCase()], Number(named[2]));
  }
  const namedReverse = raw.match(/\b(\d{1,2})\s+([a-z]+)\s+(20\d{2})\b/i);
  if (namedReverse && MONTH_NUMBERS[namedReverse[2].toLowerCase()]) {
    return calendarDate(Number(namedReverse[3]), MONTH_NUMBERS[namedReverse[2].toLowerCase()], Number(namedReverse[1]));
  }
  const namedWithoutYear = raw.match(/\b([a-z]+)\s+(\d{1,2})\b/i);
  if (namedWithoutYear && MONTH_NUMBERS[namedWithoutYear[1].toLowerCase()]) {
    const year = new Date().getUTCFullYear();
    return calendarDate(year, MONTH_NUMBERS[namedWithoutYear[1].toLowerCase()], Number(namedWithoutYear[2]));
  }
  const namedReverseWithoutYear = raw.match(/\b(\d{1,2})\s+([a-z]+)\b/i);
  if (namedReverseWithoutYear && MONTH_NUMBERS[namedReverseWithoutYear[2].toLowerCase()]) {
    const year = new Date().getUTCFullYear();
    return calendarDate(year, MONTH_NUMBERS[namedReverseWithoutYear[2].toLowerCase()], Number(namedReverseWithoutYear[1]));
  }
  const mmdd = raw.match(/\b(\d{1,2})[/.](\d{1,2})\b/);
  if (mmdd) {
    const first = Number(mmdd[1]);
    const second = Number(mmdd[2]);
    const year = new Date().getUTCFullYear();
    if (first >= 1 && first <= 12 && second >= 1 && second <= 31) {
      return calendarDate(year, first, second);
    }
    if (second >= 1 && second <= 12 && first >= 1 && first <= 31) {
      return calendarDate(year, second, first);
    }
  }
  const tg = raw.match(/\bthanksgiving\s*(?:day|ngay|date)?\s*(\d{1,2})\b/i) || raw.match(/\b(\d{1,2})\s*thanksgiving\b/i);
  if (tg) {
    const year = new Date().getUTCFullYear();
    const day = Number(tg[1]);
    if (day >= 1 && day <= 30) return calendarDate(year, 11, day);
  }
  if (/^\s*thanksgiving(?:\s*day)?\s*$/i.test(raw.trim())) {
    const year = new Date().getUTCFullYear();
    return getThanksgivingDate(year);
  }
  return null;
}

function findTicketDate(text, labelPatterns, stopLabelPatterns = []) {
  const folded = foldTicketText(text).replace(/[^\S\r\n]+/g, ' ').trim();
  for (const labelPattern of labelPatterns) {
    const matcher = new RegExp(`${labelPattern}\\s*(?::|=|-|\\bla\\b|\\bis\\b)?\\s*`, 'gi');
    for (const marker of folded.matchAll(matcher)) {
      const tail = folded.slice(marker.index + marker[0].length, marker.index + marker[0].length + 120);
      const date = new RegExp(DATE_TOKEN_SOURCE, 'i').exec(tail);
      if (!date) continue;
      // Date must be directly associated with the label, not arbitrary text in a subsequent clause
      if (date.index > 40) continue;
      const intervening = tail.slice(0, date.index);
      if (/[.!?;]/.test(intervening)) continue;
      if (/[\n\r]/.test(intervening) && /[a-zA-Z]{3,}/.test(intervening)) continue;
      const stopBeforeDate = stopLabelPatterns.some((stopPattern) => {
        const stop = new RegExp(stopPattern, 'i').exec(tail);
        return stop && stop.index < date.index;
      });
      if (!stopBeforeDate) return date[0];
    }
  }
  return null;
}

function findHolidayClosureExpiry(text, year = new Date().getUTCFullYear()) {
  if (!text) return null;
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();

  const hasHoliday = /\b(?:thanksgiving|christmas|xmas|new\s*year'?s?|halloween|le\s*ta\s*on)\b/i.test(folded);
  const closurePattern = /\b(?:thong\s*bao\s*nghi\s*(?:le\s*)?(?:ngay)?|tiem\s*nghi\s*(?:le\s*)?(?:ngay)?|nghi\s*(?:le\s*)?(?:ngay)?|dong\s*cua\s*(?:ngay)?|closed\s*(?:on|for)?|closure\s*(?:on|for)?)\b/i;

  if (!hasHoliday && !closurePattern.test(folded)) return null;

  // Check 1: Thanksgiving with day e.g. "thanksgiving 26", "thanksgiving day 26", "ngay 26 thanksgiving", "nghi ngay thanksgiving 26"
  const tgDay = folded.match(/\b(?:thanksgiving|le\s*ta\s*on)\s*(?:day|ngay|date)?\s*(\d{1,2})\b/i)
    || folded.match(/\b(?:ngay\s*)?(\d{1,2})\s*(?:thanksgiving|le\s*ta\s*on)\b/i);
  if (tgDay) {
    const day = Number(tgDay[1]);
    if (day >= 1 && day <= 30) return calendarDate(year, 11, day);
  }

  // Check 2: Thanksgiving in closure context without explicit day (use 4th Thursday of November)
  if (/\b(?:thanksgiving|le\s*ta\s*on)\b/i.test(folded) && closurePattern.test(folded)) {
    const dayNear = folded.match(/(?:nghi|dong\s*cua|closed)[^.;\n]{0,40}\b(?:ngay\s*)?(\d{1,2})\b/i);
    if (dayNear) {
      const day = Number(dayNear[1]);
      if (day >= 1 && day <= 30) return calendarDate(year, 11, day);
    }
    return getThanksgivingDate(year);
  }

  // Check 3: Christmas
  const xmasDay = folded.match(/\b(?:christmas|xmas)\s*(?:day|ngay)?\s*(\d{1,2})\b/i);
  if (xmasDay) {
    const day = Number(xmasDay[1]);
    if (day >= 1 && day <= 31) return calendarDate(year, 12, day);
  }
  if (/\b(?:christmas|xmas)\b/i.test(folded) && closurePattern.test(folded)) {
    return calendarDate(year, 12, 25);
  }

  // Check 4: Closure with explicit slash/dash/dot date e.g. "nghi ngay 26/11", "closed on 11/26", "tiem nghi 26/11/2026"
  const closureDate = folded.match(/(?:thong\s*bao\s*nghi|tiem\s*nghi|nghi\s*le|nghi\s*ngay|dong\s*cua|closed\s*(?:on|for)?|closure\s*(?:on|for)?)[^.;\n]{0,30}\b(\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)\b/i);
  if (closureDate) {
    const parsed = normalizeExpiry(closureDate[1]);
    if (parsed) return parsed;
  }

  // Check 5: Closure with month name e.g. "closed on november 26", "nghi ngay 26 thang 11"
  const closureNamed = folded.match(/(?:thong\s*bao\s*nghi|tiem\s*nghi|nghi\s*le|nghi\s*ngay|dong\s*cua|closed\s*(?:on|for)?|closure\s*(?:on|for)?)[^.;\n]{0,40}\b(?:(nov(?:ember)?|dec(?:ember)?|jan(?:uary)?|oct(?:ober)?)\s+(\d{1,2})|(\d{1,2})\s+(nov(?:ember)?|dec(?:ember)?|jan(?:uary)?|oct(?:ober)?))\b/i);
  if (closureNamed) {
    const monthStr = closureNamed[1] || closureNamed[4];
    const dayStr = closureNamed[2] || closureNamed[3];
    if (monthStr && dayStr && MONTH_NUMBERS[monthStr.toLowerCase()]) {
      return calendarDate(year, MONTH_NUMBERS[monthStr.toLowerCase()], Number(dayStr));
    }
  }

  return null;
}

function popupRangeFromText(text) {
  const folded = foldTicketText(text).replace(/\s+/g, ' ').trim();
  const startLabel = String.raw`(?:tu(?:\s+ngay)?|from|starts?(?:\s+(?:date|time))?|bat\s+dau|popup\s+(?:start|show)|show(?:\s+(?:from|on))?|display(?:\s+(?:from|on))?|dang(?:\s+(?:tu|ngay))?|hien\s+thi(?:\s+(?:tu|from))?|nghi\s+tu|dong\s+cua\s+tu|closed\s+from)`;
  const endLabel = String.raw`(?:den(?:\s+(?:ngay|het))?|toi(?:\s+(?:ngay|het))?|to|until|through|thru|till|ends?(?:\s+(?:date|time))?|ket\s+thuc|go(?:\s+xuong)?|remove(?:\s+(?:on|date))?|expires?|exp(?:iry|iration)?|mo\s+cua\s+lai(?:\s+vao\s+ngay)?|reopen\s+on)`;
  const matcher = new RegExp(`${startLabel}\\s*(?::|=|-)?\\s*(${DATE_TOKEN_SOURCE})([\\s\\S]{0,96}?)${endLabel}\\s*(?::|=|-)?\\s*(${DATE_TOKEN_SOURCE})`, 'gi');
  const range = matcher.exec(folded);
  if (!range) return null;
  return { start: range[1], end: range[3], evidence: range[0] };
}

function reconcilePopupRange(startDate, endDate, hasExplicitRange) {
  if (!startDate || !endDate || endDate >= startDate) return { endDate, yearRolledOver: false, error: null };
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [, endMonth, endDay] = endDate.split('-').map(Number);
  const nextYearEnd = calendarDate(startYear + 1, endMonth, endDay);
  const startAt = Date.parse(`${startDate}T00:00:00Z`);
  const endAt = nextYearEnd ? Date.parse(`${nextYearEnd}T00:00:00Z`) : NaN;
  const days = Number.isFinite(endAt) ? Math.round((endAt - startAt) / 86400000) : Infinity;
  if (hasExplicitRange && nextYearEnd && days > 0 && days <= 190 && startMonth >= 7) {
    return { endDate: nextYearEnd, yearRolledOver: true, error: null };
  }
  return {
    endDate,
    yearRolledOver: false,
    error: 'Popup end date is before its start date and the ticket does not provide a safe cross-year range.'
  };
}

function lastCalendarDayOfMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function ticketReferenceDate(text) {
  const matches = String(text || '').matchAll(new RegExp(DATE_TOKEN_SOURCE, 'gi'));
  for (const match of matches) {
    const date = normalizeExpiry(match[0]);
    if (date) return date;
  }
  return null;
}

function endOfMonthExpiryFromTicket(text) {
  const folded = foldTicketText(text).replace(/\s+/g, ' ').trim();
  const numeric = /(?:\b(?:den|toi|to|until|through|thru|till)\s+)?(?:het|cuoi|end\s+of)\s+(?:thang|month)\s+(\d{1,2})\b/i.exec(folded);
  const named = /(?:\b(?:den|toi|to|until|through|thru|till)\s+)?(?:end\s+of)\s+(?:the\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(folded);
  const month = numeric ? Number(numeric[1]) : (named ? MONTH_NUMBERS[named[1].toLowerCase()] : null);
  if (!month || month < 1 || month > 12) return null;
  const reference = ticketReferenceDate(text);
  if (!reference) return null;
  const [referenceYear, referenceMonth] = reference.split('-').map(Number);
  const year = month < referenceMonth ? referenceYear + 1 : referenceYear;
  const date = lastCalendarDayOfMonth(year, month);
  return date ? { date, evidence: (numeric || named)[0] } : null;
}

function extractPopupLink(text) {
  const raw = String(text || '');
  const isCrmUrl = (url) => /^(?:https?:\/\/)?(?:crm|jira|api)\.fastboy\./i.test(url);

  // Must explicitly ask to link/direct the popup poster to a URL.
  // Exclude salon website / domain lines: "Link website:", "Website:", "Domain:", "Web:"
  const linkActionPattern = /(?:(?:direct\s+(?:to|toi|tới|den|đến)\s*(?:link\b)?)|(?:(?:gắn|gan|chèn|chen|add|attach)\s+(?:link|url)?\s*(?:cho\s+popup|vào\s+popup|booking)?)|(?:(?:bấm|click)\s+vào\s+popup[^.\n]*?)|(?:(?:link\s+(?:booking|popup|poster|image|hinh|ảnh))|(?:(?:booking|popup|poster)\s+link))|(?:(?:pop\s*up|poster)\b[^.\n]*?\bvà\s+link))\s*[:=-]?\s*[^.;\n]{0,100}?(https?:\/\/[^\s<>"']+)/i;

  const match = linkActionPattern.exec(raw);
  if (match) {
    const candidate = match[1].replace(/[.,;)]+$/, '');
    if (!isCrmUrl(candidate)) return candidate;
  }

  return null;
}

function hasExplicitPopupStartDate(text) {
  const folded = foldTicketText(text).toLowerCase();
  return /\b(?:time\s*start|start\s*(?:date|time)|popup\s*start|show\s+from|display\s+from|(?:dang|len|hien|show)\s*(?:pop\s*up|poster|banner)?\s*tu\s*ngay|hen\s*(?:ngay|gio|lich)?.*(?:moi\s*)?(?:len|dang|hien|pop\s*up)|ngay\s*(?:bat\s*dau\s*)?(?:len|dang|hien)\s*popup|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\s*moi\s*(?:len|dang|hien|pop\s*up))\b/i.test(folded);
}

function ticketData(body, ticketUrl) {
  const raw = String(body || '');
  const activeRaw = activeTicketRequestText(raw);
  const text = activeRaw.replace(/\s+/g, ' ').trim();
  const ticketNumber = new URL(ticketUrl).pathname.match(/\/tickets\/detail\/(\d+)/i)?.[1] || null;
  const beforeCurrentTicket = ticketNumber && raw.includes(`#${ticketNumber}`)
    ? raw.slice(0, raw.indexOf(`#${ticketNumber}`))
    : '';
  const TITLE_ID_PATTERN = /(?:(?:\bID\s*(?:#\s*|[-:]\s*)?(\d{2,}))|(?:(?:^|\n)\s*(\d{3,6})))\s*-\s*[^\n#]*/gi;
  const matchTitleId = (match) => match[1] || match[2] || null;
  const titledIds = [...beforeCurrentTicket.matchAll(TITLE_ID_PATTERN)].map(matchTitleId).filter(Boolean);
  const beforeTicketSiteId = titledIds.at(-1) || null;
  const panelTitleIds = [...raw.matchAll(TITLE_ID_PATTERN)].map(matchTitleId).filter(Boolean);
  const isolatedPanelSiteId = panelTitleIds.length === 1 ? panelTitleIds[0] : null;
  const titleSiteId = beforeTicketSiteId || isolatedPanelSiteId;
  const labelledSiteId = [
    /(?:website|site|project)\s*(?:id|#)\s*[:#-]?\s*(\d{2,})/i,
    /(?:id\s*(?:website|site|project))\s*[:#-]?\s*(\d{2,})/i
  ].map((rule) => raw.replace(/\s+/g, ' ').match(rule)?.[1]).find(Boolean) || null;
  const isIndefinite = hasIndefiniteScheduleInstruction(activeRaw);
  const expiry = isIndefinite ? null : (/\b(?:exp(?:\.|\b)|expiry\b|expiration\b|expires?\b|end\s*date\b)\s*[:\-]?\s*([^|\n]{3,50})/i.exec(text)?.[1]?.trim() || null);
  const fromPattern = String.raw`\bfrom\s*(?:date|time)?\s*[:=-]|\bfrom\s+(?:date|time)\b|\bfrom(?=\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?(?:${DATE_TOKEN_SOURCE}))`;
  const start = isIndefinite ? null : findTicketDate(activeRaw, [
    String.raw`\b(?:time\s*start|start\s*(?:date|time)?|popup\s*start|ngay\s*(?:bat\s*dau|dang|hien)|thoi\s*gian\s*(?:bat\s*dau|hien)|tu\s+ngay|hen(?:\s+(?:ngay|gio|lich))?)\b`,
    fromPattern
  ], [String.raw`\b(?:time\s*end|end\s*(?:date|time)?|exp(?:iry|iration)?|expires?|ngay\s*(?:het\s*han|ket\s*thuc)|den\s*(?:het|ngay)|toi\s*het|until)\b`]);
  const holidayClosureLabel = String.raw`\b(?:thong\s*bao\s*nghi\s*(?:le\s*)?(?:ngay)?|tiem\s*nghi\s*(?:le\s*)?(?:ngay)?|nghi\s*(?:le\s*)?(?:ngay)?|dong\s*cua\s*(?:ngay)?|closed\s*(?:on|for)?|closure\s*(?:on|for)?)\b`;
  const parsedExpiry = isIndefinite ? null : (findTicketDate(activeRaw, [
    String.raw`\b(?:time\s*end|end\s*(?:date|time)?|exp(?:iry|iration)?|expires?|popup\s*(?:end|expiry)|ngay\s*(?:het\s*han|ket\s*thuc)|thoi\s*gian\s*(?:het\s*han|ket\s*thuc)|den\s*(?:het|ngay)|toi\s*het|han\s*(?:toi|den)|until|through|schedule\s*(?:go|remove|end)|lich\s*go|hen\s*(?:gio\s*)?go|go\s*(?:pop\s*up\s*)?vao(?:\s+cuoi)?\s*ngay|remove(?:\s+popup)?\s+on|(?:an|tat|go)\s*sau(?:\s*ngay)?|sau\s*ngay|(?:an|tat|go)\s*(?:vao\s*ngay|ngay|vao)|(?:hide|turn\s*off|take\s*down)\s*(?:after|on))\b`,
    holidayClosureLabel
  ]) || expiry);
  const hasExplicitStart = !isIndefinite && hasExplicitPopupStartDate(activeRaw);
  const range = isIndefinite ? null : popupRangeFromText(text);
  const holidayExpiry = isIndefinite ? null : findHolidayClosureExpiry(activeRaw);
  const popupStart = hasExplicitStart ? (range?.start || start) : null;
  const inferredMonthEnd = isIndefinite ? null : endOfMonthExpiryFromTicket(text);
  const popupEnd = range?.end || parsedExpiry || holidayExpiry || inferredMonthEnd?.date || null;
  const popupStartDate = hasExplicitStart ? normalizeExpiry(popupStart) : null;
  const popupEndDate = normalizeExpiry(popupEnd) || inferredMonthEnd?.date || null;
  const rangeState = isIndefinite
    ? { startDate: null, endDate: null, yearRolledOver: false, error: null }
    : reconcilePopupRange(popupStartDate, popupEndDate, Boolean(range || (start && parsedExpiry)));
  // Keep ticket line/clause boundaries for action parsing. CRM headers such
  // as "Update website" must not be joined to a later popup-removal sentence.
  const folded = foldTicketText(activeRaw);
  const popupPosition = requestedPopupPosition(activeRaw);
  const popupDuration = extractPopupDuration(activeRaw);
  const popupRequested = /\b(?:pop[ -]?up|announcement|poster|banner)\b/i.test(text);
  // Vietnamese removal verbs must be adjacent to the entity. This prevents
  // "hoan tat design poster" from being read as "tat poster".
  const removesExpiredPopups = hasAffirmativeExpiredRemoval(folded);
  const removesExistingPopupPoster = hasAffirmativePopupRemoval(folded);
  const addsOrUpdatesPopup = hasAffirmativePopupUpdate(folded);
  const hasPosterUpload = hasAffirmativePosterUpload(folded);
  const isScheduledRemoval = /\b(?:schedule|lich|hen(?:\s+gio)?)\s+go\b/i.test(folded);
  const replaceExistingPopup = hasAffirmativePopupReplace(folded) && !isScheduledRemoval;
  const removesAllExistingPopups = removesExistingPopupPoster && explicitRemoveAllRequested(folded);
  // Mixed-action case: ticket adds new poster(s) AND removes an existing one.
  // In this case the dominant action is 'create'; the removal is handled
  // in-line via isRemovalReference attachment candidates. Only fall back to
  // 'remove-one'/'remove-all' when no new poster is being added.
  const hasInlineRemovalRequest = removesExistingPopupPoster && addsOrUpdatesPopup && !replaceExistingPopup && !isScheduledRemoval;
  let popupAction;
  if (replaceExistingPopup) {
    popupAction = 'replace';
  } else if (removesExpiredPopups && !addsOrUpdatesPopup && !removesAllExistingPopups && !hasPosterUpload) {
    popupAction = 'remove-expired';
  } else if (removesExistingPopupPoster && !isScheduledRemoval && !addsOrUpdatesPopup) {
    popupAction = removesAllExistingPopups ? 'remove-all' : 'remove-one';
  } else if (popupDuration && !hasPosterUpload && !replaceExistingPopup && !removesExistingPopupPoster) {
    popupAction = 'update-duration';
  } else {
    popupAction = 'create';
  }
  const popupLink = extractPopupLink(activeRaw);
  return {
    siteId: titleSiteId || labelledSiteId,
    start: popupStart,
    startDate: popupStartDate,
    expiry: popupEnd,
    expiryDate: rangeState.endDate,
    scheduleSource: isIndefinite ? 'ticket-indefinite' : (range ? 'explicit-range' : (inferredMonthEnd ? 'ticket-month-end' : (popupStart || popupEnd ? 'labels' : null))),
    scheduleEvidence: isIndefinite ? 'Đến khi khách tắt / Không cài hạn' : (range?.evidence || inferredMonthEnd?.evidence || null),
    endYearRolledOver: rangeState.yearRolledOver,
    scheduleError: rangeState.error,
    popupRequested,
    popupPosition,
    popupAction,
    hasInlineRemovalRequest,
    popupLink,
    popupDuration,
    isIndefinite
  };
}

function isPopupRemovalAction(action) {
  return action === 'remove-one' || action === 'remove-all';
}

function popupActionNeedsTicketImage(action, attachmentCount = null) {
  if (action === 'create' || action === 'replace') return true;
  if (action === 'remove-one') {
    if (attachmentCount !== null) return attachmentCount > 0;
    return true;
  }
  return false;
}

function resolveRemovalScopeFromAttachments(ticket, attachmentCandidates) {
  const current = { ...(ticket || {}) };
  if (current.popupAction !== 'remove-one') return current;
  const count = Array.isArray(attachmentCandidates) ? attachmentCandidates.length : 0;
  if (count === 0) {
    // Missing attachment detection is never evidence that the ticket asks to
    // delete everything. Keep remove-one so the downloader can recover a
    // hidden attachment, or stop safely without mutating CMS.
    current.removalScope = 'ticket-image-missing-remove-one';
  } else {
    current.removalScope = 'ticket-image-remove-one';
  }
  return current;
}

function popupScheduleFromTicket(ticket, expiryOverride = null) {
  const isIndefinite = Boolean(ticket?.isIndefinite);
  const startDate = isIndefinite ? null : (ticket?.startDate || null);
  const endDate = isIndefinite ? null : (expiryOverride || ticket?.expiryDate || null);
  return {
    start: startDate ? { date: startDate } : null,
    end: endDate ? { date: endDate } : null,
    isIndefinite
  };
}

module.exports = {
  actionIsNegated,
  DATE_TOKEN_SOURCE,
  MONTH_NUMBERS,
  calendarDate,
  foldTicketText,
  isCompletionReplyComment,
  parseConversationComments,
  activeTicketRequestText,
  hasAffirmativePopupRemoval,
  hasAffirmativeExpiredRemoval,
  hasAffirmativePopupUpdate,
  hasAffirmativePopupReplace,
  explicitRemoveAllRequested,
  hasMultiPosterIntent,
  keepsExistingPopups,
  extractPopupOrderSequence,
  requestedAspectRatio,
  hasSizeOrReuploadInstruction,
  hasIndefiniteScheduleInstruction,
  requestedPopupPosition,
  normalizeExpiry,
  findTicketDate,
  findHolidayClosureExpiry,
  getThanksgivingDate,
  popupRangeFromText,
  reconcilePopupRange,
  endOfMonthExpiryFromTicket,
  extractPopupLink,
  hasExplicitPopupStartDate,
  ticketData,
  isPopupRemovalAction,
  popupActionNeedsTicketImage,
  resolveRemovalScopeFromAttachments,
  popupScheduleFromTicket,
  POPUP_OPEN_DELAY_SECONDS,
  extractPopupDuration,
  hasAffirmativePosterUpload
};
