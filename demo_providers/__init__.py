from . import alarm, anki, calendar, knowledge, notifications, web

ADAPTERS = {
    "anki": anki,
    "knowledge": knowledge,
    "web": web,
    "calendar": calendar,
    "notifications": notifications,
    "alarm": alarm,
}
