import http.client
import json
import math
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

import backend
import demo_database
from seed_demo import verify_database


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.seed = Path(self.temporary.name) / "cue_demo.db"
        self.runtime = Path(self.temporary.name) / "runtime"
        self.old_seed = os.environ.get("CUE_DEMO_SEED_DB")
        self.old_runtime = os.environ.get("CUE_DEMO_RUNTIME_DIR")
        os.environ["CUE_DEMO_SEED_DB"] = str(self.seed)
        os.environ["CUE_DEMO_RUNTIME_DIR"] = str(self.runtime)
        self.addCleanup(self.restore_environment)
        demo_database.seed_database(self.seed)

    def restore_environment(self):
        for key, old_value in (("CUE_DEMO_SEED_DB", self.old_seed), ("CUE_DEMO_RUNTIME_DIR", self.old_runtime)):
            if old_value is None: os.environ.pop(key, None)
            else: os.environ[key] = old_value

    @staticmethod
    def query_one(path, query, parameters=()):
        connection = sqlite3.connect(path)
        try:
            return connection.execute(query, parameters).fetchone()[0]
        finally:
            connection.close()

    def test_seed_is_synthetic_complete_and_idempotent(self):
        first = verify_database(self.seed, require_embeddings=False)
        def snapshot():
            connection = sqlite3.connect(self.seed)
            try:
                return {
                    "providers": connection.execute("SELECT * FROM providers ORDER BY id").fetchall(),
                    "tools": connection.execute("SELECT * FROM tools ORDER BY id").fetchall(),
                    "examples": connection.execute("SELECT * FROM tool_examples ORDER BY id").fetchall(),
                    "embeddings": connection.execute("SELECT * FROM embeddings ORDER BY id").fetchall(),
                    "records": connection.execute("SELECT * FROM records ORDER BY provider_id,record_type,record_id").fetchall(),
                    "assets": connection.execute("SELECT * FROM assets ORDER BY id").fetchall(),
                }
            finally:
                connection.close()
        before = snapshot()
        demo_database.seed_database(self.seed)
        after = snapshot()
        self.assertEqual(before, after)
        self.assertEqual(first["providers"], 6)
        self.assertEqual(first["tools"], 15)
        self.assertEqual(first["records"], {"anki": 12, "knowledge": 6, "web": 3, "calendar": 4, "notifications": 3, "alarm": 2})

    def test_baseline_is_read_only_and_independent_of_personal_databases(self):
        connection = demo_database.connect_readonly(self.seed)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM providers").fetchone()[0], 6)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("DELETE FROM providers")
        finally:
            connection.close()
        source = Path(backend.__file__).read_text(encoding="utf-8") + Path(demo_database.__file__).read_text(encoding="utf-8")
        self.assertNotIn("memory_db", source)
        self.assertNotIn("semantic_mastery.db", source)
        self.assertNotIn("cue_memory.db", source)

    def test_session_copies_are_isolated_and_reset_from_baseline(self):
        first = demo_database.session_database("visitor-one")
        second = demo_database.session_database("visitor-two")
        self.assertNotEqual(first, second)
        baseline_count = self.query_one(self.seed, "SELECT COUNT(*) FROM records WHERE provider_id='anki'")
        created = demo_database.execute_tool("visitor-one", "anki.create_card", {"front": "Synthetic question", "back": "Synthetic answer", "tags": ["demo"]})
        self.assertEqual(created["state"], "success")
        self.assertEqual(len(demo_database.registry("visitor-one")["data"]["anki"]["cards"]), 13)
        self.assertEqual(len(demo_database.registry("visitor-two")["data"]["anki"]["cards"]), 12)
        self.assertEqual(self.query_one(self.seed, "SELECT COUNT(*) FROM records WHERE provider_id='anki'"), baseline_count)
        demo_database.reset_session("visitor-one")
        self.assertEqual(len(demo_database.registry("visitor-one")["data"]["anki"]["cards"]), 12)

    def test_provider_adapters_search_synthetic_records_and_persist_changes(self):
        session = "provider-test"
        self.assertEqual(demo_database.execute_tool(session, "anki.search_cards", {"query": "chloroplasts"})["source"]["app"], "anki")
        self.assertEqual(demo_database.execute_tool(session, "knowledge.search", {"query": "local-first AI"})["source"]["app"], "knowledge")
        web = demo_database.execute_tool(session, "web.search", {"query": "multimodal AI"})
        self.assertEqual(web["assets"][0]["id"], "web-research-image")
        calendar = demo_database.execute_tool(session, "calendar.find_events", {"date": "2026-11-14"})
        self.assertEqual(len(calendar["data"]["events"]), 2)
        self.assertEqual(demo_database.execute_tool(session, "notifications.search", {"query": "Alex"})["source"]["app"], "notifications")
        self.assertEqual(demo_database.execute_tool(session, "alarm.find", {"query": "morning"})["source"]["app"], "alarm")
        demo_database.execute_tool(session, "calendar.create_event", {"title": "Synthetic follow-up", "start": "2026-11-15T15:00:00+02:00", "end": "2026-11-15T15:30:00+02:00"})
        found = demo_database.execute_tool(session, "calendar.find_events", {"date": "2026-11-15"})
        self.assertEqual(len(found["data"]["events"]), 3)
        with self.assertRaises(LookupError):
            demo_database.execute_tool(session, "untrusted.run", {})

    def test_sqlite_tool_namespace_indexing_and_similarity_search(self):
        session = "embedding-test"
        vector = [0.0] * demo_database.DIMENSIONS
        vector[0] = 1.0
        demo_database.store_tool_embeddings(session, [{"exampleId": "anki.search_cards:0", "vector": vector}])
        results = demo_database.search_tools(session, vector, threshold=0.8)
        self.assertEqual(results[0]["toolId"], "anki.search_cards")
        orthogonal = [0.0] * demo_database.DIMENSIONS
        orthogonal[1] = 1.0
        self.assertEqual(demo_database.search_tools(session, orthogonal, threshold=0.9), [])
        with self.assertRaises(ValueError):
            demo_database.store_tool_embeddings(session, [{"exampleId": "unknown:0", "vector": vector}])

    def test_http_registry_dispatch_confirmation_and_reset_use_session_database(self):
        server = backend.ThreadingHTTPServer(("127.0.0.1", 0), backend.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
        try:
            connection.request("GET", "/api/session", headers={"Origin": "http://localhost:5173"})
            response = connection.getresponse()
            session = json.loads(response.read())
            cookie = response.getheader("Set-Cookie").split(";", 1)[0]
            headers = {"Origin": "http://localhost:5173", "Cookie": cookie, "X-CSRF-Token": session["csrfToken"], "Content-Type": "application/json"}
            connection.request("GET", "/api/demo/registry", headers={"Origin": "http://localhost:5173", "Cookie": cookie})
            response = connection.getresponse()
            registry = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(len(registry["providers"]), 6)
            self.assertEqual(len(registry["tools"]), 15)
            self.assertEqual(len(registry["data"]["anki"]["cards"]), 12)
            body = {"toolId": "anki.create_card", "arguments": {"front": "Question", "back": "Answer"}}
            connection.request("POST", "/api/demo/execute", body=json.dumps(body), headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 409)
            body["confirmed"] = True
            connection.request("POST", "/api/demo/execute", body=json.dumps(body), headers=headers)
            response = connection.getresponse()
            result = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(result["result"]["state"], "success")
            connection.request("POST", "/api/demo/reset", body="{}", headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(json.loads(response.read())["reset"])
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_embedding_vectors_require_normalized_384_dimensions(self):
        vector = [0.0] * demo_database.DIMENSIONS
        vector[0] = 1.0
        with self.assertRaises(ValueError):
            demo_database.store_tool_embeddings("validation", [{"exampleId": "anki.search_cards:0", "vector": vector[:-1]}])
        with self.assertRaises(ValueError):
            demo_database.store_tool_embeddings("validation", [{"exampleId": "anki.search_cards:0", "vector": [2.0] + [0.0] * 383}])

    def test_backend_has_no_hosted_execution_route_or_personal_database_dependency(self):
        source = Path(backend.__file__).read_text(encoding="utf-8")
        self.assertNotIn("/api/interpret", source)
        self.assertNotIn("urllib.request", source)
        self.assertNotIn("LLM_API_KEY", source)
        self.assertNotIn("memory_db", source)
        self.assertNotIn("semantic_mastery.db", source)


if __name__ == "__main__":
    unittest.main()
