from .common import card, document, empty, matches, record, records

NAME = "Android notifications (mock)"


def execute(connection, provider_id, tool_id, arguments):
    if tool_id == "notifications.search":
        query = arguments["query"]
        found = [item for item in records(connection, provider_id, "items") if matches(query, [item["app"], item["sender"], item["preview"]])]
        if not found: return empty(provider_id, NAME, "Notifications", query)
        actions, elements = [], []
        for item in found:
            action_id = f"open-{item['id']}"
            actions.append({"id": action_id, "toolId": "notifications.get", "arguments": {"notificationId": item["id"]}, "label": "Open notification"})
            element = card(f"{item['app']} · {item['sender']}", item["preview"], item["timestamp"])
            element["children"].append({"type": "action", "actionId": action_id, "label": "Open notification"})
            elements.append(element)
        return document(provider_id, NAME, "Notifications", elements, actions=actions)
    if tool_id == "notifications.get":
        item = record(connection, provider_id, "items", arguments["notificationId"])
        if not item: return empty(provider_id, NAME, "Notification", arguments["notificationId"])
        return document(provider_id, NAME, "Notification", [card(f"{item['app']} · {item['sender']}", item["preview"], item["timestamp"])])
    raise LookupError(f"Unsupported Notifications tool: {tool_id}")
