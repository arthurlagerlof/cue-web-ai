import json
import os
import urllib.error
import urllib.request

MODEL = "dots-studio/dots-3-note-preview:free"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
MAX_RESPONSE_BYTES = 262144


class NormalizerError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def generate(prompt):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > 100000:
        raise ValueError("Normalizer prompt must be a non-empty string of at most 100 KB")
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise NormalizerError("OPENROUTER_API_KEY is not configured")
    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1024,
        "temperature": 0.1,
        "stream": False,
    }).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise NormalizerError(f"OpenRouter request failed (HTTP {exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise NormalizerError("OpenRouter request failed or timed out") from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise NormalizerError("OpenRouter response exceeded the size limit")
    try:
        result = json.loads(body)
        choice = result["choices"][0]
        content = choice["message"]["content"]
        if choice.get("finish_reason") == "length" or not isinstance(content, str) or not content.strip():
            raise ValueError("Empty or truncated output")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise NormalizerError("OpenRouter returned an invalid or incomplete response") from exc
    return content
