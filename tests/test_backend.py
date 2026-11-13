import json
import unittest
from unittest.mock import patch

import backend


class BackendTests(unittest.TestCase):
    def test_stored_embedding_search_is_read_only_and_finds_source_note(self):
        import sqlite3
        db = sqlite3.connect(f"file:{backend.DB_PATH.as_posix()}?mode=ro", uri=True)
        try:
            note_id, blob, dimension = db.execute("SELECT note_id,embedding,embedding_dimension FROM semantic_notes WHERE embedding_status='ready' AND embedding IS NOT NULL LIMIT 1").fetchone()
        finally:
            db.close()
        vector = backend.decode_vector(blob, dimension)
        results = backend.search_notes(vector, 3)
        self.assertTrue(results)
        self.assertEqual(results[0]["note_id"], note_id)
        self.assertIn("text", results[0])
        self.assertGreater(results[0]["score"], 0.99)

    def test_embedding_decoder_rejects_invalid_payload(self):
        with self.assertRaises(ValueError):
            backend.decode_vector(b"not a vector", 384)

    def test_structured_response_schema(self):
        self.assertEqual(backend.parse_llm_result('{"version":1,"display_text":"hello"}'), {"version": 1, "display_text": "hello"})
        for raw in ('plain text', '{"version":2,"display_text":"x"}', '{"version":true,"display_text":"x"}', '{"version":1,"display_text":"x","extra":0}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                backend.parse_llm_result(raw)

    def test_watch_text_has_utf8_limit(self):
        with self.assertRaisesRegex(ValueError, "512-byte"):
            backend.parse_llm_result(json.dumps({"version": 1, "display_text": "é" * 257}))

    def test_http_and_private_endpoints_require_opt_in(self):
        with patch.object(backend, "ALLOW_LOCAL", False), self.assertRaisesRegex(ValueError, "HTTP"):
            backend.validate_endpoint("http://127.0.0.1:1234/v1")
        with patch.object(backend, "ALLOW_LOCAL", False), patch.object(backend.socket, "getaddrinfo", return_value=[(None, None, None, None, ("10.0.0.2", 443))]), self.assertRaisesRegex(ValueError, "private"):
            backend.validate_endpoint("https://example.invalid/v1")


if __name__ == "__main__":
    unittest.main()
