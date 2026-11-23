// The textbook pane: a second PDF beside the slides. The tutor cites it as [Book p.N]; clicking a citation scrolls here.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const $ = (s) => document.querySelector(s);
const H = { 'X-SlideMate': '1' };
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const book = { pdf: null, path: '', pages: [], current: 1, observer: null, scale: 1, base: null, token: 0, pin: 0 };
const BOOK_RE = /\[?\bBook\s+pp?\.\s*(\d{1,4})(?:\s*[–—-]\s*(\d{1,4}))?\]?/g;

const refit = () => window.dispatchEvent(new Event('resize'));  // the slides re-fit when the layout changes

function setOpen(open) {
  document.body.classList.toggle('book-open', open);
  $('#btnBook').setAttribute('aria-expanded', String(open));
  store.set('bookOpen', open);
  if (open && !book.pdf && book.path) load(book.path);
  else if (open && book.pdf) rescale();
  refit();
}
function setSide(side) {
  document.body.classList.toggle('book-left', side === 'left');
  store.set('bookSide', side);
  document.querySelectorAll('#bookSideSeg [data-side]').forEach((b) => {
    const selected = b.dataset.side === side;
    b.classList.toggle('on', selected);
    b.setAttribute('aria-pressed', String(selected));
  });
  refit();
}
function setWidth(w, save = true) {
  w = Math.round(Math.max(280, Math.min(innerWidth * 0.6, w)));
  document.documentElement.style.setProperty('--book-w', w + 'px');
  if (save) store.set('bookW', w);
}

async function status() {
  try { return await (await api('/api/book')).json(); } catch { return { path: '', pages: 0 }; }
}

function load(path) {
  if (book.loading && path === book.path) return book.loading;
  const pending = loadDocument(path).finally(() => {
    if (book.loading === pending) book.loading = null;
  });
  book.loading = pending;
  return pending;
}

async function loadDocument(path) {
  const token = ++book.token;
  const viewer = $('#bookViewer');
  if (path !== book.path) setReadingGuide(null);
  clearSource();
  viewer.innerHTML = '';
  for (const p of book.pages) releasePage(p);
  book.pages = [];
  $('#bookNav').hidden = true;
  $('#bookTitle').removeAttribute('title');
  if (book.observer) book.observer.disconnect();
  if (book.pdf) { book.pdf.destroy(); book.pdf = null; }
  book.path = path;
  $('#bookPick').hidden = !path;
  $('#bookRemove').hidden = !path;
  $('#bookEmpty').hidden = !!path;
  if (!path) { $('#bookTitle').textContent = 'Textbook'; $('#bookNav').hidden = true; return; }
  $('#bookTitle').textContent = 'Opening textbook…';
  let doc, first;
  try {
    doc = await pdfjsLib.getDocument({ url: '/api/pdf?path=' + encodeURIComponent(path), httpHeaders: H }).promise;
    first = await doc.getPage(1);
  } catch {
    doc?.destroy();
    if (token !== book.token) return;
    $('#bookEmpty').hidden = false;
    $('#bookTitle').textContent = 'Couldn’t open the textbook';
    return;
  }
  if (token !== book.token) { doc.destroy(); return; }
  book.pdf = doc;
  $('#bookNav').hidden = false;
  $('#bookTitle').textContent = path.split('/').pop().replace(/\.pdf$/i, '');
  $('#bookTitle').title = $('#bookTitle').textContent;
  $('#bookTotal').textContent = doc.numPages;
  $('#bookPage').max = doc.numPages;
  book.base = first.getViewport({ scale: 1 });
  book.scale = fitScale();
  book.observer = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: '600px 0px' });
  for (let i = 1; i <= doc.numPages; i++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = i;
    div.style.width = book.base.width * book.scale + 'px';
    div.style.height = book.base.height * book.scale + 'px';
    viewer.append(div);
    book.pages.push({ div, rendered: 0 });
    book.observer.observe(div);
  }
  const saved = store.get('bookPage:' + path, 1);
  goTo(saved, false);
}

const fitScale = () => Math.max(0.2, ($('#bookViewer').clientWidth - 24) / (book.base?.width || 612));

function rescale() {
  if (!book.pdf || !$('#bookViewer').clientWidth) return;
  const s = fitScale();
  if (Math.abs(s - book.scale) < 0.01) return;
  const keep = book.current;
  book.scale = s;
  for (const p of book.pages) {
    p.div.style.width = book.base.width * s + 'px';
    p.div.style.height = book.base.height * s + 'px';
    releasePage(p);
  }
  goTo(keep, false);
  for (const p of book.pages) if (p.visible) renderPage(+p.div.dataset.page);
}

