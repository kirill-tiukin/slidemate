"""Tests for server/book.py (reference-book retrieval). Run: python3 -m unittest discover -s tests"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
os.environ.setdefault("SLIDEMATE_DATA", tempfile.mkdtemp(prefix="slidemate-test-"))

import book  # noqa: E402

PAGES = [
    "Chapter 1. Comparable company analysis uses trading multiples such as EV/EBITDA and P/E to value a firm.",
    "Discounted cash flow analysis projects free cash flow and discounts it at the weighted average cost of capital.",
    "Precedent transactions analysis applies control premiums paid in past mergers and acquisitions.",
    "Initial public offerings involve underwriters, bookbuilding, and a greenshoe over-allotment option.",
    "",
]


class TokenizeTests(unittest.TestCase):
    def test_lowercases_and_drops_stopwords_and_short_words(self):
        self.assertEqual(book.tokenize("The EV/EBITDA of a Firm"), ["ev", "ebitda", "firm"])

    def test_empty_text_gives_no_tokens(self):
        self.assertEqual(book.tokenize(""), [])


class SearchTests(unittest.TestCase):
    def test_finds_the_page_about_the_query(self):
        hits = book.search(PAGES, "weighted average cost of capital discount", k=2)
        self.assertEqual(hits[0][0], 2)  # 1-based page numbers

    def test_ipo_query_hits_ipo_page(self):
        hits = book.search(PAGES, "greenshoe underwriters", k=1)
        self.assertEqual([p for p, _ in hits], [4])

    def test_no_match_returns_empty(self):
        self.assertEqual(book.search(PAGES, "zzzz qqqq", k=3), [])

    def test_blank_pages_never_returned(self):
        hits = book.search(PAGES, "analysis", k=10)
        self.assertNotIn(5, [p for p, _ in hits])

    def test_k_limits_results(self):
        self.assertLessEqual(len(book.search(PAGES, "analysis", k=2)), 2)


class ContextTests(unittest.TestCase):
    def test_context_labels_pages_and_asks_for_citations(self):
        ctx = book.format_context(PAGES, [(2, 1.0), (3, 0.5)], max_chars=200)
        self.assertIn("[Book p.2]", ctx)
        self.assertIn("[Book p.3]", ctx)
        self.assertIn("cite", ctx.lower())

    def test_context_truncates_long_pages(self):
        ctx = book.format_context(["x " * 5000], [(1, 1.0)], max_chars=100)
        self.assertLess(len(ctx), 900)

    def test_empty_hits_gives_empty_context(self):
        self.assertEqual(book.format_context(PAGES, [], max_chars=200), "")


class ReadingTests(unittest.TestCase):
    def test_distinct_topics_get_separate_bounded_ranges(self):
        pages = ["unrelated"] * 24
        pages[2] = "bond indenture covenants"
        pages[20] = "discounted valuation multiples"
        selected = book.reading_pages(pages, "", "• bond indenture covenants\n• discounted valuation multiples")
        self.assertEqual(selected, [1, 2, 3, 4, 5, 19, 20, 21, 22, 23])
        self.assertEqual(book.reading_pages(pages, "unfindable", ""), [])

    def test_dense_page_keeps_relevant_passage_near_end(self):
        text = "preface " * 300 + "Bond indenture covenants protect creditors."
        self.assertIn("protect creditors", book.page_excerpt(text, "bond indenture covenants", 100))


class LoadTests(unittest.TestCase):
    def test_missing_file_gives_no_pages(self):
        self.assertEqual(book.load_pages("/nonexistent/file.pdf"), [])

    def test_non_pdf_rejected(self):
        with tempfile.NamedTemporaryFile(suffix=".txt") as f:
            self.assertEqual(book.load_pages(f.name), [])


if __name__ == "__main__":
    unittest.main()
