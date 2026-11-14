from datetime import datetime

from .common import card, document, empty, matches, next_id, record, records, save_record, text

NAME = "Google Calendar (mock)"


def execute(connection, provider_id, tool_id, arguments):
    events = records(connection, provider_id, "events")
    if tool_id == "calendar.find_events":
        date_query = arguments.get("date")
        query = date_query or arguments.get("query", "")
        found = [item for item in events if item.get("start", "").startswith(date_query)] if date_query else [item for item in events if matches(query, [item["title"], item.get("location", "")])]
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
        try:
            starts = datetime.fromisoformat(arguments["start"].replace("Z", "+00:00"))
            ends = datetime.fromisoformat(arguments["end"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Calendar event bounds must use ISO-8601 date-times") from exc
        if ends <= starts:
            raise ValueError("Calendar event end must follow its start")
        item = {"id": next_id(connection, provider_id, "events", "event"), "title": arguments["title"], "start": arguments["start"], "end": arguments["end"], "location": arguments.get("location", "Demo location")}
        save_record(connection, provider_id, "events", item)
        return document(provider_id, NAME, "Event created", [card(item["title"], f"{item['start']} — {item['end']}", item["location"])], state="success")
    if tool_id == "calendar.check_availability":
        try:
            requested_start = datetime.fromisoformat(arguments["start"].replace("Z", "+00:00"))
            requested_end = datetime.fromisoformat(arguments["end"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Availability interval must use ISO-8601 date-times") from exc
        if requested_end <= requested_start:
            raise ValueError("Availability interval end must follow its start")
        conflicts = []
        for item in events:
            event_start = datetime.fromisoformat(item["start"].replace("Z", "+00:00"))
            event_end = datetime.fromisoformat(item["end"].replace("Z", "+00:00"))
            if event_start < requested_end and requested_start < event_end:
                conflicts.append(item)
        label = "Unavailable" if conflicts else "Available"
        return document(provider_id, NAME, "Calendar availability", [card(label, f"{requested_start.isoformat()} — {requested_end.isoformat()}", ", ".join(item["title"] for item in conflicts))])
    if tool_id == "calendar.delete_event":
        item = record(connection, provider_id, "events", arguments["eventId"])
        if not item:
            return empty(provider_id, NAME, "Calendar event", arguments["eventId"])
        connection.execute("DELETE FROM records WHERE provider_id=? AND record_type='events' AND record_id=?", (provider_id, arguments["eventId"]))
        connection.commit()
        return document(provider_id, NAME, "Event deleted", [card(item["title"], "Removed from the synthetic calendar.")], state="success")
    if tool_id == "calendar.update_event":
        item = record(connection, provider_id, "events", arguments["eventId"])
        if not item: return empty(provider_id, NAME, "Calendar event", arguments["eventId"])
        for key in ("title", "start", "end", "location"):
            if key in arguments: item[key] = arguments[key]
        try:
            starts = datetime.fromisoformat(item["start"].replace("Z", "+00:00"))
            ends = datetime.fromisoformat(item["end"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Calendar event bounds must use ISO-8601 date-times") from exc
        if ends <= starts:
            raise ValueError("Calendar event end must follow its start")
        save_record(connection, provider_id, "events", item)
        return document(provider_id, NAME, "Event updated", [card(item["title"], f"{item['start']} — {item['end']}", item.get("location", ""))], state="success")
    raise LookupError(f"Unsupported Calendar tool: {tool_id}")
