import argparse
import json
import math
import sqlite3
import struct
from datetime import datetime
from pathlib import Path

from demo_database import DEFAULT_SEED_PATH, DIMENSIONS, MODEL_ID, MODEL_VERSION, PREPROCESSING, TOKENIZER_ID, TOOL_EMBEDDING_INDEX_PATH, load_provider_manifests, seed_database

EXPECTED_PROVIDERS = {provider["id"] for provider in load_provider_manifests()}
EXPECTED_COUNTS = {"anki": 20, "knowledge": 20, "web": 6, "calendar": 48, "notifications": 6, "alarm": 4}


def verify_database(path=DEFAULT_SEED_PATH, require_embeddings=True):
    path = Path(path).resolve()
    if not path.is_file():
        raise AssertionError(f"Demo database does not exist: {path}")
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        providers = {row[0] for row in connection.execute("SELECT id FROM providers WHERE demo=1")}
        if providers != EXPECTED_PROVIDERS:
            raise AssertionError(f"Unexpected demo providers: {sorted(providers)}")
        if connection.execute("SELECT COUNT(*) FROM providers WHERE demo!=1").fetchone()[0]:
            raise AssertionError("Non-demo provider found in demo baseline")
        for provider_id, expected in EXPECTED_COUNTS.items():
            count = connection.execute("SELECT COUNT(*) FROM records WHERE provider_id=?", (provider_id,)).fetchone()[0]
            if count != expected:
                raise AssertionError(f"Expected {expected} {provider_id} records, found {count}")
        clock_row = connection.execute("SELECT value_json FROM settings WHERE key='demo_clock'").fetchone()
        if not clock_row:
            raise AssertionError("The synthetic demo clock is missing")
        demo_clock = json.loads(clock_row[0])
        if not isinstance(demo_clock, str):
            raise AssertionError("The baseline demo clock must be an ISO-8601 date-time")
        try:
            datetime.fromisoformat(demo_clock.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AssertionError("The baseline demo clock must be an ISO-8601 date-time") from exc
        card_rows = connection.execute("SELECT payload_json FROM records WHERE provider_id='anki' AND record_type='cards'").fetchall()
        cards = [json.loads(row[0]) for row in card_rows]
        if not 20 <= len(cards) <= 40 or any(not str(card.get("id", "")).startswith("demo-card-") or card.get("source") != "Synthetic Cue demo collection" for card in cards):
            raise AssertionError("Anki records are not exclusively synthetic demo cards")
        if connection.execute("SELECT COUNT(*) FROM records WHERE provider_id='anki' AND record_type='cards' AND payload_json LIKE '%legacy%' COLLATE NOCASE").fetchone()[0]:
            raise AssertionError("Legacy Anki source found in the demo baseline")
        calendar_rows = connection.execute("SELECT record_id,payload_json FROM records WHERE provider_id='calendar' AND record_type='events'").fetchall()
        if not 30 <= len(calendar_rows) <= 50 or any(not row[0].startswith(("event-", "demo-event-")) for row in calendar_rows):
            raise AssertionError("Calendar events must be a bounded, fictional synthetic collection")
        for _, payload in calendar_rows:
            event = json.loads(payload)
            if not all(isinstance(event.get(field), str) and event[field] for field in ("title", "start", "end")):
                raise AssertionError("A synthetic calendar event is missing required fields")
        for provider_id in EXPECTED_PROVIDERS:
            invalid = connection.execute("SELECT COUNT(*) FROM tools WHERE provider_id=? AND id NOT LIKE ?", (provider_id, provider_id + ".%" )).fetchone()[0]
            if invalid:
                raise AssertionError(f"Tool namespace ownership mismatch for {provider_id}")
        tool_count = connection.execute("SELECT COUNT(*) FROM tools").fetchone()[0]
        embedding_rows = connection.execute("SELECT r.source_type,e.model_id,e.model_version,e.tokenizer,e.preprocessing,e.dimensions,e.pooling,e.normalized,e.similarity_metric,e.status,e.vector FROM tool_retrieval_records r JOIN embeddings e ON e.owner_type='tool_retrieval' AND e.owner_id=r.id WHERE e.namespace='tool'").fetchall()
        embedding_count = len(embedding_rows)
        seeded_index = json.loads(TOOL_EMBEDDING_INDEX_PATH.read_text(encoding="utf-8")) if TOOL_EMBEDDING_INDEX_PATH.is_file() else []
        if tool_count == 0 or embedding_count == 0:
            raise AssertionError("Provider tool definitions or embedding rows are missing")
        ready_count = 0
        for source_type, model_id, model_version, tokenizer, preprocessing, dimensions, pooling, normalized, metric, status, vector in embedding_rows:
            if (model_id, model_version, tokenizer, preprocessing, dimensions, pooling, normalized, metric) != (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine"):
                raise AssertionError("Tool embedding metadata does not match the configured model")
            if status == "ready":
                if vector is None or len(vector) != DIMENSIONS * 4:
                    raise AssertionError("Ready tool embeddings must contain 384 float32 values")
                values = struct.unpack("<" + "f" * DIMENSIONS, vector)
                if any(not math.isfinite(value) for value in values) or abs(math.sqrt(sum(value * value for value in values)) - 1.0) > 0.002:
                    raise AssertionError("Ready tool embeddings must be finite and normalized")
                ready_count += 1
        seeded_ready = sum(1 for record in seeded_index if connection.execute("SELECT e.status FROM embeddings e JOIN tool_retrieval_records r ON r.id=e.owner_id WHERE e.owner_type='tool_retrieval' AND r.id=? AND r.content_hash=?", (record["id"], record["contentHash"])).fetchone() == ("ready",))
        if require_embeddings and seeded_ready != len(seeded_index):
            raise AssertionError(f"Expected {len(seeded_index)} unchanged seeded embeddings, found {seeded_ready}")
        return {"providers": len(providers), "tools": tool_count, "tool_embedding_rows": embedding_count, "ready_tool_embeddings": ready_count, "seeded_fixture_embeddings": seeded_ready, "pending_tool_embeddings": embedding_count - ready_count, "records": EXPECTED_COUNTS, "demo_clock": demo_clock, "calendar_events": len(calendar_rows), "path": str(path)}
    finally:
        connection.close()


def export_tool_embeddings(source_path, output_path=Path(__file__).resolve().parent / "data" / "seed" / "tool-embeddings.f32"):
    source_path = Path(source_path).resolve()
    source = sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)
    try:
        seeded_index = json.loads(TOOL_EMBEDDING_INDEX_PATH.read_text(encoding="utf-8"))
        vectors = []
        for record in seeded_index:
            row = source.execute("SELECT e.model_id,e.model_version,e.tokenizer,e.preprocessing,e.dimensions,e.pooling,e.normalized,e.similarity_metric,e.status,e.vector FROM embeddings e JOIN tool_retrieval_records r ON r.id=e.owner_id WHERE e.namespace='tool' AND e.owner_type='tool_retrieval' AND r.id=? AND r.content_hash=?", (record["id"], record["contentHash"])).fetchone()
            if row is None or row[:8] != (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine") or row[8] != "ready" or row[9] is None or len(row[9]) != DIMENSIONS * 4:
                raise AssertionError(f"Tool embedding is not ready or compatible: {record['id']}")
            vectors.append(row[9])
    finally:
        source.close()
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(b"".join(vectors))
    return {"source": str(source_path), "output": str(output_path.resolve()), "count": len(vectors), "dimensions": DIMENSIONS, "model": MODEL_ID}


def main():
    parser = argparse.ArgumentParser(description="Build, verify, or capture Cue's synthetic demo database embeddings.")
    parser.add_argument("--output", type=Path, default=DEFAULT_SEED_PATH)
    parser.add_argument("--verify", action="store_true", help="Verify without modifying the database")
    parser.add_argument("--export-vectors", type=Path, help="Export compatible vectors from a synthetic runtime DB to the versioned seed fixture")
    arguments = parser.parse_args()
    if arguments.export_vectors:
        print(json.dumps(export_tool_embeddings(arguments.export_vectors), indent=2))
    else:
        if not arguments.verify:
            seed_database(arguments.output)
        print(json.dumps(verify_database(arguments.output, require_embeddings=arguments.verify), indent=2))


if __name__ == "__main__":
    main()
