"""HTTP contract tests through the real handler with isolated settings and book cache."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
_import_data = tempfile.TemporaryDirectory()
with patch.dict(os.environ, SLIDEMATE_DATA=_import_data.name):
    import server
    import book
    import config


class BookApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.addClassCleanup(cls.httpd.server_close)
        thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(thread.join)
        cls.addClassCleanup(cls.httpd.shutdown)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.pdf = root / "My book.pdf"
        self.pdf.touch()
        for mock in (patch.object(config, "CONFIG_PATH", root / "config.json"),
                     patch.object(book, "BOOKS", root)):
            mock.start()
            self.addCleanup(mock.stop)
        extract = patch.object(book.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, stdout="First page\fSecond page\f"))
        self.extract = extract.start()
        self.addCleanup(extract.stop)

    def request(self, action="", body=None, header=True, raw=None):
        conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)
        try:
            conn.request("POST" if action else "GET", "/api/book" + action,
                         raw if raw is not None else json.dumps(body or {}),
                         {"X-SlideMate": "1"} if header else {})
            res = conn.getresponse()
            return res.status, json.loads(res.read())
        finally:
            conn.close()

    def test_set_get_clear(self):
        code, selected = self.request("/set", {"path": str(self.pdf)})
        self.assertEqual(code, 200)
        self.assertEqual(selected, {"name": "My book", "path": str(self.pdf), "pages": 2, "warning": ""})
        self.assertEqual(self.request(), (200, selected))
        self.extract.assert_called_once()
        self.assertEqual(self.request("/clear")[1]["path"], "")
        self.assertEqual(config.load()["book_path"], "")

    def test_pick_and_cancel(self):
        with patch.object(server, "pick_pdf", side_effect=[str(self.pdf), None]):
            selected = self.request("/pick")
            self.assertEqual(selected[0], 200)
            self.assertEqual(self.request("/pick"), (200, {"path": ""}))
            self.assertEqual(self.request(), selected)

    def test_missing_and_invalid_replacements_preserve_selection(self):
        self.request("/set", {"path": str(self.pdf)})
        for raw in ('{"path":null}', '{"path":4}', '[]', '{', '{"path":"absent.pdf"}'):
            with self.subTest(raw=raw):
                self.assertEqual(self.request("/set", raw=raw)[0], 400)
        with patch.object(server, "pick_pdf", return_value="absent.pdf"):
            self.assertEqual(self.request("/pick")[0], 400)
        self.assertEqual(self.request()[1]["path"], str(self.pdf))
        self.pdf.unlink()
        status = self.request()[1]
        self.assertEqual(status["pages"], 0)
        self.assertIn("missing", status["warning"])

    def test_scan_is_viewable_without_citations(self):
        self.extract.return_value.stdout = "\f\f"
        code, status = self.request("/set", {"path": str(self.pdf)})
        self.assertEqual(code, 200)
        self.assertEqual(status["pages"], 2)
        self.assertIn("OCR", status["warning"])
        self.assertEqual(book.context_for(str(self.pdf), "deck.pdf", 1, "Explain"), "")
        self.extract.assert_called_once()

    def test_extractor_failure_can_be_retried(self):
        self.extract.side_effect = subprocess.CalledProcessError(1, "pdftotext")
        self.assertEqual(self.request("/set", {"path": str(self.pdf)})[0], 400)
        self.extract.side_effect = None
        self.assertEqual(self.request("/set", {"path": str(self.pdf)})[0], 200)

    def test_every_book_route_requires_header(self):
        with patch.object(server, "pick_pdf") as picker:
            for route in ("", "/set", "/pick", "/clear"):
                with self.subTest(route=route):
                    self.assertEqual(self.request(route, header=False)[0], 403)
            picker.assert_not_called()

    def test_chat_selection_reaches_tutor_and_book_and_is_saved(self):
        config.update({"book_path": str(self.pdf)})
        body = {"path": str(self.pdf), "page": 1, "total": 2, "slides": [2, 1, 2],
                "question": "Connect these concepts."}
        with patch.object(server, "get_session") as session, patch.object(book, "context_for", return_value="Book excerpt") as retrieval, patch.object(server.lib, "append_chat") as save:
            session.return_value.ask.return_value = ["Test answer."]
            session.return_value.cancelled = False
            conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)
            self.addCleanup(conn.close)
            conn.request("POST", "/api/chat", json.dumps(body), {"X-SlideMate": "1"})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(b"event: done", response.read())
            selected = retrieval.call_args.kwargs["selected_text"]
            self.assertEqual(selected, "Slide 1: First page\n\nSlide 2: Second page")
            self.assertIn(selected, session.return_value.ask.call_args.args[0])
            self.assertIn("Book excerpt", session.return_value.ask.call_args.args[0])
            self.assertEqual(save.call_args.args[1]["slides"], [1, 2])
            self.assertEqual(save.call_args.args[2]["slides"], [1, 2])

    def test_out_of_range_selection_rejected_before_tutor(self):
        with patch.object(server, "get_session") as session:
            conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)
            self.addCleanup(conn.close)
            conn.request("POST", "/api/chat", json.dumps({"path": str(self.pdf), "slides": [3]}),
                         {"X-SlideMate": "1"})
            response = conn.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
            session.assert_not_called()
