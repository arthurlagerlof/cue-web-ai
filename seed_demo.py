import argparse
import json
import math
import sqlite3
import struct
from pathlib import Path

from demo_database import DEFAULT_SEED_PATH, DIMENSIONS, MODEL_ID, MODEL_VERSION, PREPROCESSING, TOKENIZER_ID, load_provider_manifests, seed_database

EXPECTED_PROVIDERS = {provider["id"] for provider in load_provider_manifests()}
EXPECTED_COUNTS = {"anki": 12, "knowledge": 6, "web": 3, "calendar": 4, "notifications": 3, "alarm": 2}


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
        card_rows = connection.execute("SELECT payload_json FROM records WHERE provider_id='anki' AND record_type='cards'").fetchall()
        cards = [json.loads(row[0]) for row in card_rows]
        if not 10 <= len(cards) <= 20 or any(not str(card.get("id", "")).startswith("demo-card-") or card.get("source") != "Synthetic Cue demo collection" for card in cards):
            raise AssertionError("Anki records are not exclusively synthetic demo cards")
        if connection.execute("SELECT COUNT(*) FROM records WHERE provider_id='anki' AND record_type='cards' AND payload_json LIKE '%legacy%' COLLATE NOCASE").fetchone()[0]:
            raise AssertionError("Legacy Anki source found in the demo baseline")
        for provider_id in EXPECTED_PROVIDERS:
            invalid = connection.execute("SELECT COUNT(*) FROM tools WHERE provider_id=? AND id NOT LIKE ?", (provider_id, provider_id + ".%" )).fetchone()[0]
            if invalid:
                raise AssertionError(f"Tool namespace ownership mismatch for {provider_id}")
        tool_count = connection.execute("SELECT COUNT(*) FROM tools").fetchone()[0]
        embedding_rows = connection.execute("SELECT model_id,model_version,tokenizer,preprocessing,dimensions,pooling,normalized,similarity_metric,status,vector FROM embeddings WHERE namespace='tool'").fetchall()
        embedding_count = len(embedding_rows)
        if tool_count == 0 or embedding_count == 0:
            raise AssertionError("Provider tool definitions or embedding rows are missing")
        ready_count = 0
        for model_id, model_version, tokenizer, preprocessing, dimensions, pooling, normalized, metric, status, vector in embedding_rows:
            if (model_id, model_version, tokenizer, preprocessing, dimensions, pooling, normalized, metric) != (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine"):
                raise AssertionError("Tool embedding metadata does not match the configured model")
            if status == "ready":
                if vector is None or len(vector) != DIMENSIONS * 4:
                    raise AssertionError("Ready tool embeddings must contain 384 float32 values")
                values = struct.unpack("<" + "f" * DIMENSIONS, vector)
                if any(not math.isfinite(value) for value in values) or abs(math.sqrt(sum(value * value for value in values)) - 1.0) > 0.002:
                    raise AssertionError("Ready tool embeddings must be finite and normalized")
                ready_count += 1
        if require_embeddings and ready_count != embedding_count:
            raise AssertionError(f"Expected {embedding_count} ready browser-model embeddings, found {ready_count}")
        return {"providers": len(providers), "tools": tool_count, "tool_embedding_rows": embedding_count, "ready_tool_embeddings": ready_count, "records": EXPECTED_COUNTS, "path": str(path)}
    finally:
        connection.close()


def export_tool_embeddings(source_path, output_path=Path(__file__).resolve().parent / "data" / "seed" / "tool-embeddings.f32"):
    source_path = Path(source_path).resolve()
    source = sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = source.execute("SELECT owner_id,model_id,model_version,tokenizer,preprocessing,dimensions,pooling,normalized,similarity_metric,status,vector FROM embeddings WHERE namespace='tool' ORDER BY owner_id").fetchall()
        if not rows:
            raise AssertionError("Source database has no tool embeddings")
        vectors = []
        for row in rows:
            if row[1:9] != (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine") or row[9] != "ready" or row[10] is None or len(row[10]) != DIMENSIONS * 4:
                raise AssertionError(f"Tool embedding is not ready or compatible: {row[0]}")
            vectors.append(row[10])
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
