from .common import card, document, empty, matches, next_id, record, records, save_record, text

NAME = "Google Calendar (mock)"


def execute(connection, provider_id, tool_id, arguments):
    events = records(connection, provider_id, "events")
    if tool_id == "calendar.find_events":
        query = arguments.get("date", "")
        found = [item for item in events if item.get("start", "").startswith(query)] if len(query) >= 10 else [item for item in events if matches(query, [item["title"], item.get("location", "")])]
        if not found: return empty(provider_id, NAME, "Calendar events", query)
        found.sort(key=lambda item: item["start"])
        actions, elements = [], []
        for item in found:
            action_id = f"open-{item['id']}"
            actions.append({"id": action_id, "toolId": "calendar.get_event", "arguments": {"eventId": item["id"]}, "label": "Open event"})
            element = card(item["title"], f"{item['start']} — {item['end']}", f"{item.get('location', '')} · {item['id']}")
            element["children"].append({"type": "action", "actionId": action_id, "label": "Open event"})
            elements.append(element)
        return {"document": document(provider_id, NAME, "Calendar events", elements, actions=actions), "data": {"events": found, "firstEvent": found[0]}}
    if tool_id == "calendar.get_event":
        item = record(connection, provider_id, "events", arguments["eventId"])
        if not item: return empty(provider_id, NAME, "Calendar event", arguments["eventId"])
        return document(provider_id, NAME, item["title"], [card(item["title"], f"{item['start']} — {item['end']}", item.get("location", ""))])
    if tool_id == "calendar.create_event":
        item = {"id": next_id(connection, provider_id, "events", "event"), "title": arguments["title"], "start": arguments["start"], "end": arguments["end"], "location": arguments.get("location", "Demo location")}
        save_record(connection, provider_id, "events", item)
        return document(provider_id, NAME, "Event created", [card(item["title"], f"{item['start']} — {item['end']}", item["location"])], state="success")
    if tool_id == "calendar.update_event":
        item = record(connection, provider_id, "events", arguments["eventId"])
        if not item: return empty(provider_id, NAME, "Calendar event", arguments["eventId"])
        for key in ("title", "start", "end", "location"):
            if key in arguments: item[key] = arguments[key]
        save_record(connection, provider_id, "events", item)
        return document(provider_id, NAME, "Event updated", [card(item["title"], f"{item['start']} — {item['end']}", item.get("location", ""))], state="success")
    raise LookupError(f"Unsupported Calendar tool: {tool_id}")
