import http.client
import ipaddress
import json
import math
import os
import secrets
import socket
import threading
from http.cookies import SimpleCookie
import sqlite3
import struct
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "semantic_mastery.db"
HOST = "127.0.0.1"


def load_backend_env():
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip().strip("\"'")
        if name in {"LLM_API_KEY", "ALLOW_LOCAL_LLM", "BACKEND_PORT"} and name not in os.environ:
            os.environ[name] = value


load_backend_env()
PORT = int(os.environ.get("BACKEND_PORT", "8000"))
KEY = os.environ.get("LLM_API_KEY", "")
ALLOW_LOCAL = os.environ.get("ALLOW_LOCAL_LLM", "") == "1"
SESSIONS: dict[str, str] = {}
SESSIONS_LOCK = threading.Lock()
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:5174", "http://127.0.0.1:5174"}


def decode_vector(blob: bytes, dimension: int) -> list[float]:
    # Existing embeddings are Python protocol-5 lists of BINFLOAT values.
    if len(blob) < 14 or blob[:2] != b"\x80\x05" or blob[11:14] != b"]\x94(":
        raise ValueError("Unrecognized stored embedding format")
    values = []
    offset = 14
    while offset + 9 <= len(blob) and blob[offset:offset + 1] == b"G":
        values.append(struct.unpack(">d", blob[offset + 1:offset + 9])[0])
        offset += 9
    if len(values) != dimension or blob[offset:] != b"e.":
        raise ValueError("Stored embedding dimension/encoding mismatch")
    return values


def search_notes(vector: list[float], limit: int = 8) -> list[dict]:
    if len(vector) != 384:
        raise ValueError("Query embedding must have 384 dimensions")
    db = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
    try:
        rows = db.execute("""SELECT s.note_id,s.embedding,s.embedding_dimension,c.text,c.card_id,d.deck_name
          FROM semantic_notes s JOIN cards c ON c.note_id=s.note_id
          LEFT JOIN decks d ON d.deck_id=c.deck_id
          WHERE s.embedding_status='ready' AND s.embedding_model='paraphrase-multilingual-MiniLM-L12-v2'
            AND s.embedding IS NOT NULL ORDER BY c.card_id""").fetchall()
        best: dict[int, dict] = {}
        for note_id, blob, dimension, text, card_id, deck in rows:
            if dimension != 384 or not text:
                continue
            stored = decode_vector(blob, dimension)
            score = sum(a * b for a, b in zip(vector, stored))
            if note_id not in best or score > best[note_id]["score"]:
                best[note_id] = {"note_id": note_id, "card_id": card_id, "deck": deck, "text": text, "score": score}
        return sorted(best.values(), key=lambda row: row["score"], reverse=True)[:max(1, min(limit, 20))]
    finally:
        db.close()