function onIntersect(entries) {
  for (const e of entries) {
    const n = +e.target.dataset.page;
    const p = book.pages[n - 1];
    if (p?.div !== e.target) continue;
    p.visible = e.isIntersecting;
    if (e.isIntersecting) renderPage(n);
    else releasePage(p);
  }
  trackCurrent();
}

function releasePage(p) {
  p.task?.cancel();
  p.task = null;
  p.generation = (p.generation || 0) + 1;
  p.rendered = 0;
  p.div.replaceChildren();
}

async function renderPage(n) {
  const p = book.pages[n - 1];
  if (!p || p.rendered === book.scale) return;
  const scale = book.scale;
  p.rendered = scale;
  const generation = p.generation;
  try {
    const page = await book.pdf.getPage(n);
    if (p.generation !== generation) return;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (vp.width * vp.height)));
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
    p.task = page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    await p.task.promise;
    if (p.generation !== generation) return;  // resized while rendering
    p.div.style.setProperty('--scale-factor', vp.scale);
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    await new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: tl, viewport: vp }).render();
    if (p.generation !== generation) return;
    p.div.replaceChildren(c, tl);
    markReadingPage(n, tl);
  } catch (err) {
    if (p.generation === generation) {
      p.rendered = 0;
      p.div.textContent = 'Couldn’t render this page.';
      console.warn('Textbook page', n, err);
    }
  } finally {
    if (p.generation === generation) p.task = null;
  }
}

function trackCurrent() {
  if (performance.now() < book.pin) return;
  const root = $('#bookViewer').getBoundingClientRect();
  const mid = root.top + root.height * 0.35;
  let best = book.current, dist = Infinity;
  for (const p of book.pages) {
    if (!p.visible) continue;
    const r = p.div.getBoundingClientRect();
    const d = mid >= r.top && mid <= r.bottom ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
    if (d < dist) { dist = d; best = +p.div.dataset.page; }
  }
  setCurrent(best);
}

function setCurrent(n) {
  book.current = n;
  $('#bookPrev').disabled = n <= 1;
  $('#bookNext').disabled = n >= book.pages.length;
  const input = $('#bookPage');
  if (document.activeElement !== input) input.value = n;
  store.set('bookPage:' + book.path, n);
}

function goTo(n, smooth = true) {
  if (!book.pdf) return;
  n = Math.max(1, Math.min(book.pdf.numPages, Math.round(+n) || 1));
  const div = book.pages[n - 1].div, viewer = $('#bookViewer');
  book.pin = performance.now() + (smooth ? 900 : 200);
  viewer.scrollTo({ top: div.offsetTop - 8, behavior: smooth ? 'smooth' : 'instant' });
  setCurrent(n);
  document.querySelectorAll('#bookViewer .page.cited').forEach((d) => d.classList.remove('cited'));
  div.classList.add('cited');
  setTimeout(() => div.classList.remove('cited'), 2500);
}

