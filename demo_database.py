import hashlib
import json
import math
import os
import sqlite3
import struct
import tempfile
import threading
from datetime import datetime, timedelta, timezone
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
TOOL_EMBEDDING_INDEX_PATH = ROOT / "data" / "seed" / "tool-embeddings.index.json"
TOOL_RETRIEVAL_CONFIG_PATH = ROOT / "data" / "seed" / "tool-retrieval-config.json"


def load_provider_manifests(path=PROVIDER_MANIFESTS_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))
SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,manifest_json TEXT NOT NULL,adapter_id TEXT NOT NULL,transport TEXT NOT NULL,demo INTEGER NOT NULL CHECK(demo=1));
CREATE TABLE tools(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id),tool_key TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,keywords_json TEXT NOT NULL,parameters_json TEXT NOT NULL,examples_json TEXT NOT NULL,confirmation TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,result_schema_json TEXT NOT NULL,execution_adapter TEXT NOT NULL,UNIQUE(provider_id,tool_key));
CREATE TABLE tool_examples(id TEXT PRIMARY KEY,tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,text TEXT NOT NULL,ordinal INTEGER NOT NULL,UNIQUE(tool_id,text));
CREATE TABLE tool_retrieval_records(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id),tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,source_type TEXT NOT NULL CHECK(source_type IN ('description','keyword','example')),text TEXT NOT NULL,locale TEXT,content_hash TEXT NOT NULL);
CREATE TABLE embeddings(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,model_id TEXT NOT NULL,model_version TEXT NOT NULL,tokenizer TEXT NOT NULL,preprocessing TEXT NOT NULL,dimensions INTEGER NOT NULL,pooling TEXT NOT NULL,normalized INTEGER NOT NULL,similarity_metric TEXT NOT NULL,status TEXT NOT NULL,vector BLOB,UNIQUE(namespace,owner_type,owner_id,model_id,model_version));
CREATE TABLE records(provider_id TEXT NOT NULL REFERENCES providers(id),record_type TEXT NOT NULL,record_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(provider_id,record_type,record_id));
CREATE TABLE assets(id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,alt TEXT NOT NULL,original_ref TEXT NOT NULL,width INTEGER,height INTEGER,metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
CREATE INDEX idx_tools_provider_status ON tools(provider_id,status);
CREATE INDEX idx_tool_examples_tool ON tool_examples(tool_id,ordinal);
CREATE INDEX idx_tool_retrieval_tool_source ON tool_retrieval_records(tool_id,source_type);
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
    retrieval_config = json.loads(TOOL_RETRIEVAL_CONFIG_PATH.read_text(encoding="utf-8"))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="cue-demo-", suffix=".db", dir=target.parent)
    os.close(fd)
    try:
        connection = sqlite3.connect(temp_name)
        try:
            connection.executescript(SCHEMA)
            connection.execute("INSERT INTO settings VALUES(?,?)", ("tool_retrieval", json.dumps(retrieval_config, ensure_ascii=False, sort_keys=True)))
            demo_clock = os.environ.get("CUE_DEMO_CLOCK", "2026-11-16T08:00:00+02:00")
            try:
                parsed_demo_clock = datetime.fromisoformat(demo_clock.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("CUE_DEMO_CLOCK must be an ISO-8601 date-time") from exc
            demo_day_offset = (parsed_demo_clock.date() - datetime(2026, 11, 16).date()).days
            connection.execute("INSERT INTO settings VALUES(?,?)", ("demo_clock", json.dumps(demo_clock)))
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
                    "INSERT INTO tools VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (tool["id"], provider_id, tool["id"][len(prefix):], tool["name"], tool["description"], json.dumps(tool.get("keywords", []), ensure_ascii=False), json.dumps(tool["parameters"], ensure_ascii=False, sort_keys=True), json.dumps(tool["examples"], ensure_ascii=False), tool["confirmation"], tool.get("version", "1.0.0"), tool.get("status", "available"), json.dumps(tool.get("resultSchema", {"$ref": "https://cue.local/schemas/cue-display-v1.schema.json"}), ensure_ascii=False, sort_keys=True), provider_by_id[provider_id]["adapter"]),
                )
                example_items = [item if isinstance(item, dict) else {"text": item} for item in tool["examples"]]
                for ordinal, item in enumerate(example_items, start=1):
                    connection.execute("INSERT INTO tool_examples VALUES(?,?,?,?)", (f"{tool['id']}:{ordinal}", tool["id"], item["text"], ordinal))
                retrieval_records = [("description", tool["description"], None, f"{tool['id']}:0")]
                retrieval_records.extend(("keyword", keyword, None, f"{tool['id']}:keyword:{index}") for index, keyword in enumerate(tool.get("keywords", [])))
                retrieval_records.extend(("example", item["text"], item.get("locale"), f"{tool['id']}:{index}") for index, item in enumerate(example_items, start=1))
                for source_type, text, locale, record_id in retrieval_records:
                    content_hash = hashlib.sha256(f"{source_type}\0{text}\0{locale or ''}".encode("utf-8")).hexdigest()
                    connection.execute("INSERT INTO tool_retrieval_records VALUES(?,?,?,?,?,?,?)", (record_id, provider_id, tool["id"], source_type, text, locale, content_hash))
                    connection.execute("INSERT INTO embeddings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)", (f"embedding:{record_id}", "tool", "tool_retrieval", record_id, MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine", "pending"))
            for provider_id, records in provider_data.items():
                if provider_id not in provider_by_id:
                    raise ValueError(f"Unregistered synthetic provider: {provider_id}")
                for record_type, rows in records.items():
                    if record_type == "assets":
                        for asset in rows:
                            connection.execute("INSERT INTO assets(id,mime_type,alt,original_ref,width,height,metadata_json) VALUES(?,?,?,?,?,?,?)", (asset["id"], asset["mimeType"], asset["alt"], asset["originalRef"], asset.get("width"), asset.get("height"), json.dumps(asset.get("metadata", {}), ensure_ascii=False, sort_keys=True)))
                        continue
                    for row in rows:
                        if demo_day_offset and provider_id == "calendar" and record_type == "events":
                            row = dict(row)
                            for field in ("start", "end"):
                                if isinstance(row.get(field), str):
                                    row[field] = (datetime.fromisoformat(row[field].replace("Z", "+00:00")) + timedelta(days=demo_day_offset)).isoformat()
                        elif demo_day_offset and provider_id == "notifications" and record_type == "items":
                            row = dict(row)
                            if isinstance(row.get("timestamp"), str):
                                row["timestamp"] = (datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")) + timedelta(days=demo_day_offset)).isoformat()
                        elif demo_day_offset and provider_id == "alarm" and record_type == "items":
                            row = dict(row)
                            if isinstance(row.get("time"), str):
                                row["time"] = (datetime.fromisoformat(row["time"].replace("Z", "+00:00")) + timedelta(days=demo_day_offset)).isoformat()
                        record_id = str(row["id"])
                        connection.execute("INSERT INTO records VALUES(?,?,?,?)", (provider_id, record_type, record_id, json.dumps(row, ensure_ascii=False, sort_keys=True)))
            vector_file = ROOT / "data" / "seed" / "tool-embeddings.f32"
            if vector_file.is_file() and TOOL_EMBEDDING_INDEX_PATH.is_file():
                index_records = json.loads(TOOL_EMBEDDING_INDEX_PATH.read_text(encoding="utf-8"))
                raw_vectors = vector_file.read_bytes()
                vector_bytes = DIMENSIONS * 4
                if len(raw_vectors) != len(index_records) * vector_bytes:
                    raise ValueError("Seed tool-embedding vector file does not match its index manifest")
                for index, record in enumerate(index_records):
                    vector_blob = raw_vectors[index * vector_bytes:(index + 1) * vector_bytes]
                    vector = struct.unpack("<" + "f" * DIMENSIONS, vector_blob)
                    norm = math.sqrt(sum(value * value for value in vector))
                    if any(not math.isfinite(value) for value in vector) or abs(norm - 1.0) > 0.002:
                        raise ValueError("Seed tool embeddings must be finite and L2-normalized")
                    stored = connection.execute("SELECT e.id FROM embeddings e JOIN tool_retrieval_records r ON r.id=e.owner_id WHERE e.owner_type='tool_retrieval' AND r.id=? AND r.content_hash=?", (record["id"], record["contentHash"])).fetchone()
                    if stored:
                        connection.execute("UPDATE embeddings SET vector=?,status='ready' WHERE id=?", (vector_blob, stored[0]))
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


def _sync_session_manifests(connection):
    manifests = json.loads((ROOT / "data" / "seed" / "tool-manifests.json").read_text(encoding="utf-8"))
    providers = load_provider_manifests()
    retrieval_config = json.loads(TOOL_RETRIEVAL_CONFIG_PATH.read_text(encoding="utf-8"))
    tool_ids_by_provider = {}
    for tool in manifests:
        tool_ids_by_provider.setdefault(tool["providerId"], []).append(tool["id"])
        existing = connection.execute("SELECT id FROM tools WHERE id=?", (tool["id"],)).fetchone()
        if not existing:
            continue
        connection.execute(
            "UPDATE tools SET name=?,description=?,keywords_json=?,parameters_json=?,examples_json=?,confirmation=?,version=?,status=?,result_schema_json=? WHERE id=?",
            (
                tool["name"], tool["description"], json.dumps(tool.get("keywords", []), ensure_ascii=False),
                json.dumps(tool["parameters"], ensure_ascii=False, sort_keys=True), json.dumps(tool["examples"], ensure_ascii=False),
                tool["confirmation"], tool.get("version", "1.0.0"), tool.get("status", "available"),
                json.dumps(tool.get("resultSchema", {"$ref": "https://cue.local/schemas/cue-display-v1.schema.json"}), ensure_ascii=False, sort_keys=True),
                tool["id"],
            ),
        )
        connection.execute("DELETE FROM tool_examples WHERE tool_id=?", (tool["id"],))
        examples = [item if isinstance(item, dict) else {"text": item} for item in tool["examples"]]
        connection.executemany(
            "INSERT INTO tool_examples VALUES(?,?,?,?)",
            [(f"{tool['id']}:{ordinal}", tool["id"], item["text"], ordinal) for ordinal, item in enumerate(examples, 1)],
        )
        retrieval_records = [("description", tool["description"], None, f"{tool['id']}:0")]
        retrieval_records.extend(("keyword", value, None, f"{tool['id']}:keyword:{index}") for index, value in enumerate(tool.get("keywords", [])))
        retrieval_records.extend(("example", item["text"], item.get("locale"), f"{tool['id']}:{index}") for index, item in enumerate(examples, 1))
        expected_ids = set()
        for source_type, text, locale, record_id in retrieval_records:
            expected_ids.add(record_id)
            content_hash = hashlib.sha256(f"{source_type}\0{text}\0{locale or ''}".encode("utf-8")).hexdigest()
            old = connection.execute("SELECT content_hash FROM tool_retrieval_records WHERE id=?", (record_id,)).fetchone()
            connection.execute(
                "INSERT INTO tool_retrieval_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,tool_id=excluded.tool_id,source_type=excluded.source_type,text=excluded.text,locale=excluded.locale,content_hash=excluded.content_hash",
                (record_id, tool["providerId"], tool["id"], source_type, text, locale, content_hash),
            )
            embedding_id = f"embedding:{record_id}"
            if old and old[0] == content_hash:
                continue
            embedding = connection.execute("SELECT id FROM embeddings WHERE namespace='tool' AND owner_type='tool_retrieval' AND owner_id=? AND model_id=? AND model_version=?", (record_id, MODEL_ID, MODEL_VERSION)).fetchone()
            if embedding:
                connection.execute("UPDATE embeddings SET vector=NULL,status='pending',tokenizer=?,preprocessing=?,dimensions=?,pooling='mean',normalized=1,similarity_metric='cosine' WHERE id=?", (TOKENIZER_ID, PREPROCESSING, DIMENSIONS, embedding[0]))
            else:
                connection.execute(
                    "INSERT INTO embeddings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
                    (embedding_id, "tool", "tool_retrieval", record_id, MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine", "pending"),
                )
        stale = connection.execute("SELECT id FROM tool_retrieval_records WHERE tool_id=?", (tool["id"],)).fetchall()
        for (record_id,) in stale:
            if record_id not in expected_ids:
                connection.execute("DELETE FROM embeddings WHERE owner_type='tool_retrieval' AND owner_id=?", (record_id,))
                connection.execute("DELETE FROM tool_retrieval_records WHERE id=?", (record_id,))
    for provider in providers:
        if connection.execute("SELECT 1 FROM providers WHERE id=?", (provider["id"],)).fetchone():
            manifest = {**provider, "toolIds": tool_ids_by_provider.get(provider["id"], [])}
            connection.execute("UPDATE providers SET name=?,description=?,version=?,status=?,manifest_json=?,adapter_id=?,transport=?,demo=? WHERE id=?", (
                provider["name"], provider["description"], provider["version"], provider["status"],
                json.dumps(manifest, ensure_ascii=False, sort_keys=True), provider["adapter"], provider["transport"],
                int(provider["demo"]), provider["id"],
            ))
    connection.execute(
        "INSERT INTO settings(key,value_json) VALUES('tool_retrieval',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        (json.dumps(retrieval_config, ensure_ascii=False, sort_keys=True),),
    )
    connection.execute("""
        CREATE TABLE IF NOT EXISTS conversation_state(
            conversation_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS operation_results(
            operation_id TEXT PRIMARY KEY,
            tool_id TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('executing','completed','failed')),
            result_json TEXT,
            error_text TEXT,
            updated_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS provider_data_index(
            provider_id TEXT NOT NULL,
            record_type TEXT NOT NULL,
            record_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at TEXT,
            PRIMARY KEY(provider_id,record_type,record_id)
        )
    """)
    connection.commit()


def session_database(session_id):
    path = _session_path(session_id)
    with _session_lock(session_id):
        if not path.exists():
            _copy_baseline(path)
        connection = sqlite3.connect(path)
        try:
            _sync_session_manifests(connection)
        finally:
            connection.close()
    return path


def reset_session(session_id):
    path = _session_path(session_id)
    with _session_lock(session_id):
        _copy_baseline(path)
    return path


def load_conversation_state(session_id):
    connection = sqlite3.connect(session_database(session_id))
    try:
        row = connection.execute(
            "SELECT payload_json,expires_at FROM conversation_state ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        if row[1] <= datetime.now(timezone.utc).isoformat():
            connection.execute("DELETE FROM conversation_state")
            connection.commit()
            return None
        return json.loads(row[0])
    finally:
        connection.close()


def save_conversation_state(session_id, state):
    if not isinstance(state, dict) or state.get("status") not in {
        "awaiting_tool_choice", "awaiting_argument", "awaiting_entity_choice",
        "awaiting_confirmation", "executing", "completed", "failed", "cancelled",
    }:
        raise ValueError("Conversation state is invalid")
    conversation_id = state.get("conversationId")
    if not isinstance(conversation_id, str) or not conversation_id:
        raise ValueError("Conversation state requires an ID")
    payload = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 262144:
        raise ValueError("Conversation state is too large")
    now = datetime.now(timezone.utc)
    expiry = state.get("expiresAt")
    try:
        expires_at = datetime.fromisoformat(expiry.replace("Z", "+00:00")) if isinstance(expiry, str) else now + timedelta(hours=24)
    except ValueError as exc:
        raise ValueError("Conversation expiry must be an ISO-8601 timestamp") from exc
    if expires_at.tzinfo is None or expires_at <= now or expires_at > now + timedelta(hours=24, minutes=5):
        expires_at = now + timedelta(hours=24)
    connection = sqlite3.connect(session_database(session_id))
    try:
        connection.execute("DELETE FROM conversation_state")
        connection.execute(
            "INSERT INTO conversation_state VALUES(?,?,?,?)",
            (conversation_id, payload, now.isoformat(), expires_at.isoformat()),
        )
        connection.commit()
    finally:
        connection.close()
    return {"saved": True, "expiresAt": expires_at.isoformat()}


def connect_readonly(path):
    path = Path(path).resolve()
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _provider_data_content(config, record):
    values = []
    for field in config.get("fields", []):
        value = record.get(field)
        if isinstance(value, list):
            values.extend(item for item in value if isinstance(item, str))
        elif isinstance(value, str):
            values.append(value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            values.append(str(int(value)) if isinstance(value, float) and value.is_integer() else str(value))
    return "\n".join(values).strip()


def _provider_data_key(provider_id, record_type, record_id):
    return f"{provider_id}:{record_type}:{record_id}"


def _sync_provider_data_index(connection):
    providers = {
        row["id"]: json.loads(row["manifest_json"])
        for row in connection.execute("SELECT id,manifest_json FROM providers")
    }
    expected = {}
    for provider_id, provider in providers.items():
        config = provider.get("contextSearch")
        if not config:
            continue
        allowed_types = set(config.get("recordTypes", []))
        for row in connection.execute("SELECT record_type,record_id,payload_json FROM records WHERE provider_id=?", (provider_id,)):
            record_type = row["record_type"]
            if record_type not in allowed_types:
                continue
            content = _provider_data_content(config, json.loads(row["payload_json"]))
            if not content:
                continue
            key = _provider_data_key(provider_id, record_type, row["record_id"])
            expected[(provider_id, record_type, row["record_id"])] = (key, hashlib.sha256(content.encode("utf-8")).hexdigest())
    existing = {
        (row["provider_id"], row["record_type"], row["record_id"]): (row["content_hash"], row["indexed_at"], row["status"])
        for row in connection.execute("""SELECT p.provider_id,p.record_type,p.record_id,p.content_hash,p.indexed_at,e.status
            FROM provider_data_index p LEFT JOIN embeddings e
            ON e.namespace='provider-data' AND e.owner_type='provider_record'
                AND e.owner_id=(p.provider_id || ':' || p.record_type || ':' || p.record_id)
                AND e.model_id=? AND e.model_version=?""", (MODEL_ID, MODEL_VERSION))
    }
    for record_key, (owner_id, content_hash) in expected.items():
        old = existing.get(record_key)
        if old and old[0] == content_hash and old[1] and old[2] == "ready":
            continue
        provider_id, record_type, record_id = record_key
        connection.execute(
            "INSERT INTO provider_data_index VALUES(?,?,?,?,NULL) ON CONFLICT(provider_id,record_type,record_id) DO UPDATE SET content_hash=excluded.content_hash,indexed_at=NULL",
            (provider_id, record_type, record_id, content_hash),
        )
        embedding = connection.execute(
            "SELECT id FROM embeddings WHERE namespace='provider-data' AND owner_type='provider_record' AND owner_id=? AND model_id=? AND model_version=?",
            (owner_id, MODEL_ID, MODEL_VERSION),
        ).fetchone()
        if embedding:
            connection.execute("UPDATE embeddings SET vector=NULL,status='pending' WHERE id=?", (embedding[0],))
        else:
            connection.execute(
                "INSERT INTO embeddings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
                (f"provider-embedding:{owner_id}", "provider-data", "provider_record", owner_id, MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS, "mean", 1, "cosine", "pending"),
            )
    for record_key in set(existing) - set(expected):
        owner_id = _provider_data_key(*record_key)
        connection.execute("DELETE FROM embeddings WHERE namespace='provider-data' AND owner_type='provider_record' AND owner_id=?", (owner_id,))
        connection.execute("DELETE FROM provider_data_index WHERE provider_id=? AND record_type=? AND record_id=?", record_key)
    connection.commit()
    return [
        owner_id for record_key, (owner_id, content_hash) in expected.items()
        if record_key not in existing or existing[record_key][0] != content_hash
        or not existing[record_key][1] or existing[record_key][2] != "ready"
    ]


def store_provider_data_embeddings(session_id, entries):
    if not isinstance(entries, list) or not entries or len(entries) > 100:
        raise ValueError("Provider-data embedding entries must be a non-empty batch of at most 100 records")
    with _session_lock(session_id):
        connection = sqlite3.connect(session_database(session_id))
        connection.row_factory = sqlite3.Row
        try:
            _sync_provider_data_index(connection)
            accepted = 0
            for entry in entries:
                if not isinstance(entry, dict):
                    raise ValueError("Provider-data embedding entry must be an object")
                provider_id, record_type, record_id = entry.get("providerId"), entry.get("recordType"), entry.get("recordId")
                if not all(isinstance(value, str) and value for value in (provider_id, record_type, record_id)):
                    raise ValueError("Provider-data embedding entry requires provider, record type, and record ID")
                owner_id = _provider_data_key(provider_id, record_type, record_id)
                expected = connection.execute(
                    "SELECT p.content_hash,e.id,e.status FROM provider_data_index p JOIN embeddings e ON e.namespace='provider-data' AND e.owner_type='provider_record' AND e.owner_id=? AND e.model_id=? AND e.model_version=? WHERE p.provider_id=? AND p.record_type=? AND p.record_id=?",
                    (owner_id, MODEL_ID, MODEL_VERSION, provider_id, record_type, record_id),
                ).fetchone()
                if not expected:
                    raise ValueError(f"Provider-data record is not registered for indexing: {owner_id}")
                if entry.get("contentHash") != expected[0]:
                    raise ValueError(f"Provider-data record changed while its embedding was being generated: {owner_id}")
                vector = entry.get("vector")
                if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector):
                    raise ValueError(f"Provider-data embedding must contain {DIMENSIONS} finite numbers")
                norm = math.sqrt(sum(float(value) ** 2 for value in vector))
                if abs(norm - 1.0) > 0.002:
                    raise ValueError("Provider-data embeddings must be L2-normalized")
                blob = struct.pack("<" + "f" * DIMENSIONS, *vector)
                connection.execute("UPDATE embeddings SET vector=?,status='ready' WHERE id=?", (blob, expected[1]))
                connection.execute(
                    "UPDATE provider_data_index SET indexed_at=? WHERE provider_id=? AND record_type=? AND record_id=? AND content_hash=?",
                    (datetime.now(timezone.utc).isoformat(), provider_id, record_type, record_id, expected[0]),
                )
                accepted += 1
            connection.commit()
            return accepted
        finally:
            connection.close()


def search_provider_data(session_id, vector, provider_ids, limit=3, threshold=0.3):
    if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector):
        raise ValueError(f"Provider-data query vector must contain {DIMENSIONS} finite numbers")
    norm = math.sqrt(sum(float(value) ** 2 for value in vector))
    if abs(norm - 1.0) > 0.002:
        raise ValueError("Provider-data query vector must be L2-normalized")
    if not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or threshold < -1 or threshold > 1:
        raise ValueError("Provider-data similarity threshold must be between -1 and 1")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError("Provider-data result limit must be a positive integer")
    if not isinstance(provider_ids, list) or any(not isinstance(value, str) for value in provider_ids):
        raise ValueError("Provider-data provider IDs must be a list of strings")
    providers = list(dict.fromkeys(provider_ids))[:20]
    if not providers:
        return {}
    connection = sqlite3.connect(session_database(session_id))
    connection.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" for _ in providers)
        rows = connection.execute(
            f"""SELECT p.provider_id,p.record_type,p.record_id,p.content_hash,p.indexed_at,r.payload_json,e.vector
                FROM provider_data_index p
                JOIN records r ON r.provider_id=p.provider_id AND r.record_type=p.record_type AND r.record_id=p.record_id
                JOIN embeddings e ON e.namespace='provider-data' AND e.owner_type='provider_record'
                    AND e.owner_id=(p.provider_id || ':' || p.record_type || ':' || p.record_id)
                    AND e.status='ready' AND e.model_id=? AND e.model_version=?
                WHERE p.provider_id IN ({placeholders}) AND p.indexed_at IS NOT NULL""",
            (MODEL_ID, MODEL_VERSION, *providers),
        ).fetchall()
        # Re-evaluate content hashes so stale records cannot contribute evidence.
        config_by_provider = {
            row["id"]: json.loads(row["manifest_json"]).get("contextSearch", {})
            for row in connection.execute("SELECT id,manifest_json FROM providers")
        }
        by_provider = {provider_id: [] for provider_id in providers}
        indexed_at_by_provider = {}
        query = [float(value) for value in vector]
        for row in rows:
            content = _provider_data_content(config_by_provider.get(row["provider_id"], {}), json.loads(row["payload_json"]))
            if hashlib.sha256(content.encode("utf-8")).hexdigest() != row["content_hash"]:
                continue
            indexed_at_by_provider[row["provider_id"]] = max(
                indexed_at_by_provider.get(row["provider_id"], ""), row["indexed_at"],
            )
            stored = struct.unpack("<" + "f" * DIMENSIONS, row["vector"])
            similarity = sum(left * right for left, right in zip(query, stored))
            if similarity < float(threshold):
                continue
            by_provider.setdefault(row["provider_id"], []).append({
                "recordId": row["record_id"],
                "recordType": row["record_type"],
                "record": json.loads(row["payload_json"]),
                "similarity": similarity,
                "indexedAt": row["indexed_at"],
            })
        return {
            provider_id: {
                "namespace": "provider-data",
                "indexedAt": indexed_at_by_provider.get(provider_id),
                "hits": sorted(hits, key=lambda hit: hit["similarity"], reverse=True)[:max(1, min(int(limit), 10))],
            }
            for provider_id, hits in by_provider.items()
        }
    finally:
        connection.close()


def registry(session_id):
    connection = sqlite3.connect(session_database(session_id))
    connection.row_factory = sqlite3.Row
    try:
        pending_provider_data = _sync_provider_data_index(connection)
        manifest_by_id = {tool["id"]: tool for tool in json.loads((ROOT / "data" / "seed" / "tool-manifests.json").read_text(encoding="utf-8"))}
        providers = [dict(row) for row in connection.execute("SELECT id,name,description,version,status,manifest_json,adapter_id,transport,demo FROM providers ORDER BY id")]
        for provider in providers:
            provider["manifest"] = json.loads(provider.pop("manifest_json"))
            provider["demo"] = bool(provider["demo"])
        tools = []
        for row in connection.execute("SELECT * FROM tools ORDER BY provider_id,tool_key"):
            item = dict(row)
            item["parameters"] = json.loads(item.pop("parameters_json"))
            item["keywords"] = json.loads(item.pop("keywords_json"))
            item["examples"] = json.loads(item.pop("examples_json"))
            item["resultSchema"] = json.loads(item.pop("result_schema_json"))
            item["providerId"] = item.pop("provider_id")
            item["executionAdapter"] = item.pop("execution_adapter")
            item["version"] = item.pop("version")
            item["available"] = item.pop("status") == "available"
            metadata = manifest_by_id.get(item["id"], {})
            item["operationType"] = metadata.get("operationType")
            item["effect"] = metadata.get("effect")
            item["requiredPermissions"] = metadata.get("requiredPermissions", [])
            if metadata.get("contextSearch"):
                item["contextSearch"] = metadata["contextSearch"]
            tools.append(item)
        data = {}
        for row in connection.execute("SELECT provider_id,record_type,record_id,payload_json FROM records ORDER BY provider_id,record_type,record_id"):
            data.setdefault(row["provider_id"], {}).setdefault(row["record_type"], []).append(json.loads(row["payload_json"]))
        embedding_state = connection.execute("SELECT COUNT(*) AS total,SUM(CASE WHEN e.status='ready' THEN 1 ELSE 0 END) AS ready FROM tool_retrieval_records r JOIN embeddings e ON e.owner_type='tool_retrieval' AND e.owner_id=r.id WHERE e.namespace='tool' AND e.model_id=? AND e.model_version=? AND e.tokenizer=? AND e.preprocessing=? AND e.dimensions=? AND e.pooling='mean' AND e.normalized=1 AND e.similarity_metric='cosine'", (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS)).fetchone()
        pending_embeddings = [row[0] for row in connection.execute("SELECT r.id FROM tool_retrieval_records r JOIN embeddings e ON e.owner_type='tool_retrieval' AND e.owner_id=r.id WHERE e.status!='ready' ORDER BY r.id")]
        retrieval_config_row = connection.execute("SELECT value_json FROM settings WHERE key='tool_retrieval'").fetchone()
        retrieval_config = json.loads(retrieval_config_row[0]) if retrieval_config_row else {}
        demo_clock_row = connection.execute("SELECT value_json FROM settings WHERE key='demo_clock'").fetchone()
        demo_clock = json.loads(demo_clock_row[0]) if demo_clock_row else None
        assets = [dict(row) for row in connection.execute("SELECT * FROM assets ORDER BY id")]
        for asset in assets:
            asset["mimeType"] = asset.pop("mime_type")
            asset["originalRef"] = asset.pop("original_ref")
            asset["metadata"] = json.loads(asset.pop("metadata_json"))
        data.setdefault("web", {})["assets"] = assets
        return {"providers": providers, "tools": tools, "data": data, "demoClock": demo_clock, "toolEmbeddingsReady": embedding_state["total"] > 0 and embedding_state["ready"] == embedding_state["total"], "pendingToolEmbeddingIds": pending_embeddings, "pendingProviderDataIds": pending_provider_data, "toolRetrievalConfig": retrieval_config}
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
            if isinstance(schema.get("anyOf"), list):
                branches = []
                for branch in schema["anyOf"]:
                    if not branch.get("type") and isinstance(branch.get("required"), list):
                        if all(key in value for key in branch["required"]):
                            branches.append(True)
                    elif not validate_arguments(branch, value, path, []):
                        branches.append(True)
                if not branches:
                    errors.append(f"{path}: no anyOf alternative matched")
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
            if not isinstance(entry, dict) or not isinstance(entry.get("recordId", entry.get("exampleId")), str):
                raise ValueError("Each tool embedding requires a registered recordId")
            vector = entry.get("vector")
            if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector):
                raise ValueError(f"Each tool embedding must contain {DIMENSIONS} finite numbers")
            norm = math.sqrt(sum(float(v) ** 2 for v in vector))
            if abs(norm - 1.0) > 0.002:
                raise ValueError("Tool embeddings must be L2-normalized")
            record_id = entry.get("recordId", entry.get("exampleId"))
            cursor = connection.execute("UPDATE embeddings SET vector=?,status='ready' WHERE id=? AND namespace='tool' AND owner_type='tool_retrieval' AND owner_id=? AND model_id=?", (struct.pack("<" + "f" * DIMENSIONS, *[float(v) for v in vector]), f"embedding:{record_id}", record_id, MODEL_ID))
            if cursor.rowcount != 1:
                raise ValueError("Embedding owner is not a registered tool example")
        connection.commit()
        return len(entries)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def search_tools(session_id, vector, limit=20, threshold=0.0, scoring="weighted-max", weights=None):
    if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector):
        raise ValueError(f"Query embedding must contain {DIMENSIONS} finite numbers")
    weights = weights or {"description": 0.35, "keyword": 0.3, "example": 0.35}
    if scoring not in {"weighted-max", "max", "top-k"} or not isinstance(weights, dict) or any(not isinstance(value, (int, float)) or value < 0 for value in weights.values()):
        raise ValueError("Unsupported tool retrieval scoring configuration")
    path = session_database(session_id)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute("SELECT t.id,t.provider_id,t.name,t.description,t.parameters_json,t.confirmation,t.status,p.status AS provider_status,r.source_type,e.vector FROM tool_retrieval_records r JOIN embeddings e ON e.owner_type='tool_retrieval' AND e.owner_id=r.id JOIN tools t ON t.id=r.tool_id JOIN providers p ON p.id=t.provider_id WHERE e.namespace='tool' AND e.status='ready' AND e.model_id=? AND e.model_version=? AND e.tokenizer=? AND e.preprocessing=? AND e.dimensions=? AND e.pooling='mean' AND e.normalized=1 AND e.similarity_metric='cosine' AND p.status='available' AND t.status='available'", (MODEL_ID, MODEL_VERSION, TOKENIZER_ID, PREPROCESSING, DIMENSIONS)).fetchall()
        grouped = {}
        for row in rows:
            stored = struct.unpack("<" + "f" * DIMENSIONS, row["vector"])
            similarity = sum(float(left) * right for left, right in zip(vector, stored))
            grouped.setdefault(row["id"], []).append((similarity, row["source_type"], row))
        results = []
        for matches in grouped.values():
            by_type = {kind: sorted((score for score, source, _ in matches if source == kind), reverse=True) for kind in ("description", "keyword", "example")}
            source_scores = {kind: (values[0] if values else -1) for kind, values in by_type.items()}
            if scoring == "top-k":
                source_scores = {kind: (sum(values[:2]) / min(2, len(values)) if values else -1) for kind, values in by_type.items()}
            if scoring == "max":
                score = max(source_scores.values())
            else:
                available = [kind for kind, value in source_scores.items() if value >= 0]
                weight_total = sum(weights.get(kind, 0) for kind in available) or len(available)
                score = sum(source_scores[kind] * (weights.get(kind, 1 / len(available)) / weight_total) for kind in available)
            if score < threshold: continue
            row = matches[0][2]
            results.append({"toolId": row["id"], "providerId": row["provider_id"], "name": row["name"], "description": row["description"], "parameters": json.loads(row["parameters_json"]), "bestDescriptionSimilarity": source_scores["description"], "bestKeywordSimilarity": source_scores["keyword"], "bestExampleSimilarity": source_scores["example"], "score": score, "recordCount": len(matches)})
        results.sort(key=lambda item: item["score"], reverse=True)
        for index, item in enumerate(results):
            item["margin"] = item["score"] - (results[index + 1]["score"] if index + 1 < len(results) else 0)
        return results[:max(1, min(int(limit), 50))]
    finally:
        connection.close()


def execute_tool(session_id, tool_id, arguments, operation_id=None):
    from demo_providers import ADAPTERS

    path = session_database(session_id)
    with _session_lock(session_id):
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        try:
            row = connection.execute("SELECT t.*,p.status AS provider_status,p.manifest_json AS provider_manifest FROM tools t JOIN providers p ON p.id=t.provider_id WHERE t.id=?", (tool_id,)).fetchone()
            if row is None:
                raise LookupError(f"Unknown registered tool: {tool_id}")
            if row["status"] != "available" or row["provider_status"] != "available":
                raise RuntimeError(f"Provider unavailable: {row['provider_id']}")
            manifests = json.loads((ROOT / "data" / "seed" / "tool-manifests.json").read_text(encoding="utf-8"))
            metadata = next((tool for tool in manifests if tool["id"] == tool_id), {})
            required_permissions = set(metadata.get("requiredPermissions", []))
            provider_permissions = set(json.loads(row["provider_manifest"]).get("permissions", []))
            if not required_permissions.issubset(provider_permissions):
                raise PermissionError(f"Provider lacks execution permission for {tool_id}")
            errors = validate_arguments(json.loads(row["parameters_json"]), arguments)
            if errors:
                raise ValueError("Invalid arguments: " + "; ".join(errors))
            adapter = ADAPTERS.get(row["execution_adapter"])
            if adapter is None:
                raise RuntimeError("Provider adapter is not trusted or registered")
            side_effect = row["confirmation"] == "required"
            payload_hash = hashlib.sha256(json.dumps({"toolId": tool_id, "arguments": arguments}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
            if side_effect and operation_id is not None:
                if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 160:
                    raise ValueError("Invalid operation identifier")
                prior = connection.execute("SELECT tool_id,payload_hash,status,result_json FROM operation_results WHERE operation_id=?", (operation_id,)).fetchone()
                if prior:
                    if prior["tool_id"] != tool_id or prior["payload_hash"] != payload_hash:
                        raise ValueError("Operation identifier was already used for a different action or argument set")
                    if prior["status"] == "completed":
                        return json.loads(prior["result_json"])
                    raise RuntimeError(f"Operation cannot be safely repeated after status {prior['status']}")
                connection.execute(
                    "INSERT INTO operation_results(operation_id,tool_id,payload_hash,status,updated_at) VALUES(?,?,?,'executing',?)",
                    (operation_id, tool_id, payload_hash, datetime.now(timezone.utc).isoformat()),
                )
                connection.commit()
            try:
                result = adapter.execute(connection, row["provider_id"], tool_id, arguments)
            except Exception as exc:
                if side_effect and operation_id is not None:
                    connection.execute("UPDATE operation_results SET status='failed',error_text=?,updated_at=? WHERE operation_id=?", (str(exc)[:1000], datetime.now(timezone.utc).isoformat(), operation_id))
                    connection.commit()
                raise
            if side_effect and operation_id is not None:
                connection.execute("UPDATE operation_results SET status='completed',result_json=?,error_text=NULL,updated_at=? WHERE operation_id=?", (
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")), datetime.now(timezone.utc).isoformat(), operation_id,
                ))
                connection.commit()
            return result
        finally:
            connection.close()
