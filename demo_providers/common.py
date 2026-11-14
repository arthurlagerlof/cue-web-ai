import json
import re


def words(value):
    return re.findall(r"[\w]+", str(value).casefold(), flags=re.UNICODE)


def matches(query, fields):
    terms = words(query)
    haystack = {token for field in fields for token in words(field)}
    return not terms or any(term in haystack for term in terms)


def records(connection, provider_id, record_type):
    rows = connection.execute("SELECT payload_json FROM records WHERE provider_id=? AND record_type=? ORDER BY record_id", (provider_id, record_type)).fetchall()
    return [json.loads(row[0]) for row in rows]


def record(connection, provider_id, record_type, record_id):
    row = connection.execute("SELECT payload_json FROM records WHERE provider_id=? AND record_type=? AND record_id=?", (provider_id, record_type, str(record_id))).fetchone()
    return json.loads(row[0]) if row else None


def save_record(connection, provider_id, record_type, value):
    connection.execute("INSERT INTO records(provider_id,record_type,record_id,payload_json) VALUES(?,?,?,?) ON CONFLICT(provider_id,record_type,record_id) DO UPDATE SET payload_json=excluded.payload_json", (provider_id, record_type, str(value["id"]), json.dumps(value, ensure_ascii=False, sort_keys=True)))
    connection.commit()


def document(provider_id, provider_name, title, elements, state="ready", message=None, assets=None, actions=None, doc_id=None):
    result = {
        "schema": "cue.display", "version": 1,
        "id": doc_id or f"{provider_id}-{state}", "title": title,
        "source": {"app": provider_id, "name": provider_name}, "state": state,
        "pages": [{"id": f"{doc_id or provider_id}-{state}-page-1", "elements": elements}],
        "actions": actions or [], "assets": assets or [],
    }
    if message:
        result["message"] = message
    return result


def text(value, role="body"):
    return {"type": "text", "text": str(value), "role": role}


def card(title, body, caption=None):
    children = [text(title, "heading"), text(body)]
    if caption:
        children.append(text(caption, "caption"))
    return {"type": "container", "layout": "column", "children": children}


def empty(provider_id, name, title, query):
    return document(provider_id, name, title, [text(f"No results for “{query}”.")], state="empty", message="No matching results.")


def next_id(connection, provider_id, record_type, prefix):
    values = [str(item["id"]) for item in records(connection, provider_id, record_type)]
    numbers = [int(value.rsplit("-", 1)[1]) for value in values if value.startswith(prefix + "-") and value.rsplit("-", 1)[1].isdigit()]
    return f"{prefix}-{max(numbers, default=0) + 1}"