// PDF.js splits text across positioned spans. Keep offsets into the original text so
// a quotation spanning several lines underlines just the characters it matched.
function normalizedChar(char) {
  return char.normalize('NFKC').toLowerCase()
    .replace(/[\s\u00ad]/gu, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

// A page-only citation carries no exact quote. Find related wording on that
// page, using the paragraph or table cell containing the particular citation.
const commonWords = new Set(('about after also among another because before being book books chapter cited describes does each excerpt excerpts explains first from have helps including into made many more most names other page point provide provided provides says shows slide some such support supported supports supplied team text textbook than that their them then these they this those through used uses using what when where which while with would').split(' '));

function keywords(value) {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(word => word.length > 2 && !commonWords.has(word))
    .map(word => word.replace(/(?:ies|s)$/, ending => ending === 'ies' ? 'y' : '')));
}

function relatedPassage(pageText, claim) {
  const terms = keywords(claim);
  const sentences = (pageText.match(/[^.!?]+(?:[.!?]+|$)/g) || [])
    .map(sentence => ({ sentence, words: keywords(sentence) }));
  let best = '', high = 0;
  for (const { sentence, words } of sentences) {
    const shared = [...terms].filter(term => words.has(term));
    if (shared.length < 2) continue;
    const score = shared.reduce((sum, term) => {
      const frequency = sentences.filter(other => other.words.has(term)).length;
      return sum + Math.log(1 + sentences.length / frequency);
    }, 0) / Math.pow(Math.max(8, words.size), 0.25);
    if (score > high) { best = sentence.trim(); high = score; }
  }
  return best;
}

function setReadingGuide(guide) {
  book.guide = guide;
  $('#bookGuide').hidden = !guide;
  if (!guide) return;
  const { start, end, keys, index } = guide;
  $('#bookRange').textContent = start === end ? 'Page ' + start : 'Pages ' + start + '–' + end;
  $('#bookKeyCount').textContent = keys.length ? 'Key passage ' + (index + 1) + ' of ' + keys.length : '';
  $('#bookKeyPrev').hidden = $('#bookKeyNext').hidden = keys.length < 2;
  $('#bookKeyPrev').disabled = index <= 0;
  $('#bookKeyNext').disabled = index >= keys.length - 1;
}

function openKey(index) {
  const guide = book.guide;
  const key = guide?.keys[index];
  if (!key) return;
  setReadingGuide({ ...guide, index });
  return openBookPage(key.page, key.quote, key.claim);
}

function citationClaim(link) {
  const container = link.closest('td, li, p, blockquote') || link.parentElement;
  const preceding = document.createRange();
  preceding.selectNodeContents(container);
  preceding.setEndBefore(link);
  return preceding.toString().split(/\[Book p\.\d+\]/i).pop().slice(-1200);
}

export function showBookCitation(link) {
  const reply = link.closest('.msg, .ct-msg') || link.closest('table, ul, ol, p') || link.parentElement;
  const links = [...reply.querySelectorAll('a.book-ref')];
  const page = +link.dataset.bookPage;
  const range = link.dataset.bookEnd ? link : links.slice(0, links.indexOf(link)).reverse()
    .find(a => a.dataset.bookEnd && +a.dataset.bookPage <= page && page <= +a.dataset.bookEnd);
  if (range) {
    const start = +range.dataset.bookPage, end = +range.dataset.bookEnd;
    const keys = links.filter(a => !a.dataset.bookEnd && +a.dataset.bookPage >= start && +a.dataset.bookPage <= end
      && (a.dataset.bookQuote || citationClaim(a).trim()));
    const index = Math.max(0, keys.indexOf(link));
    setReadingGuide({ start, end, index, keys: keys.map(a => ({ page: +a.dataset.bookPage, quote: a.dataset.bookQuote, claim: citationClaim(a) })) });
    if (keys.length && (range === link || keys.includes(link))) return openKey(index);
    if (range === link) return openBookPage(start);
  } else {
    setReadingGuide(null);
  }
  return openBookPage(+link.dataset.bookPage, link.dataset.bookQuote, citationClaim(link));
}

function markReadingPage(n, layer) {
  const active = book.source?.page === n ? book.source : null;
  if (active) markSource(layer, active, true);
  const seen = new Set([active?.quote || active?.claim]);
  for (const key of book.guide?.keys || []) {
    const passage = key.quote || key.claim;
    if (key.page === n && !seen.has(passage)) {
      seen.add(passage);
      markSource(layer, key, false);
    }
  }
}

function markSource(layer, source, active) {
  const spans = [...layer.querySelectorAll('span:not(.markedContent)')];
  const quote = source.quote || relatedPassage(spans.map(span => span.textContent).join(' '), source.claim);
  const needle = Array.from(quote, normalizedChar).join('');
  let text = '';
  const offsets = [];
  for (const span of spans) {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      let offset = 0;
      for (const char of node.data) {
        const folded = normalizedChar(char);
        for (let i = 0; i < folded.length; i++) offsets.push({ node, start: offset, end: offset + char.length });
        text += folded;
        offset += char.length;
      }
    }
  }
  const start = text.indexOf(needle);
  if (!needle || start < 0 || text.indexOf(needle, start + 1) !== -1) {
    if (active) $('#bookSourceHint').textContent = 'Opened the cited page. The exact passage could not be located.';
    return;
  }
  if (active) $('#bookSourceHint').textContent = source.quote ? '' : 'Related wording on the cited page';
  const matched = offsets.slice(start, start + needle.length);
  let firstMark;
  for (let i = 0; i < matched.length;) {
    const first = matched[i++];
    let end = first.end;
    while (i < matched.length && matched[i].node === first.node) end = matched[i++].end;
    if (first.node.parentElement.closest('mark.book-source')) continue;
    const range = document.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(first.node, end);
    const mark = document.createElement('mark');
    mark.className = 'book-source';
    range.surroundContents(mark);
    if (!firstMark && mark.textContent.trim().length >= 2) firstMark = mark;
  }
  if (source.scroll && firstMark) {
    source.scroll = false;
    const viewer = $('#bookViewer');
    viewer.scrollTop += firstMark.getBoundingClientRect().top - viewer.getBoundingClientRect().top - viewer.clientHeight * 0.35;
  }
}

function clearSource() {
  book.source = null;
  $('#bookSourceHint').textContent = '';
  for (const mark of document.querySelectorAll('#bookViewer mark.book-source')) {
    const parent = mark.parentNode;
    mark.replaceWith(mark.textContent);
    parent.normalize();
  }
}