def validate_endpoint(endpoint: str) -> str:
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Endpoint must be a valid HTTPS URL without embedded credentials or fragments")
    if parsed.scheme != "https" and not ALLOW_LOCAL:
        raise ValueError("HTTP endpoints require backend ALLOW_LOCAL_LLM=1 opt-in")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))}
    except OSError as exc:
        raise ValueError("Endpoint host could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global and not (ALLOW_LOCAL and (ip.is_loopback or ip.is_private)):
            raise ValueError("Endpoint resolves to a private or reserved network destination")
    if not addresses:
        raise ValueError("Endpoint host did not resolve")
    if parsed.scheme != "https" and any(ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("Non-HTTPS endpoints are allowed only for explicitly opted-in local/private LLMs")
    pinned_address = next(iter(addresses))
    return endpoint.rstrip("/"), pinned_address


def parse_llm_result(content) -> dict:
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    try:
        result = json.loads(content)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("LLM returned invalid JSON") from exc
    if not isinstance(result, dict) or set(result) != {"version", "display_text"} or type(result.get("version")) is not int or result["version"] != 1 or not isinstance(result.get("display_text"), str):
        raise ValueError("LLM response does not match required schema {version: 1, display_text: string}")
    if len(result["display_text"].encode("utf-8")) > 512:
        raise ValueError("LLM display_text exceeds the watch's 512-byte limit")
    return result


class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, pinned_address, **kwargs):
        super().__init__(host, **kwargs)
        self.pinned_address = pinned_address

    def connect(self):
        self.sock = socket.create_connection((self.pinned_address, self.port), self.timeout, self.source_address)


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, pinned_address, **kwargs):
        super().__init__(host, **kwargs)
        self.pinned_address = pinned_address

    def connect(self):
        self.sock = socket.create_connection((self.pinned_address, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


class PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_address):
        super().__init__()
        self.pinned_address = pinned_address

    def http_open(self, req):
        return self.do_open(lambda host, **kwargs: PinnedHTTPConnection(host, self.pinned_address, **kwargs), req)


class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, pinned_address):
        super().__init__()
        self.pinned_address = pinned_address

    def https_open(self, req):
        return self.do_open(lambda host, **kwargs: PinnedHTTPSConnection(host, self.pinned_address, **kwargs), req, context=self._context)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "BangleMemory/1"

    def log_message(self, fmt, *args):
        print("backend:", fmt % args)

    def send_headers(self, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers_origin
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if extra:
            for k, v in extra.items(): self.send_header(k, v)
        self.end_headers()

    @property
    def headers_origin(self):
        return self.headers.get("Origin", "")

    def json_response(self, obj, status=200, extra=None):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_headers(status, extra)
        self.wfile.write(raw)

    def do_OPTIONS(self):
        if self.headers_origin not in ALLOWED_ORIGINS:
            return self.json_response({"error": "Origin not allowed"}, 403)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers_origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def body(self):
        if self.headers_origin not in ALLOWED_ORIGINS:
            raise PermissionError("Request origin is not allowed")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise PermissionError("Cross-site request rejected")
        size = int(self.headers.get("Content-Length", "0"))
        if size > 65536: raise ValueError("Request is too large")
        data = json.loads(self.rfile.read(size) or b"{}")
        cookie_header = self.headers.get("Cookie", "")
        try:
            cookies = SimpleCookie()
            cookies.load(cookie_header)
            sid = cookies.get("bm_sid").value if cookies.get("bm_sid") else ""
        except Exception:
            sid = ""
        csrf_token = self.headers.get("X-CSRF-Token", "")
        with SESSIONS_LOCK:
            expected_token = SESSIONS.get(sid, "") if sid else ""
        if not sid or not expected_token or not secrets.compare_digest(expected_token, csrf_token):
            reason = "missing_cookie" if not sid else "unknown_session" if not expected_token else "token_mismatch"
            print(f"session validation failed: reason={reason} method=POST path={self.path} cookie_present={bool(cookie_header)} origin_allowed={self.headers_origin in ALLOWED_ORIGINS}")
            raise PermissionError("Session/CSRF validation failed")
        return data

    def do_GET(self):
        if self.headers_origin and self.headers_origin not in ALLOWED_ORIGINS:
            return self.json_response({"error": "Origin not allowed"}, 403)
        if self.path != "/api/session": return self.json_response({"error": "Not found"}, 404)
        sid, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
        with SESSIONS_LOCK:
            SESSIONS[sid] = token
        self.json_response({"csrfToken": token}, extra={"Set-Cookie": f"bm_sid={sid}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600"})

    def do_POST(self):
        try:
            data = self.body()
            if self.path == "/api/search":
                vector = data.get("vector")
                if not isinstance(vector, list) or len(vector) != 384 or any(type(x) not in (int, float) or not math.isfinite(x) for x in vector):
                    raise ValueError("Expected a 384-dimensional embedding vector")
                return self.json_response({"results": search_notes(vector, int(data.get("limit", 8)))})
            if self.path == "/api/interpret":
                if not KEY: raise ValueError("Backend LLM_API_KEY is not configured")
                transcript, model = data.get("transcript", ""), data.get("model", "")
                prompt = data.get("prompt", "")
                endpoint, pinned_address = validate_endpoint(data.get("endpoint", ""))
                if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 12000: raise ValueError("Transcript must contain 1-12000 characters")
                if not isinstance(model, str) or not model.strip() or len(model) > 200: raise ValueError("Model is required")
                if not isinstance(prompt, str) or len(prompt) > 4000: raise ValueError("Prompt must be at most 4000 characters")
                url = endpoint if endpoint.endswith("/chat/completions") else endpoint + "/chat/completions"
                schema = {"type":"object","properties":{"version":{"type":"integer","const":1},"display_text":{"type":"string"}},"required":["version","display_text"],"additionalProperties":False}
                messages = [{"role":"system","content": prompt or "Return concise useful information."},{"role":"user","content": transcript}]
                payload = {"model": model, "messages": messages, "response_format":{"type":"json_schema","json_schema":{"name":"bangle_memory_result","strict":True,"schema":schema}}}
                request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + KEY, "Content-Type":"application/json"}, method="POST")
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), PinnedHTTPHandler(pinned_address), PinnedHTTPSHandler(pinned_address))
                try:
                    with opener.open(request, timeout=45) as response: body = json.loads(response.read(1_000_000))
                except urllib.error.HTTPError as exc:
                    if exc.code not in (400, 422): raise ValueError(f"LLM endpoint returned HTTP {exc.code}")
                    payload.pop("response_format", None)
                    messages[0]["content"] += '\nReturn only JSON matching {"version":1,"display_text":"string"}.'
                    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + KEY, "Content-Type":"application/json"}, method="POST")
                    with opener.open(request, timeout=45) as response: body = json.loads(response.read(1_000_000))
                result = parse_llm_result(body["choices"][0]["message"]["content"])
                return self.json_response(result)
            return self.json_response({"error": "Not found"}, 404)
        except PermissionError as exc: return self.json_response({"error": str(exc)}, 403)
        except (ValueError, KeyError, TypeError, OSError, urllib.error.URLError) as exc: return self.json_response({"error": str(exc)}, 400)
        except Exception as exc: return self.json_response({"error": f"Backend request failed ({type(exc).__name__})"}, 502)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
