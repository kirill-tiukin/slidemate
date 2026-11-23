"""A reference book (e.g. the course textbook) the tutor can check slides against.

The book is far too long to send with every question, so each question is matched against the book's pages
(BM25 over the page text) and only the best few pages go to the tutor, labelled "[Book p.N]". The student's
viewer shows the same PDF, so a citation like [Book p.212] jumps straight to that page.

Page numbers are PDF page numbers (what the viewer shows), not the numbers printed on the book's pages.
"""
import hashlib
import json
import math
import re
import subprocess
import threading
from functools import lru_cache
from collections import Counter
from pathlib import Path

import config

BOOKS = config.DATA / "books"  # cached page text, so a 500-page book is only extracted once
BOOKS.mkdir(parents=True, exist_ok=True)

STOPWORDS = frozenset("""of an in is to or as at by on be if so we do no it up us am he me my a i the and for are but not you all any can had her was one our out has have this that with from they
their them then than these those will would could should what when where which who whom how why into over under about
also such been being does did doing its it's his she him just more most other some very each both between through during
before after above below again further once here there only own same too slide slides explain book textbook
cite page pages say says back key point points covers cover contradicts flag anything""".split())

_load_lock = threading.Lock()


def tokenize(text):
    return [w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) >= 2 and w not in STOPWORDS]


def _key(pdf):
    st = Path(pdf).stat()
    return hashlib.sha1(f"{Path(pdf).resolve()}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()


def load_pages(pdf):
    """Text of every page of `pdf` (index 0 = page 1). [] if it isn't a readable PDF."""
    pdf = str(pdf or "")
    try:
        if not pdf.lower().endswith(".pdf") or not Path(pdf).is_file():
            return []
        key = _key(pdf)
        with _load_lock:
            return _load(pdf, key)
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


@lru_cache(maxsize=2)
def _load(pdf, key):
    cache = BOOKS / f"{key}.json"
    try:
        pages = json.loads(cache.read_text())["pages"]
        if not isinstance(pages, list) or not pages or not all(isinstance(p, str) for p in pages):
            raise ValueError("Invalid page cache")
    except (OSError, ValueError, KeyError, TypeError):
        out = subprocess.run([config.which("pdftotext") or "pdftotext", "-layout", pdf, "-"],
                             capture_output=True, text=True, check=True, timeout=300, env=config.ENV).stdout
        pages = [re.sub(r"[ \t]+", " ", t).strip() for t in out.split("\f")]
        if pages and not pages[-1]:
            pages.pop()  # pdftotext ends with a form feed
        if not pages:
            raise ValueError("No PDF pages extracted")
        try:
            cache.write_text(json.dumps({"path": pdf, "pages": pages}))
        except OSError:
            pass
    return pages


@lru_cache(maxsize=1)
def _index(pages):
    docs = [Counter(tokenize(p)) for p in pages]
    lengths = [sum(d.values()) for d in docs]
    frequencies = Counter(term for doc in docs for term in doc)
    return docs, lengths, frequencies


def search(pages, query, k=4):
    """Best `k` pages for `query` as [(page_number, score)], best first. BM25, page = document."""
    terms = set(tokenize(query))
    if not terms or not pages:
        return []
    docs, lens, df = _index(tuple(pages))
    n = len(pages)
    avg = (sum(lens) / n) or 1
    k1, b = 1.5, 0.75
    scored = []
    for i, d in enumerate(docs):
        if not lens[i]:
            continue
        s = 0.0
        for t in terms:
            f = d.get(t, 0)
            if not f:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * lens[i] / avg))
        if s > 0:
            scored.append((i + 1, s))
    scored.sort(key=lambda x: -x[1])
    return scored[:k]


