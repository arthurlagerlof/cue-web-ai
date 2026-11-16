import io
import json
import os
import unittest
import urllib.error
from unittest.mock import patch

import openrouter_normalizer


class MockResponse:
    def __init__(self, value):
        self.value = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size):
        return self.value[:size]


class OpenRouterTests(unittest.TestCase):
    @patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"})
    @patch("openrouter_normalizer.urllib.request.build_opener")
    def test_request_uses_free_model_and_returns_content(self, build_opener):
        build_opener.return_value.open.return_value = MockResponse({
            "choices": [{"message": {"content": '{"status":"resolved"}'}, "finish_reason": "stop"}],
        })
        self.assertEqual(openrouter_normalizer.generate("synthetic prompt"), '{"status":"resolved"}')
        request = build_opener.return_value.open.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(payload["model"], openrouter_normalizer.DEFAULT_MODEL)
        self.assertEqual(payload["messages"], [{"role": "user", "content": "synthetic prompt"}])
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(build_opener.return_value.open.call_args.kwargs["timeout"], 30)

    @patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key", "OPENROUTER_MODEL": "dots-studio/custom"})
    @patch("openrouter_normalizer.urllib.request.build_opener")
    def test_structured_reasoning_uses_configured_model_and_schema(self, build_opener):
        build_opener.return_value.open.return_value = MockResponse({
            "choices": [{"message": {"content": '{"kind":"plan"}'}, "finish_reason": "stop"}],
        })
        schema = {"type": "object", "properties": {"kind": {"type": "string"}}}
        self.assertEqual(openrouter_normalizer.generate("synthetic prompt", response_schema=schema), '{"kind":"plan"}')
        request = build_opener.return_value.open.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(payload["model"], "dots-studio/custom")
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertTrue(payload["response_format"]["json_schema"]["strict"])
        self.assertEqual(payload["response_format"]["json_schema"]["schema"], schema)

    @patch.dict(os.environ, {"OPENROUTER_API_KEY": ""})
    def test_missing_key_and_invalid_prompt_are_explicit(self):
        with self.assertRaisesRegex(openrouter_normalizer.NormalizerError, "OPENROUTER_API_KEY"):
            openrouter_normalizer.generate("prompt")
        with self.assertRaises(ValueError):
            openrouter_normalizer.generate("")

    @patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"})
    @patch("openrouter_normalizer.urllib.request.build_opener")
    def test_http_and_malformed_response_are_explicit(self, build_opener):
        build_opener.return_value.open.side_effect = urllib.error.HTTPError("https://example.test", 429, "rate limit", {}, io.BytesIO())
        with self.assertRaisesRegex(openrouter_normalizer.NormalizerError, "HTTP 429"):
            openrouter_normalizer.generate("prompt")
        build_opener.return_value.open.side_effect = None
        build_opener.return_value.open.return_value = MockResponse({"choices": []})
        with self.assertRaisesRegex(openrouter_normalizer.NormalizerError, "invalid or incomplete"):
            openrouter_normalizer.generate("prompt")


if __name__ == "__main__":
    unittest.main()
