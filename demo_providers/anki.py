from .common import card, document, empty, matches, next_id, record, records, save_record, text

NAME = "Anki (synthetic demo)"


def execute(connection, provider_id, tool_id, arguments):
    cards = records(connection, provider_id, "cards")
    if tool_id == "anki.search_cards":
        found = [item for item in cards if matches(arguments["query"], [item.get("front", ""), item.get("back", ""), item.get("extra", ""), *item.get("tags", [])])]
        if not found: return empty(provider_id, NAME, "Anki cards", arguments["query"])
        actions, elements = [], []
        for item in found:
            action_id = f"open-{item['id']}"
            actions.append({"id": action_id, "toolId": "anki.get_card", "arguments": {"cardId": item["id"]}, "label": "Open card"})
            element = card(item["front"], item["back"], f"Tags: {', '.join(item.get('tags', [])) or 'none'} · {item['id']}")
            element["children"].append({"type": "action", "actionId": action_id, "label": "Open card"})
            elements.append(element)
        return document(provider_id, NAME, "Anki cards", elements, actions=actions)
    if tool_id == "anki.get_card":
        item = record(connection, provider_id, "cards", arguments["cardId"])
        if not item: return empty(provider_id, NAME, "Anki card", arguments["cardId"])
        return document(provider_id, NAME, "Anki card", [card(item["front"], item["back"], f"Extra: {item.get('extra', '')} · Tags: {', '.join(item.get('tags', []))}")])
    if tool_id == "anki.create_card":
        item = {"id": next_id(connection, provider_id, "cards", "demo-card"), "noteId": f"demo-note-{len(cards) + 1:03d}", "front": arguments["front"], "back": arguments["back"], "extra": arguments.get("extra", ""), "tags": arguments.get("tags", []), "source": "Synthetic Cue demo collection"}
        save_record(connection, provider_id, "cards", item)
        return document(provider_id, NAME, "Card created", [card(item["front"], item["back"], f"Tags: {', '.join(item['tags']) or 'none'}")], state="success")
    raise LookupError(f"Unsupported Anki tool: {tool_id}")
