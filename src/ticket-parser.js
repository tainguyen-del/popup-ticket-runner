'use strict';

const MONTH_NUMBERS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
  october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const DATE_TOKEN_SOURCE = String.raw`(?:\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.](?:20)?\d{2}\b|\b\d{1,2}[/.]\d{1,2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s*(?:20\d{2})?\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+20\d{2})?\b)`;

function calendarDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
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

function hasAffirmativePopupRemoval(text) {
  const folded = foldTicketText(text).replace(/[\t\r\f\v ]+/g, ' ').trim();
  const entity = String.raw`(?:pop[\s-]*ups?|announcements?|posters?|banners?|halloween|holiday)`;
  if (!new RegExp(String.raw`\b${entity}\b`, 'i').test(folded)) return false;
  const patterns = [
    new RegExp(String.raw`\b(?:go|xoa|tat|thay)\s+(?:(?:toan\s+bo|tat\s+ca)\s+)?${entity}\b`, 'gi'),
    new RegExp(String.raw`\b(?:remove|delete|replace|turn\s+off)\b[^.;]{0,40}\b${entity}\b`, 'gi'),
    /\b(?:remove|delete|turn\s+off)\b[^.;]{0,20}\b(?:this|that|attached)\s+(?:one|image)\b/gi
  ];
  return patterns.some((pattern) => {
    for (const match of folded.matchAll(pattern)) {
      if (!actionIsNegated(folded, match.index)) {
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
  const actionPattern = /\b(?:add(?:ed)?|creat(?:e|ed)|updat(?:e|ed)|replac(?:e|ed)|upload(?:ed)?|publish(?:ed)?|launch(?:ed)?|setup|set\s+up|them|tao|cap\s*nhat|thay|dang|cai(?:\s+dat)?)\b/gi;
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
      const { end } = clauseBounds(folded, match.index);
      const tail = folded.slice(match.index + match[0].length, end);
      if (/\b(?:except|but\s+keep|leave|tru|ngoai\s+tru)\b/i.test(tail)) continue;
      return true;
    }
  }
  return false;
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
  return null;
}

function findTicketDate(text, labelPatterns, stopLabelPatterns = []) {
  const folded = foldTicketText(text).replace(/\s+/g, ' ').trim();
  for (const labelPattern of labelPatterns) {
    const matcher = new RegExp(`${labelPattern}\\s*(?::|=|-|\\bla\\b|\\bis\\b)?\\s*`, 'gi');
    for (const marker of folded.matchAll(matcher)) {
      const tail = folded.slice(marker.index + marker[0].length, marker.index + marker[0].length + 120);
      const date = new RegExp(DATE_TOKEN_SOURCE, 'i').exec(tail);
      if (!date) continue;
      const stopBeforeDate = stopLabelPatterns.some((stopPattern) => {
        const stop = new RegExp(stopPattern, 'i').exec(tail);
        return stop && stop.index < date.index;
      });
      if (!stopBeforeDate) return date[0];
    }
  }
  return null;
}

function popupRangeFromText(text) {
  const folded = foldTicketText(text).replace(/\s+/g, ' ').trim();
  const startLabel = String.raw`(?:tu(?:\s+ngay)?|from|starts?(?:\s+(?:date|time))?|bat\s+dau|popup\s+(?:start|show)|show(?:\s+(?:from|on))?|display(?:\s+(?:from|on))?|dang(?:\s+(?:tu|ngay))?|hien\s+thi(?:\s+(?:tu|from))?)`;
  const endLabel = String.raw`(?:den(?:\s+(?:ngay|het))?|toi(?:\s+(?:ngay|het))?|to|until|through|thru|till|ends?(?:\s+(?:date|time))?|ket\s+thuc|go(?:\s+xuong)?|remove(?:\s+(?:on|date))?|expires?|exp(?:iry|iration)?)`;
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

function ticketData(body, ticketUrl) {
  const raw = String(body || '');
  const text = raw.replace(/\s+/g, ' ').trim();
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
  ].map((rule) => text.match(rule)?.[1]).find(Boolean) || null;
  const expiry = /(?:exp(?:iry|iration)?|expires?|end\s*date)\s*[:\-]?\s*([^|\n]{3,50})/i.exec(text)?.[1]?.trim() || null;
  const start = findTicketDate(text, [
    String.raw`\b(?:time\s*start|start\s*(?:date|time)?|popup\s*start|ngay\s*(?:bat\s*dau|dang|hien)|thoi\s*gian\s*(?:bat\s*dau|hien)|tu\s+ngay|from)\b`
  ], [String.raw`\b(?:time\s*end|end\s*(?:date|time)?|exp(?:iry|iration)?|expires?|ngay\s*(?:het\s*han|ket\s*thuc)|den\s*(?:het|ngay)|toi\s*het|until)\b`]);
  const parsedExpiry = findTicketDate(text, [
    String.raw`\b(?:time\s*end|end\s*(?:date|time)?|exp(?:iry|iration)?|expires?|popup\s*(?:end|expiry)|ngay\s*(?:het\s*han|ket\s*thuc)|thoi\s*gian\s*(?:het\s*han|ket\s*thuc)|den\s*(?:het|ngay)|toi\s*het|until|through|schedule\s*(?:go|remove|end)|lich\s*go|hen\s*(?:gio\s*)?go|go\s*(?:pop\s*up\s*)?vao(?:\s+cuoi)?\s*ngay|remove(?:\s+popup)?\s+on)\b`
  ]) || expiry;
  const range = popupRangeFromText(text);
  const popupStart = range?.start || start;
  const inferredMonthEnd = endOfMonthExpiryFromTicket(text);
  const popupEnd = range?.end || parsedExpiry || inferredMonthEnd?.date || null;
  const popupStartDate = normalizeExpiry(popupStart);
  const popupEndDate = normalizeExpiry(popupEnd) || inferredMonthEnd?.date || null;
  const rangeState = reconcilePopupRange(popupStartDate, popupEndDate, Boolean(range || (start && parsedExpiry)));
  // Keep ticket line/clause boundaries for action parsing. CRM headers such
  // as "Update website" must not be joined to a later popup-removal sentence.
  const folded = foldTicketText(raw);
  const popupPosition = requestedPopupPosition(raw);
  const popupRequested = /\b(?:pop[ -]?up|announcement|poster|banner)\b/i.test(text);
  // Vietnamese removal verbs must be adjacent to the entity. This prevents
  // "hoan tat design poster" from being read as "tat poster".
  const removesExistingPopupPoster = hasAffirmativePopupRemoval(folded);
  const addsOrUpdatesPopup = hasAffirmativePopupUpdate(folded);
  const isScheduledRemoval = /\b(?:schedule|lich|hen(?:\s+gio)?)\s+go\b/i.test(folded);
  const replaceExistingPopup = removesExistingPopupPoster && addsOrUpdatesPopup && !isScheduledRemoval;
  const removesAllExistingPopups = removesExistingPopupPoster && explicitRemoveAllRequested(folded);
  return {
    siteId: titleSiteId || labelledSiteId,
    start: popupStart,
    startDate: popupStartDate,
    expiry: popupEnd,
    expiryDate: rangeState.endDate,
    scheduleSource: range ? 'explicit-range' : (inferredMonthEnd ? 'ticket-month-end' : (popupStart || popupEnd ? 'labels' : null)),
    scheduleEvidence: range?.evidence || inferredMonthEnd?.evidence || null,
    endYearRolledOver: rangeState.yearRolledOver,
    scheduleError: rangeState.error,
    popupRequested,
    popupPosition,
    popupAction: replaceExistingPopup
      ? 'replace'
      : (removesExistingPopupPoster && !isScheduledRemoval
        ? (removesAllExistingPopups ? 'remove-all' : 'remove-one')
        : 'create')
  };
}

function isPopupRemovalAction(action) {
  return action === 'remove-one' || action === 'remove-all';
}

function popupActionNeedsTicketImage(action) {
  return action === 'create' || action === 'replace' || action === 'remove-one';
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
  const startDate = ticket?.startDate || null;
  const endDate = expiryOverride || ticket?.expiryDate || null;
  return {
    start: startDate ? { date: startDate } : null,
    end: endDate ? { date: endDate } : null
  };
}

module.exports = {
  DATE_TOKEN_SOURCE,
  MONTH_NUMBERS,
  calendarDate,
  foldTicketText,
  hasAffirmativePopupRemoval,
  hasAffirmativePopupUpdate,
  explicitRemoveAllRequested,
  requestedPopupPosition,
  normalizeExpiry,
  findTicketDate,
  popupRangeFromText,
  reconcilePopupRange,
  endOfMonthExpiryFromTicket,
  ticketData,
  isPopupRemovalAction,
  popupActionNeedsTicketImage,
  resolveRemovalScopeFromAttachments,
  popupScheduleFromTicket
};
