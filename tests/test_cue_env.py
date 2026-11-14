import os
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cue_env import load_backend_env


class BackendEnvironmentTests(unittest.TestCase):
    def test_reads_supported_values_without_overriding_process_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "# Example\nOPENROUTER_API_KEY='test#key'\nBACKEND_PORT=9000 # custom port\n"
                'CUE_DEMO_SEED_DB="C:\\test folder\\seed.db"\n'
                "export CUE_DEMO_RUNTIME_DIR=C:\\runtime\nUNRELATED_SETTING=ignored\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"BACKEND_PORT": "8001"}, clear=True):
                load_backend_env(path)
                self.assertEqual(os.environ["OPENROUTER_API_KEY"], "test#key")
                self.assertEqual(os.environ["BACKEND_PORT"], "8001")
                self.assertEqual(os.environ["CUE_DEMO_SEED_DB"], "C:\\test folder\\seed.db")
                self.assertEqual(os.environ["CUE_DEMO_RUNTIME_DIR"], "C:\\runtime")
                self.assertNotIn("UNRELATED_SETTING", os.environ)

    def test_missing_file_is_optional_and_invalid_supported_setting_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            with patch.dict(os.environ, {}, clear=True):
                load_backend_env(path)
                self.assertNotIn("OPENROUTER_API_KEY", os.environ)
                path.write_text("OPENROUTER_API_KEY='unclosed\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "line 1") as error:
                    load_backend_env(path)
                self.assertNotIn("unclosed", str(error.exception))

    def test_backend_startup_reads_env_before_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("BACKEND_PORT=8765\nOPENROUTER_API_KEY=test-key\n", encoding="utf-8")
            seed = Path(directory) / "seed.db"
            seed.touch()
            with patch.dict(os.environ, {}, clear=True), \
                    patch("cue_env.load_backend_env", side_effect=lambda: load_backend_env(path)), \
                    patch("demo_database.seed_path", return_value=seed), \
                    patch("http.server.ThreadingHTTPServer") as server:
                runpy.run_module("backend", run_name="__main__")
                self.assertEqual(server.call_args.args[0], ("127.0.0.1", 8765))
                self.assertEqual(os.environ["OPENROUTER_API_KEY"], "test-key")
                server.return_value.serve_forever.assert_called_once()


if __name__ == "__main__":
    unittest.main()
