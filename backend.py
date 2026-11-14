import json
import os
import secrets
import sqlite3
import threading
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cue_env import load_backend_env
from demo_database import execute_tool, load_conversation_state, registry, reset_session, save_conversation_state, search_provider_data, search_tools, seed_path, session_database, store_provider_data_embeddings, store_tool_embeddings
from openrouter_normalizer import NormalizerError, generate as generate_normalization

HOST = "127.0.0.1"
SESSIONS: dict[str, str] = {}
SESSIONS_LOCK = threading.Lock()
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:5174", "http://127.0.0.1:5174"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Cue/1"

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

    def session_id(self):
        try:
            cookies = SimpleCookie()
            cookies.load(self.headers.get("Cookie", ""))
            sid = cookies.get("bm_sid").value if cookies.get("bm_sid") else ""
        except Exception:
            sid = ""
        with SESSIONS_LOCK:
            return sid if sid in SESSIONS else ""

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
        if size > 262144: raise ValueError("Request is too large")
        data = json.loads(self.rfile.read(size) or b"{}")
        cookie_header = self.headers.get("Cookie", "")
        sid = self.session_id()
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
        if self.path == "/api/session":
            sid = self.session_id()
            with SESSIONS_LOCK:
                token = SESSIONS.get(sid) if sid else None
                if not token:
                    sid, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
                    SESSIONS[sid] = token
            return self.json_response({"csrfToken": token}, extra={"Set-Cookie": f"bm_sid={sid}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600"})
        if self.path == "/api/demo/registry":
            sid = self.session_id()
            if not sid: return self.json_response({"error": "Demo session required"}, 403)
            try:
                return self.json_response(registry(sid))
            except (FileNotFoundError, OSError) as exc:
                return self.json_response({"error": str(exc)}, 503)
        if self.path == "/api/demo/conversation":
            sid = self.session_id()
            if not sid: return self.json_response({"error": "Demo session required"}, 403)
            try:
                return self.json_response({"state": load_conversation_state(sid)})
            except (FileNotFoundError, OSError, ValueError) as exc:
                return self.json_response({"error": str(exc)}, 503)
        return self.json_response({"error": "Not found"}, 404)

    def do_POST(self):
        try:
            data = self.body()
            sid = self.session_id()
            if not sid:
                raise PermissionError("Demo session required")
            if self.path == "/api/demo/normalize":
                return self.json_response({"text": generate_normalization(data.get("prompt"))})
            if self.path == "/api/demo/respond":
                return self.json_response({"text": generate_normalization(data.get("prompt"))})
            if self.path == "/api/demo/index-tools":
                count = store_tool_embeddings(sid, data.get("entries"))
                return self.json_response({"indexed_examples": count, "namespace": "tool"})
            if self.path == "/api/demo/index-provider-data":
                count = store_provider_data_embeddings(sid, data.get("entries"))
                return self.json_response({"indexed_records": count, "namespace": "provider-data"})
            if self.path == "/api/demo/conversation":
                state = data.get("state")
                if state is None:
                    path = session_database(sid)
                    connection = sqlite3.connect(path)
                    try:
                        connection.execute("DELETE FROM conversation_state")
                        connection.commit()
                    finally:
                        connection.close()
                    return self.json_response({"cleared": True})
                return self.json_response(save_conversation_state(sid, state))
            if self.path == "/api/demo/tools/search":
                return self.json_response({"results": search_tools(sid, data.get("vector"), data.get("limit", 20), data.get("threshold", 0.0), data.get("scoring", "weighted-max"), data.get("weights"))})
            if self.path == "/api/demo/provider-data/search":
                registry(sid)
                return self.json_response({"results": search_provider_data(sid, data.get("vector"), data.get("providerIds", []), data.get("limit", 3), data.get("threshold", 0.3))})
            if self.path == "/api/demo/execute":
                tool_id = data.get("toolId")
                arguments = data.get("arguments")
                connection = sqlite3.connect(session_database(sid))
                try:
                    tool = connection.execute("SELECT confirmation FROM tools WHERE id=?", (tool_id,)).fetchone()
                finally:
                    connection.close()
                if not tool:
                    raise LookupError(f"Unknown registered tool: {tool_id}")
                if tool[0] == "required" and data.get("confirmed") is not True:
                    return self.json_response({"error": "Confirmation required", "state": "confirmation_required"}, 409)
                return self.json_response({"result": execute_tool(sid, tool_id, arguments, data.get("operationId"))})
            if self.path == "/api/demo/reset":
                reset_session(sid)
                return self.json_response({"reset": True})
            return self.json_response({"error": "Not found"}, 404)
        except PermissionError as exc: return self.json_response({"error": str(exc)}, 403)
        except NormalizerError as exc: return self.json_response({"error": str(exc)}, 502)
        except LookupError as exc: return self.json_response({"error": str(exc)}, 404)
        except (ValueError, KeyError, TypeError, OSError) as exc: return self.json_response({"error": str(exc)}, 400)
        except Exception as exc: return self.json_response({"error": f"Backend request failed ({type(exc).__name__})"}, 502)


if __name__ == "__main__":
    load_backend_env()
    port = int(os.environ.get("BACKEND_PORT", "8000"))
    if not seed_path().is_file():
        raise SystemExit(f"Synthetic demo database is missing: {seed_path()}. Run python seed_demo.py")
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()
