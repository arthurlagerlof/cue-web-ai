import json
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "dots-studio/dots-3-note-preview:free"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
MAX_RESPONSE_BYTES = 262144


class NormalizerError(Exception):
    pass


class NormalizerResponseError(NormalizerError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def generate(prompt, *, response_schema=None, max_tokens=1024, timeout=30):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > 100000:
        raise ValueError("Normalizer prompt must be a non-empty string of at most 100 KB")
    if not isinstance(max_tokens, int) or not 1 <= max_tokens <= 4096:
        raise ValueError("Normalizer output token limit is invalid")
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise NormalizerError("OPENROUTER_API_KEY is not configured")
    body = {
        "model": os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "stream": False,
    }
    if response_schema is not None:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "cue_reasoning_response",
                "strict": True,
                "schema": response_schema,
            },
        }
    payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
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
        finish_reason = choice.get("finish_reason")
        content = choice["message"].get("content")
    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
        raise NormalizerResponseError("OpenRouter returned an invalid or incomplete response") from exc
    if finish_reason == "length":
        raise NormalizerResponseError("OpenRouter returned a truncated response")
    if not isinstance(content, str) or not content.strip():
        raise NormalizerResponseError("OpenRouter returned an empty response")
    return content
