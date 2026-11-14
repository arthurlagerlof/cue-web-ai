from .common import card, document, empty, matches, records

NAME = "Cue knowledge sample"


def execute(connection, provider_id, tool_id, arguments):
    if tool_id != "knowledge.search": raise LookupError(f"Unsupported Knowledge tool: {tool_id}")
    query = arguments["query"]
    found = [item for item in records(connection, provider_id, "documents") if matches(query, [item.get("title", ""), item.get("excerpt", ""), item.get("language", ""), *item.get("keywords", [])])]
    if not found: return empty(provider_id, NAME, "Knowledge base", query)
    elements = [card(item["title"], item["excerpt"], f"{item.get('language', 'en').upper()} · {item['source']['name']} · {item['source']['ref']}") for item in found]
    return document(provider_id, NAME, "Knowledge base", elements)