/** Open the book at page n (used by [Book p.N] citations in the chat). */
export async function openBookPage(n, quote = '', claim = '') {
  if (!book.path) { const s = await status(); if (s.path) book.path = s.path; }
  if (!book.path) { setOpen(true); return; }
  if (!document.body.classList.contains('book-open')) {
    document.body.classList.add('book-open');
    $('#btnBook').setAttribute('aria-expanded', 'true');
    store.set('bookOpen', true);
    refit();
  }
  if (book.loading) await book.loading;
  else if (!book.pdf) await load(book.path);
  clearSource();
  if (!book.pdf) return;
  rescale();
  goTo(n, !(quote || claim));
  if ((quote || claim) && n >= 1 && n <= book.pages.length) {
    book.source = { page: n, quote, claim, scroll: true };
    for (const layer of document.querySelectorAll('#bookViewer .textLayer')) {
      markReadingPage(+layer.parentElement.dataset.page, layer);
    }
  }
}

/** "[Book p.212]" in a rendered answer → clickable links. */
export function linkBook(html) {
  if (!/Book\s+pp?\./i.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, .katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    BOOK_RE.lastIndex = 0;
    if (!BOOK_RE.test(node.nodeValue)) continue;
    BOOK_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    const text = node.nodeValue;
    let last = 0, m;
    while ((m = BOOK_RE.exec(text))) {
      frag.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.className = 'book-ref';
      a.href = '#book';
      a.dataset.bookPage = m[1];
      if (m[2] && +m[2] >= +m[1]) a.dataset.bookEnd = m[2];
      const passage = /^\s*«([^«»]{1,1500})»/.exec(text.slice(BOOK_RE.lastIndex));
      if (passage) {
        a.dataset.bookQuote = passage[1];
        a.title = passage[1];
        BOOK_RE.lastIndex += passage[0].length;
      }
      a.textContent = m[0];
      frag.append(a);
      last = BOOK_RE.lastIndex;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}

async function pickBook() {
  const r = await post('/api/book/pick');
  if (r.error) { $('#bookHint').textContent = r.error; return; }
  if (r.path) { $('#bookHint').textContent = r.warning || ''; await load(r.path); setOpen(true); }
}
async function removeBook() {
  const r = await post('/api/book/clear');
  if (r.error) { $('#bookHint').textContent = r.error; return; }
  $('#bookHint').textContent = '';
  await load('');
}

export async function initBook() {
  setWidth(store.get('bookW', 460), false);
  setSide(store.get('bookSide', 'right'));
  $('#btnBook').onclick = () => setOpen(!document.body.classList.contains('book-open'));
  $('#bookClose').onclick = () => setOpen(false);
  document.querySelectorAll('#bookSideSeg [data-side]').forEach((b) => { b.onclick = () => setSide(b.dataset.side); });
  // "Explain + book": make sure the book is open (or asked for) before the question goes out.
  $('#chips').addEventListener('click', (e) => {
    if (!e.target.closest('[data-book-chip]')) return;
    if (!book.path) { e.stopImmediatePropagation(); setOpen(true); $('#bookHint').textContent = 'Choose your textbook first, then press Explain + book again.'; return; }
    if (!document.body.classList.contains('book-open')) setOpen(true);
  }, true);
  $('#bookKeyPrev').onclick = () => openKey(book.guide.index - 1);
  $('#bookKeyNext').onclick = () => openKey(book.guide.index + 1);
  $('#bookPick').onclick = pickBook;
  $('#bookPickEmpty').onclick = pickBook;
  $('#bookRemove').onclick = removeBook;
  $('#bookPrev').onclick = () => goTo(book.current - 1);
  $('#bookNext').onclick = () => goTo(book.current + 1);
  $('#bookPage').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); goTo(e.target.value); } });
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-book-page]');
    if (!a) return;
    e.preventDefault();
    showBookCitation(a);
  });
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'b' || e.key === 'B') $('#btnBook').click();
  });
  let t;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(rescale, 120); }).observe($('#book'));
  // Drag the edge between the book and the slides.
  const grip = $('#bookGrip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
    const box = $('#book').getBoundingClientRect(), left = document.body.classList.contains('book-left');
    const move = (ev) => { setWidth(left ? ev.clientX - box.left : box.right - ev.clientX); refit(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('lostpointercapture', () => {
      grip.removeEventListener('pointermove', move);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
    }, { once: true });
  });
  grip.addEventListener('dblclick', () => { setWidth(460); refit(); });

  const s = await status();
  $('#bookHint').textContent = s.warning || '';
  book.path = s.path || '';
  $('#bookPick').hidden = !book.path;
  $('#bookRemove').hidden = !book.path && !s.warning;
  $('#bookEmpty').hidden = !!book.path;
  $('#bookNav').hidden = true;
  if (store.get('bookOpen', false)) setOpen(true);
}
