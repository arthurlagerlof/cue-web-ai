from datetime import datetime, timedelta

from .common import card, document, empty, matches, next_id, record, records, save_record

NAME = "Alarms (mock)"


def execute(connection, provider_id, tool_id, arguments):
    if tool_id == "alarm.find":
        query = arguments["query"]
        found = [item for item in records(connection, provider_id, "items") if matches(query, [item["label"], item["time"]])]
        if not found: return empty(provider_id, NAME, "Alarms", query)
        return document(provider_id, NAME, "Alarms", [card(item["label"], item["time"], "Enabled" if item.get("enabled", True) else "Disabled") for item in found])
    if tool_id == "alarm.create":
        try:
            instant = datetime.fromisoformat(arguments["time"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Alarm time must be an ISO-8601 timestamp") from exc
        instant += timedelta(minutes=arguments.get("offsetMinutes", 0))
        item = {"id": next_id(connection, provider_id, "items", "alarm"), "label": arguments["label"], "time": instant.isoformat(), "enabled": True}
        save_record(connection, provider_id, "items", item)
        return document(provider_id, NAME, "Alarm created", [card(item["label"], item["time"], "Enabled")], state="success")
    if tool_id == "alarm.update":
        item = record(connection, provider_id, "items", arguments["alarmId"])
        if not item: return empty(provider_id, NAME, "Alarm", arguments["alarmId"])
        if "label" in arguments: item["label"] = arguments["label"]
        if "time" in arguments: item["time"] = arguments["time"]
        if "enabled" in arguments: item["enabled"] = arguments["enabled"]
        save_record(connection, provider_id, "items", item)
        return document(provider_id, NAME, "Alarm updated", [card(item["label"], item["time"], "Enabled" if item["enabled"] else "Disabled")], state="success")
    raise LookupError(f"Unsupported Alarm tool: {tool_id}")
