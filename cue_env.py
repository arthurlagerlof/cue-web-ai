import os
import re
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"
BACKEND_KEYS = frozenset({"OPENROUTER_API_KEY", "OPENROUTER_MODEL", "BACKEND_PORT", "CUE_DEMO_SEED_DB", "CUE_DEMO_RUNTIME_DIR"})


def load_backend_env(path=ENV_PATH):
    path = Path(path)
    if not path.exists():
        return
    values = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if not match or match.group(1) not in BACKEND_KEYS:
            if re.match(r"^\s*(?:export\s+)?(?:OPENROUTER_API_KEY|OPENROUTER_MODEL|BACKEND_PORT|CUE_DEMO_SEED_DB|CUE_DEMO_RUNTIME_DIR)\b", line):
                raise ValueError(f"Invalid backend setting in .env at line {line_number}")
            continue
        key, value = match.groups()
        if value.startswith(("'", '"')):
            quote = value[0]
            end = value.find(quote, 1)
            if end < 0 or (value[end + 1:].strip() and not value[end + 1:].strip().startswith("#")):
                raise ValueError(f"Invalid quoted backend setting in .env at line {line_number}")
            value = value[1:end]
        else:
            value = value.split("#", 1)[0].strip()
        values[key] = value
    for key, value in values.items():
        os.environ.setdefault(key, value)
