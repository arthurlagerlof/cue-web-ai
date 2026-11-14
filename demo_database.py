import hashlib
import json
import math
import os
import sqlite3
import struct
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SEED_PATH = ROOT / "data" / "cue_demo.db"
DEFAULT_RUNTIME_DIR = Path(tempfile.gettempdir()) / "cue-demo-runtime"
MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MODEL_VERSION = MODEL_ID
TOKENIZER_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
PREPROCESSING = "transformers.js feature-extraction;mean-pooling;l2-normalize"
DIMENSIONS = 384
PROVIDER_MANIFESTS_PATH = ROOT / "data" / "seed" / "provider-manifests.json"


def load_provider_manifests(path=PROVIDER_MANIFESTS_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))
SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,manifest_json TEXT NOT NULL,adapter_id TEXT NOT NULL,transport TEXT NOT NULL,demo INTEGER NOT NULL CHECK(demo=1));
CREATE TABLE tools(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id),tool_key TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,parameters_json TEXT NOT NULL,examples_json TEXT NOT NULL,confirmation TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,result_schema_json TEXT NOT NULL,execution_adapter TEXT NOT NULL,UNIQUE(provider_id,tool_key));
CREATE TABLE tool_examples(id TEXT PRIMARY KEY,tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,text TEXT NOT NULL,ordinal INTEGER NOT NULL,UNIQUE(tool_id,text));
CREATE TABLE embeddings(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,model_id TEXT NOT NULL,model_version TEXT NOT NULL,tokenizer TEXT NOT NULL,preprocessing TEXT NOT NULL,dimensions INTEGER NOT NULL,pooling TEXT NOT NULL,normalized INTEGER NOT NULL,similarity_metric TEXT NOT NULL,status TEXT NOT NULL,vector BLOB,UNIQUE(namespace,owner_type,owner_id,model_id,model_version));
CREATE TABLE records(provider_id TEXT NOT NULL REFERENCES providers(id),record_type TEXT NOT NULL,record_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(provider_id,record_type,record_id));
CREATE TABLE assets(id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,alt TEXT NOT NULL,original_ref TEXT NOT NULL,width INTEGER,height INTEGER,metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX idx_tools_provider_status ON tools(provider_id,status);
CREATE INDEX idx_tool_examples_tool ON tool_examples(tool_id,ordinal);
CREATE INDEX idx_embeddings_namespace ON embeddings(namespace,status,model_id);
CREATE INDEX idx_records_provider_type ON records(provider_id,record_type);
"""
_DB_LOCKS: dict[str, threading.RLock] = {}
_DB_LOCKS_LOCK = threading.Lock()


def seed_database(target=DEFAULT_SEED_PATH, manifests_path=None, records_path=None, provider_manifests_path=None):
    """Build a clean synthetic baseline from the version-controlled JSON seed files."""
    target = Path(target)
    manifests_path = Path(manifests_path or ROOT / "data" / "seed" / "tool-manifests.json")
    records_path = Path(records_path or ROOT / "data" / "seed" / "provider-data.json")
    provider_manifests_path = Path(provider_manifests_path or PROVIDER_MANIFESTS_PATH)
    manifests = json.loads(manifests_path.read_text(encoding="utf-8"))
    provider_manifests = load_provider_manifests(provider_manifests_path)
    provider_data = json.loads(records_path.read_text(encoding="utf-8"))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="cue-demo-", suffix=".db", dir=target.parent)
    os.close(fd)
    try:
        connection = sqlite3.connect(temp_name)
        try:
            connection.executescript(SCHEMA)
            provider_by_id = {provider["id"]: provider for provider in provider_manifests}
            if len(provider_by_id) != len(provider_manifests) or any(provider.get("demo") is not True for provider in provider_manifests):
                raise ValueError("Provider manifests must have unique IDs and be marked as demo providers")
            connection.executemany(
                "INSERT INTO providers VALUES(?,?,?,?,?,?,?,?,?)",
                [(p["id"], p["name"], p["description"], p["version"], p["status"], json.dumps({**p, "toolIds": [t["id"] for t in manifests if t["providerId"] == p["id"]]}, ensure_ascii=False, sort_keys=True), p["adapter"], p["transport"], int(p["demo"])) for p in provider_manifests],
            )
            for tool in manifests:
                provider_id = tool["providerId"]
                prefix = provider_id + "."
                if provider_id not in provider_by_id or not tool["id"].startswith(prefix):
                    raise ValueError(f"Tool id {tool['id']} has no matching provider namespace {provider_id}")
                connection.execute(
                    "INSERT INTO tools VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (tool["id"], provider_id, tool["id"][len(prefix):], tool["name"], tool["description"], json.dumps(tool["parameters"], ensure_ascii=False, sort_keys=True), json.dumps(tool["examples"], ensure_ascii=False), tool["confirmation"], tool.get("version", "1.0.0"), tool.get("status", "available"), json.dumps(tool.get("resultSchema", {"$ref": "https://cue.local/schemas/cue-display-v1.schema.json"}), ensure_ascii=False, sort_keys=True), provider_by_id[provider_id]["adapter"]),
                )
                for ordinal, example in enumerate([tool["description"], *tool["examples"]]):
                    example_id = f"{tool['id']}:{ordinal}"
                    connection.execute("INSERT INTO tool_examples VALUES(?,?,?,?)", (example_id, tool["id"], example, ordinal))
                    connection.execute("INSERT INTO embeddings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)", (f"embedding:{example_id}", "tool", "tool_example", example_id, MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine", "pending"))
            for provider_id, records in provider_data.items():
                if provider_id not in provider_by_id:
                    raise ValueError(f"Unregistered synthetic provider: {provider_id}")
                for record_type, rows in records.items():
                    if record_type == "assets":
                        for asset in rows:
                            connection.execute("INSERT INTO assets(id,mime_type,alt,original_ref,width,height,metadata_json) VALUES(?,?,?,?,?,?,?)", (asset["id"], asset["mimeType"], asset["alt"], asset["originalRef"], asset.get("width"), asset.get("height"), json.dumps(asset.get("metadata", {}), ensure_ascii=False, sort_keys=True)))
                        continue
                    for row in rows:
                        record_id = str(row["id"])
                        connection.execute("INSERT INTO records VALUES(?,?,?,?)", (provider_id, record_type, record_id, json.dumps(row, ensure_ascii=False, sort_keys=True)))
            vector_file = ROOT / "data" / "seed" / "tool-embeddings.f32"
            if vector_file.is_file():
                rows = connection.execute("SELECT id FROM embeddings WHERE namespace='tool' ORDER BY owner_id").fetchall()
                raw_vectors = vector_file.read_bytes()
                vector_bytes = DIMENSIONS * 4
                if len(raw_vectors) != len(rows) * vector_bytes:
                    raise ValueError("Seed tool-embedding vector file has the wrong size")
                for index, row in enumerate(rows):
                    vector_blob = raw_vectors[index * vector_bytes:(index + 1) * vector_bytes]
                    vector = struct.unpack("<" + "f" * DIMENSIONS, vector_blob)
                    norm = math.sqrt(sum(value * value for value in vector))
                    if any(not math.isfinite(value) for value in vector) or abs(norm - 1.0) > 0.002:
                        raise ValueError("Seed tool embeddings must be finite and L2-normalized")
                    connection.execute("UPDATE embeddings SET vector=?,status='ready' WHERE id=?", (vector_blob, row[0]))
            connection.commit()
        finally:
            connection.close()
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return target


def seed_path():
    return Path(os.environ.get("CUE_DEMO_SEED_DB", str(DEFAULT_SEED_PATH))).expanduser().resolve()


def runtime_dir():
    return Path(os.environ.get("CUE_DEMO_RUNTIME_DIR", str(DEFAULT_RUNTIME_DIR))).expanduser().resolve()


def _session_lock(session_id):
    with _DB_LOCKS_LOCK:
        return _DB_LOCKS.setdefault(session_id, threading.RLock())


def _session_path(session_id):
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("A demo session id is required")
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return runtime_dir() / f"{digest}.db"


def _copy_baseline(destination):
    baseline = seed_path()
    if not baseline.is_file():
        raise FileNotFoundError(f"Synthetic demo baseline not found: {baseline}. Run python seed_demo.py")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_suffix(f".{threading.get_ident()}.tmp")
    if temp_path.exists():
        temp_path.unlink()
    source = sqlite3.connect(f"file:{baseline.as_posix()}?mode=ro", uri=True)
    target = sqlite3.connect(temp_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    os.replace(temp_path, destination)


def session_database(session_id):
    path = _session_path(session_id)
    with _session_lock(session_id):
        if not path.exists():
            _copy_baseline(path)
    return path


def reset_session(session_id):
    path = _session_path(session_id)
    with _session_lock(session_id):
        _copy_baseline(path)
    return path


def connect_readonly(path):
    path = Path(path).resolve()
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def registry(session_id):
    connection = sqlite3.connect(session_database(session_id))
    connection.row_factory = sqlite3.Row
    try:
        providers = [dict(row) for row in connection.execute("SELECT id,name,description,version,status,manifest_json,adapter_id,transport,demo FROM providers ORDER BY id")]
        for provider in providers:
            provider["manifest"] = json.loads(provider.pop("manifest_json"))
            provider["demo"] = bool(provider["demo"])
        tools = []
        for row in connection.execute("SELECT * FROM tools ORDER BY provider_id,tool_key"):
            item = dict(row)
            item["parameters"] = json.loads(item.pop("parameters_json"))
            item["examples"] = json.loads(item.pop("examples_json"))
            item["resultSchema"] = json.loads(item.pop("result_schema_json"))
            item["providerId"] = item.pop("provider_id")
            item["executionAdapter"] = item.pop("execution_adapter")
            item["version"] = item.pop("version")
            item["available"] = item.pop("status") == "available"
            tools.append(item)
        data = {}
        for row in connection.execute("SELECT provider_id,record_type,record_id,payload_json FROM records ORDER BY provider_id,record_type,record_id"):
            data.setdefault(row["provider_id"], {}).setdefault(row["record_type"], []).append(json.loads(row["payload_json"]))
        embedding_state = connection.execute("SELECT COUNT(*) AS total,SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready FROM embeddings WHERE namespace='tool' AND model_id=? AND model_version=? AND tokenizer=? AND preprocessing=? AND dimensions=? AND pooling='mean' AND normalized=1 AND similarity_metric='cosine'", (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS)).fetchone()
        assets = [dict(row) for row in connection.execute("SELECT * FROM assets ORDER BY id")]
        for asset in assets:
            asset["mimeType"] = asset.pop("mime_type")
            asset["originalRef"] = asset.pop("original_ref")
            asset["metadata"] = json.loads(asset.pop("metadata_json"))
        data.setdefault("web", {})["assets"] = assets
        return {"providers": providers, "tools": tools, "data": data, "toolEmbeddingsReady": embedding_state["total"] > 0 and embedding_state["ready"] == embedding_state["total"]}
    finally:
        connection.close()


def validate_arguments(schema, value, path="$", errors=None):
    errors = errors if errors is not None else []
    if not isinstance(schema, dict):
        errors.append(f"{path}: invalid schema")
    elif schema.get("type") == "object":
        if not isinstance(value, dict):
            errors.append(f"{path}: expected object")
        else:
            for key in schema.get("required", []):
                if key not in value:
                    errors.append(f"{path}.{key}: required")
            properties = schema.get("properties", {})
            for key, item in value.items():
                if key not in properties:
                    if schema.get("additionalProperties") is False:
                        errors.append(f"{path}.{key}: additional property not allowed")
                else:
                    validate_arguments(properties[key], item, f"{path}.{key}", errors)
    elif schema.get("type") == "array":
        if not isinstance(value, list):
            errors.append(f"{path}: expected array")
        else:
            if len(value) < schema.get("minItems", 0): errors.append(f"{path}: too few items")
            if schema.get("maxItems") is not None and len(value) > schema["maxItems"]: errors.append(f"{path}: too many items")
            for index, item in enumerate(value): validate_arguments(schema.get("items", {}), item, f"{path}[{index}]", errors)
    elif schema.get("type") == "string":
        if not isinstance(value, str): errors.append(f"{path}: expected string")
        elif len(value) < schema.get("minLength", 0): errors.append(f"{path}: too short")
        elif "enum" in schema and value not in schema["enum"]: errors.append(f"{path}: unsupported value")
    elif schema.get("type") in {"integer", "number"}:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or (schema["type"] == "integer" and not isinstance(value, int)): errors.append(f"{path}: expected {schema['type']}")
        else:
            if "minimum" in schema and value < schema["minimum"]: errors.append(f"{path}: below minimum")
            if "maximum" in schema and value > schema["maximum"]: errors.append(f"{path}: above maximum")
    elif schema.get("type") == "boolean":
        if not isinstance(value, bool): errors.append(f"{path}: expected boolean")
    else:
        errors.append(f"{path}: unsupported JSON Schema type")
    return errors


def store_tool_embeddings(session_id, entries):
    if not isinstance(entries, list) or not entries:
        raise ValueError("A non-empty embedding batch is required")
    path = session_database(session_id)
    connection = sqlite3.connect(path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("exampleId"), str):
                raise ValueError("Each tool embedding requires an exampleId")
            vector = entry.get("vector")
            if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector):
                raise ValueError(f"Each tool embedding must contain {DIMENSIONS} finite numbers")
            norm = math.sqrt(sum(float(v) ** 2 for v in vector))
            if abs(norm - 1.0) > 0.002:
                raise ValueError("Tool embeddings must be L2-normalized")
            cursor = connection.execute("UPDATE embeddings SET vector=?,status='ready' WHERE id=? AND namespace='tool' AND model_id=?", (struct.pack("<" + "f" * DIMENSIONS, *[float(v) for v in vector]), f"embedding:{entry['exampleId']}", MODEL_ID))
            if cursor.rowcount != 1:
                raise ValueError("Embedding owner is not a registered tool example")
        connection.commit()
        return len(entries)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def search_tools(session_id, vector, limit=5, threshold=0.0):
    if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector):
        raise ValueError(f"Query embedding must contain {DIMENSIONS} finite numbers")
    path = session_database(session_id)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute("SELECT t.id,t.provider_id,t.name,t.description,t.parameters_json,t.confirmation,t.status,p.status AS provider_status,e.vector FROM embeddings e JOIN tool_examples x ON x.id=e.owner_id JOIN tools t ON t.id=x.tool_id JOIN providers p ON p.id=t.provider_id WHERE e.namespace='tool' AND e.status='ready' AND e.model_id=? AND e.model_version=? AND e.tokenizer=? AND e.preprocessing=? AND e.dimensions=? AND e.pooling='mean' AND e.normalized=1 AND e.similarity_metric='cosine' AND p.status='available' AND t.status='available'", (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS)).fetchall()
        grouped = {}
        for row in rows:
            stored = struct.unpack("<" + "f" * DIMENSIONS, row["vector"])
            score = sum(float(left) * right for left, right in zip(vector, stored))
            grouped.setdefault(row["id"], []).append((score, row))
        results = []
        for matches in grouped.values():
            matches.sort(key=lambda pair: pair[0], reverse=True)
            top = [score for score, _ in matches[:2]]
            score = 0.7 * top[0] + 0.3 * sum(top) / len(top)
            if score < threshold: continue
            row = matches[0][1]
            results.append({"toolId": row["id"], "providerId": row["provider_id"], "name": row["name"], "description": row["description"], "parameters": json.loads(row["parameters_json"]), "score": score})
        return sorted(results, key=lambda item: item["score"], reverse=True)[:max(1, min(int(limit), 20))]
    finally:
        connection.close()


def execute_tool(session_id, tool_id, arguments):
    from demo_providers import ADAPTERS

    path = session_database(session_id)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute("SELECT t.*,p.status AS provider_status FROM tools t JOIN providers p ON p.id=t.provider_id WHERE t.id=?", (tool_id,)).fetchone()
        if row is None:
            raise LookupError(f"Unknown registered tool: {tool_id}")
        if row["status"] != "available" or row["provider_status"] != "available":
            raise RuntimeError(f"Provider unavailable: {row['provider_id']}")
        errors = validate_arguments(json.loads(row["parameters_json"]), arguments)
        if errors:
            raise ValueError("Invalid arguments: " + "; ".join(errors))
        adapter = ADAPTERS.get(row["execution_adapter"])
        if adapter is None:
            raise RuntimeError("Provider adapter is not trusted or registered")
        return adapter.execute(connection, row["provider_id"], tool_id, arguments)
    finally:
        connection.close()
