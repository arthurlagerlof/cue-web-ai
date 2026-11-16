import http.client
import json
import math
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

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
        manifest = json.loads((Path(__file__).resolve().parents[1] / "data" / "seed" / "tool-manifests.json").read_text(encoding="utf-8"))
        expected_sources = {
            "description": len(manifest),
            "keyword": sum(len(tool.get("keywords", [])) for tool in manifest),
            "example": sum(len(tool["examples"]) for tool in manifest),
        }
        expected_embedding_rows = sum(expected_sources.values())
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
        self.assertEqual(first["tools"], 18)
        self.assertEqual(first["tool_embedding_rows"], expected_embedding_rows)
        self.assertEqual(first["ready_tool_embeddings"], first["seeded_fixture_embeddings"])
        self.assertEqual(first["records"], {"anki": 12, "knowledge": 6, "web": 3, "calendar": 5, "notifications": 3, "alarm": 2})
        connection = sqlite3.connect(self.seed)
        try:
            sources = dict(connection.execute("SELECT source_type,COUNT(*) FROM tool_retrieval_records GROUP BY source_type"))
            self.assertEqual(sources, expected_sources)
            self.assertEqual(connection.execute("SELECT COUNT(DISTINCT content_hash) FROM tool_retrieval_records").fetchone()[0], expected_embedding_rows)
        finally:
            connection.close()

    def test_persisted_conversation_state_is_session_scoped_and_expires(self):
        state = {
            "conversationId": "conversation-one",
            "status": "awaiting_tool_choice",
            "segments": ["Search my local knowledge base for bananas"],
            "currentIndex": 0,
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        demo_database.save_conversation_state("visitor-one", state)
        other = {**state, "conversationId": "conversation-two", "originalRequest": "other request"}
        demo_database.save_conversation_state("visitor-two", other)
        self.assertEqual(demo_database.load_conversation_state("visitor-one")["conversationId"], "conversation-one")
        self.assertEqual(demo_database.load_conversation_state("visitor-two")["originalRequest"], "other request")
        connection = sqlite3.connect(demo_database.session_database("visitor-one"))
        try:
            connection.execute("UPDATE conversation_state SET expires_at='2000-01-01T00:00:00+00:00'")
            connection.commit()
        finally:
            connection.close()
        self.assertIsNone(demo_database.load_conversation_state("visitor-one"))

    def test_provider_data_embeddings_are_persisted_fresh_and_session_scoped(self):
        first_registry = demo_database.registry("provider-one")
        pending = first_registry["pendingProviderDataIds"]
        self.assertTrue(pending)
        provider_id, record_type, record_id = pending[0].split(":", 2)
        index_hash = self.query_one(
            demo_database.session_database("provider-one"),
            "SELECT content_hash FROM provider_data_index WHERE provider_id=? AND record_type=? AND record_id=?",
            (provider_id, record_type, record_id),
        )
        index_entry = {
            "providerId": provider_id,
            "recordType": record_type,
            "recordId": record_id,
            "contentHash": index_hash,
            "vector": [1.0] + [0.0] * (demo_database.DIMENSIONS - 1),
        }
        with self.assertRaisesRegex(ValueError, "changed while its embedding"):
            demo_database.store_provider_data_embeddings("provider-one", [{**index_entry, "contentHash": "stale"}])
        demo_database.store_provider_data_embeddings("provider-one", [index_entry])
        first_registry = demo_database.registry("provider-one")
        self.assertNotIn(pending[0], first_registry["pendingProviderDataIds"])
        self.assertIn(pending[0], demo_database.registry("provider-two")["pendingProviderDataIds"])
        results = demo_database.search_provider_data(
            "provider-one", [1.0] + [0.0] * (demo_database.DIMENSIONS - 1), [provider_id], threshold=0.0,
        )
        self.assertEqual(results[provider_id]["namespace"], "provider-data")
        self.assertEqual(results[provider_id]["hits"][0]["recordId"], record_id)
        self.assertEqual(results[provider_id]["hits"][0]["indexedAt"] is not None, True)

        session_path = demo_database.session_database("provider-one")
        connection = sqlite3.connect(session_path)
        try:
            row = connection.execute(
                "SELECT payload_json FROM records WHERE provider_id=? AND record_type=? AND record_id=?",
                (provider_id, record_type, record_id),
            ).fetchone()
            payload = json.loads(row[0])
            payload["front"] = "Updated synthetic question"
            connection.execute(
                "UPDATE records SET payload_json=? WHERE provider_id=? AND record_type=? AND record_id=?",
                (json.dumps(payload), provider_id, record_type, record_id),
            )
            connection.commit()
        finally:
            connection.close()
        self.assertIn(pending[0], demo_database.registry("provider-one")["pendingProviderDataIds"])
        stale_search = demo_database.search_provider_data(
            "provider-one", [1.0] + [0.0] * (demo_database.DIMENSIONS - 1), [provider_id], threshold=0.0,
        )
        self.assertEqual(stale_search[provider_id]["hits"], [])

        connection = sqlite3.connect(session_path)
        try:
            connection.execute(
                "DELETE FROM records WHERE provider_id=? AND record_type=? AND record_id=?",
                (provider_id, record_type, record_id),
            )
            connection.commit()
        finally:
            connection.close()
        demo_database.registry("provider-one")
        self.assertEqual(self.query_one(
            session_path, "SELECT COUNT(*) FROM provider_data_index WHERE provider_id=? AND record_type=? AND record_id=?",
            (provider_id, record_type, record_id),
        ), 0)

        demo_database.execute_tool("provider-one", "anki.create_card", {"front": "New indexed question", "back": "New indexed answer", "tags": []})
        refreshed = demo_database.registry("provider-one")
        self.assertTrue(any(value.startswith("anki:cards:") for value in refreshed["pendingProviderDataIds"]))

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
        available = demo_database.execute_tool(session, "calendar.check_availability", {"start": "2026-11-14T12:00:00+02:00", "end": "2026-11-14T12:30:00+02:00"})
        self.assertIn("Available", json.dumps(available))
        demo_database.execute_tool(session, "calendar.delete_event", {"eventId": "event-5"})
        demo_database.execute_tool(session, "alarm.delete", {"alarmId": "alarm-2"})
        self.assertEqual(len(demo_database.registry(session)["data"]["alarm"]["items"]), 1)
        demo_database.execute_tool(session, "calendar.create_event", {"title": "Synthetic follow-up", "start": "2026-11-15T15:00:00+02:00", "end": "2026-11-15T15:30:00+02:00"})
        found = demo_database.execute_tool(session, "calendar.find_events", {"date": "2026-11-15"})
        self.assertEqual(len(found["data"]["events"]), 3)
        with self.assertRaises(LookupError):
            demo_database.execute_tool(session, "untrusted.run", {})

    def test_calendar_search_uses_half_open_ranges_and_filters_before_selecting_first_event(self):
        session = "calendar-range-test"
        demo_database.execute_tool(session, "calendar.create_event", {
            "title": "Lunch break",
            "start": "2026-11-15T08:00:00+02:00",
            "end": "2026-11-15T08:30:00+02:00",
        })
        result = demo_database.execute_tool(session, "calendar.find_events", {
            "start_datetime": "2026-11-15T00:00:00+02:00",
            "end_datetime": "2026-11-16T00:00:00+02:00",
            "event_type": "meeting",
            "sort": "start_ascending",
        })
        self.assertEqual(result["data"]["events"][0]["id"], "event-3")
        self.assertEqual(result["data"]["firstEvent"]["id"], "event-3")
        empty_result = demo_database.execute_tool(session, "calendar.find_events", {
            "start_datetime": "2026-11-16T00:00:00+02:00",
            "end_datetime": "2026-11-17T00:00:00+02:00",
        })
        self.assertEqual(empty_result["state"], "empty")

    def test_side_effect_operation_ids_prevent_duplicate_writes_and_argument_reuse(self):
        session = "idempotency-test"
        arguments = {"front": "Synthetic idempotency question", "back": "Synthetic idempotency answer", "tags": ["test"]}
        first = demo_database.execute_tool(session, "anki.create_card", arguments, "conversation-one:0")
        repeated = demo_database.execute_tool(session, "anki.create_card", arguments, "conversation-one:0")
        self.assertEqual(first, repeated)
        self.assertEqual(len(demo_database.registry(session)["data"]["anki"]["cards"]), 13)
        with self.assertRaisesRegex(ValueError, "already used"):
            demo_database.execute_tool(session, "anki.create_card", {**arguments, "front": "Different"}, "conversation-one:0")
        self.assertEqual(len(demo_database.registry(session)["data"]["anki"]["cards"]), 13)

    def test_sqlite_tool_namespace_indexing_and_similarity_search(self):
        session = "embedding-test"
        vector = [0.0] * demo_database.DIMENSIONS
        vector[0] = 1.0
        demo_database.store_tool_embeddings(session, [{"exampleId": "anki.search_cards:0", "vector": vector}])
        demo_database.store_tool_embeddings(session, [{"recordId": "anki.search_cards:keyword:0", "vector": vector}])
        results = demo_database.search_tools(session, vector, threshold=0.8)
        self.assertEqual(results[0]["toolId"], "anki.search_cards")
        self.assertEqual(results[0]["bestDescriptionSimilarity"], 1.0)
        self.assertEqual(results[0]["bestKeywordSimilarity"], 1.0)
        self.assertIn("margin", results[0])
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
            self.assertEqual(len(registry["tools"]), 18)
            self.assertEqual(registry["toolRetrievalConfig"]["scoring"], "weighted-max")
            self.assertEqual(registry["toolRetrievalConfig"]["maxOperations"], 8)
            self.assertEqual(len(registry["data"]["anki"]["cards"]), 12)
            connection.request("GET", "/api/demo/conversation", headers={"Origin": "http://localhost:5173", "Cookie": cookie})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIsNone(json.loads(response.read())["state"])
            with patch("backend.generate_normalization", return_value='{"status":"resolved"}') as generate:
                connection.request("POST", "/api/demo/normalize", body=json.dumps({"prompt": "synthetic prompt"}), headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["text"], '{"status":"resolved"}')
                generate.assert_called_once_with("synthetic prompt")
            with patch("backend.generate_normalization", return_value="Direct answer.") as generate:
                connection.request("POST", "/api/demo/respond", body=json.dumps({"prompt": "What is a comet?"}), headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["text"], "Direct answer.")
                generate.assert_called_once_with("What is a comet?")
            plan_response = {
                "kind": "plan",
                "question": None,
                "text": None,
                "operations": [
                    {
                        "id": "find-events",
                        "toolId": "calendar.find_events",
                        "purpose": "Find today's first meeting",
                        "arguments": {"date": "2026-11-15", "event_type": "meeting", "sort": "start_ascending"},
                        "dependsOn": [],
                        "inputBindings": [],
                        "conditions": [],
                    },
                    {
                        "id": "create-alarm",
                        "toolId": "alarm.create",
                        "purpose": "Set an alarm 15 minutes before the meeting",
                        "arguments": {"label": "Meeting reminder"},
                        "dependsOn": ["find-events"],
                        "inputBindings": [{
                            "targetArgument": "time",
                            "sourceOperation": "find-events",
                            "sourcePointer": "/firstEvent/start",
                            "transform": {"type": "subtract_duration", "duration": "PT15M"},
                        }],
                        "conditions": [{
                            "type": "json_pointer_exists",
                            "operation": "find-events",
                            "pointer": "/firstEvent/start",
                        }],
                    },
                ],
            }
            provider_hits = {"calendar": {"hits": [{
                "recordId": "event-synthetic",
                "recordType": "event",
                "record": {"title": "Synthetic dentist appointment"},
                "similarity": 0.91,
            }]}}
            with patch("backend.generate_normalization", return_value=json.dumps(plan_response)) as generate, \
                    patch("backend.search_provider_data", return_value=provider_hits) as search_provider_data:
                connection.request("POST", "/api/demo/reason", body=json.dumps({
                    "request": "Find my first meeting today",
                    "vector": [1.0] + [0.0] * 383,
                }), headers=headers)
                response = connection.getresponse()
                planned = json.loads(response.read())
                self.assertEqual(response.status, 200, planned)
                self.assertEqual(planned["kind"], "plan")
                self.assertEqual(planned["plan"]["schema"], "cue.execution-plan")
                self.assertEqual(planned["plan"]["operations"][0]["toolId"], "calendar.find_events")
                self.assertFalse(planned["plan"]["operations"][0]["requiresConfirmation"])
                self.assertEqual(planned["plan"]["operations"][1]["inputBindings"][0]["sourceOperation"], "op_1")
                self.assertTrue(planned["plan"]["operations"][1]["requiresConfirmation"])
                self.assertEqual(generate.call_args.kwargs["response_schema"]["properties"]["operations"]["maxItems"], 8)
                self.assertEqual(search_provider_data.call_args.args[1], [1.0] + [0.0] * 383)
                self.assertIn("Synthetic dentist appointment", generate.call_args.args[0])
                self.assertNotIn("Authorization", json.dumps(planned))
            connection.request("POST", "/api/demo/normalize", body=json.dumps({"prompt": "synthetic prompt"}), headers={"Origin": "http://localhost:5173", "Cookie": cookie, "Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
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
        self.assertIn("/api/demo/reason", source)
        self.assertNotIn("OPENROUTER_API_KEY", source)
        self.assertNotIn("memory_db", source)
        self.assertNotIn("semantic_mastery.db", source)


if __name__ == "__main__":
    unittest.main()
