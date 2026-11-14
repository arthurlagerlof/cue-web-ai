from .common import card, document, empty, matches, record, records, text

NAME = "Mock web search"


def execute(connection, provider_id, tool_id, arguments):
    if tool_id == "web.search":
        query = arguments["query"]
        found = [item for item in records(connection, provider_id, "results") if matches(query, [item["title"], item["summary"], *item.get("keywords", [])])]
        if not found: found = records(connection, provider_id, "results")
        if not found: return empty(provider_id, NAME, "Web search", query)
        assets = [{"id": "web-research-image", "mimeType": "image/svg+xml", "alt": "Illustration of research results", "originalRef": "src/demo/assets/research.svg"}]
        elements, actions = [], []
        for item in found:
            action_id = f"open-{item['id']}"
            actions.append({"id": action_id, "toolId": "web.get_article", "arguments": {"articleId": item["id"]}, "label": "Open article"})
            children = [text(item["title"], "heading"), text(item["summary"]), text(item["url"], "caption")]
            if item.get("imageAssetId"): children.append({"type": "image", "assetId": item["imageAssetId"], "fit": "contain"})
            children.append({"type": "action", "actionId": action_id, "label": "Open article"})
            elements.append({"type": "container", "layout": "column", "children": children})
        return document(provider_id, NAME, f"Web results: {query}", elements, assets=assets, actions=actions)
    if tool_id == "web.get_article":
        item = record(connection, provider_id, "results", arguments["articleId"])
        if not item: return empty(provider_id, NAME, "Article", arguments["articleId"])
        return document(provider_id, NAME, item["title"], [card(item["title"], item["summary"], item["url"])])
    raise LookupError(f"Unsupported Web Search tool: {tool_id}")