def reading_pages(pages, question, slide, k=4):
    """Select up to k neighborhoods, including topic-specific hits on multi-topic slides."""
    slide = re.sub(r"https?://\S+", "", slide)
    # Running heads identify contents, index and promotional pages across editions.
    # Keep original page positions so all excerpt labels still match the PDF.
    heading = re.compile(r"^(?:\d+\s+)?(?:index|contents|table of contents|about the authors|foreword|praise for)(?:\s+(?:\d+|[ivxlcdm]+))?$", re.I)
    reading = [text if text.strip() and not heading.fullmatch(text.strip().splitlines()[0].strip())
               else "" for text in pages]
    query = question + "\n" + slide
    ranked = search(reading, query, k=30)
    if not ranked:
        return []
    topics = [line for line in slide.splitlines() if re.search(r"[•▪]", line)
              and len(tokenize(line)) >= 2]
    candidates = [ranked[0][0]]
    for topic in topics[:8]:
        hit = search(reading, topic, k=1)
        if hit:
            candidates.append(hit[0][0])
    candidates.extend(n for n, score in ranked if score >= ranked[0][1] * 0.45)
    anchors = []
    for n in candidates:
        if all(abs(n - prior) > 2 for prior in anchors):
            anchors.append(n)
            if len(anchors) >= k:
                break
    return sorted({n for anchor in anchors
                   for n in range(max(1, anchor - 2), min(len(pages), anchor + 2) + 1)
                   if reading[n - 1].strip()})


def page_excerpt(text, query, limit):
    if len(text) <= limit:
        return text
    # Overlapping windows let a definition near the end of a dense page compete.
    step = max(1, limit // 2)
    starts = list(range(0, len(text) - limit, step)) + [len(text) - limit]
    terms = set(tokenize(query))
    def score(start):
        return len(terms.intersection(tokenize(text[start:start + limit])))
    start = max(starts, key=score)
    excerpt = text[start:start + limit]
    if start:
        excerpt = excerpt.partition(" ")[2] or excerpt
    if start + limit < len(text):
        excerpt = excerpt.rsplit(" ", 1)[0]
    return excerpt.strip()


def format_context(pages, hits, max_chars=1800, query=""):
    if not hits:
        return ""
    parts = []
    previous = None
    for n, _ in sorted(hits):
        if previous is None or n != previous + 1:
            parts.append("Separate reading section")
        text = page_excerpt(pages[n - 1].strip(), query, max_chars)
        parts.append(f"[Book p.{n}]\n{text}")
        previous = n
    return ("Check each slide point against the excerpts below and explain any gaps in this edition. "
            "Give a short reading guide: cite the relevant contiguous reading range as [Book pp.A–B], "
            "or [Book p.N] for a single page. Never bridge separate sections. Within each range, select "
            "only the 1–3 essential sentences that best explain different slide points. For each, say why "
            "it matters and cite [Book p.N] «exact words copied from that page». Prefer definitions, mechanisms "
            "and worked reasoning. Omit incidental mentions. Use only supplied pages and never invent a quote.\n\n"
            + "\n\n".join(parts))


def slide_text(pdf, page):
    try:
        return subprocess.run([config.which("pdftotext") or "pdftotext", "-f", str(page), "-l", str(page), str(pdf), "-"],
                              capture_output=True, text=True, timeout=20, env=config.ENV).stdout
    except Exception:
        return ""


def context_for(book_pdf, deck_pdf, page, question, k=4, selected_text=None):
    """Book excerpts for one question about slide `page` of `deck_pdf`; "" if no book is set or nothing matches."""
    pages = load_pages(book_pdf)
    if not pages or not any(pages):
        return ""
    slide = slide_text(deck_pdf, page) if selected_text is None else selected_text
    selected = reading_pages(pages, question, slide, k)
    if not selected:
        return ""
    # Keep provider input bounded even when distinct topics span several chapters.
    return format_context(pages, [(n, 0) for n in selected], min(4200, 36000 // len(selected)),
                          question + "\n" + slide)


def status():
    path = config.load().get("book_path") or ""
    pages = load_pages(path) if path else []
    warning = ""
    if path and not pages:
        warning = "The saved textbook is missing or unreadable. Choose a PDF to reconnect it."
    elif pages and not any(pages):
        warning = "This PDF has no searchable text. You can read it here. Choose an OCR copy for tutor citations."
    return {"path": path if pages else "", "name": Path(path).stem if pages else "",
            "pages": len(pages), "warning": warning}
