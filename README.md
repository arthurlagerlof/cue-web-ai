_Thanks to Jason Mayes for the watch._

# Cue

Cue is a local-first assistant demo. The browser performs MiniLM embedding and local intent resolution; a Python service provides a session-isolated SQLite provider registry, mock execution, and retrieval. Providers own their manifests and adapters. Provider results use the versioned Cue Display Document contract.

## Run locally

1. Install Node.js 20+ and Python 3.11+; run `npm install`.
2. Build and verify the synthetic baseline with `npm run seed:demo` and `npm run verify:demo`.
3. Start the backend using `npm run backend` and the UI with `npm run dev`. Open the Vite URL in a supported Chromium browser.
4. Select a demo scenario or enter a request. Browser-side embedding searches available tools in the SQLite `tool` namespace; the local resolver chooses only retrieved tools. If Cue asks for missing details, reply in the same input; that follow-up continues the pending request directly. Side-effecting mock actions require confirmation.
5. Use **Reset demo session** to restore that browser session's SQLite working copy to the packaged baseline.

The demo requires no API credentials or personal Anki files. The microphone and optional Bangle.js connection remain available; transcript entry is the simplest way to run scenarios.

## Database and deployment

- `data/cue_demo.db` is built exclusively from `data/seed/provider-manifests.json`, `provider-data.json`, `tool-manifests.json`, `tool-retrieval-config.json`, and the normalized float32 `tool-embeddings.f32` fixture plus its content-hash index. It contains six synthetic providers, 18 tools, 12 illustrative Anki cards, 6 knowledge records (documents and chunks), 3 web results, 5 Calendar events, 3 notifications, 2 alarms, one asset, and 172 typed tool retrieval records. The 69 unchanged description/example vectors are seeded; all other records are indexed once in the browser and stored in the session database.
- Seeding is repeatable and never opens or migrates `semantic_mastery.db` or `cue_memory.db`. Personal databases, SQLite sidecars, and Anki exports remain ignored by Git; the synthetic baseline is explicitly unignored.
- `CUE_DEMO_SEED_DB` selects the packaged baseline. `CUE_DEMO_RUNTIME_DIR` selects writable session storage; its default is a temporary-directory location, not the application directory. The baseline is opened read-only and copied into a separate database named from a hash of the HTTP session. Mock writes and browser-computed embeddings affect only that copy. Reset replaces it from the baseline.
- Deploy the backend code together with the committed `data/cue_demo.db`; set `CUE_DEMO_SEED_DB` if the packaged file is at another path and provide a writable `CUE_DEMO_RUNTIME_DIR`. The application package may remain read-only. No developer collection, local migration, external service, or credential is needed.

## Architecture

- `demo_database.py` builds the clean SQLite schema, exposes provider manifests/data, stores browser-generated vectors, searches only typed records in the `tool` namespace, validates arguments, and resolves trusted adapter IDs. `backend.py` never imports the legacy personal-database module.
- Each registered provider has its own Python adapter in `demo_providers/`; providers own Anki, Knowledge, Web Search, Calendar, Notifications, and Alarm behavior. Tool definitions, keywords, examples, schemas, and retrieval vectors are loaded from SQLite rather than a Cue-side domain catalogue.
- `src/intelligence/` performs grouped description/keyword/example retrieval and deterministic schema-driven argument resolution. It retains argument provenance, asks for missing or ambiguous values, validates schemas, requires confirmation, and dispatches only registered provider adapters. Similarity only ranks candidates; it never authorizes execution. Aggregation weights, thresholds, and operation limits are configured in `data/seed/tool-retrieval-config.json`.
- `src/display/schema/cue-display-v1.schema.json` defines Cue Display Document v1 using JSON Schema Draft 2020-12. The shared validator checks nested elements, actions, asset references, and registered-tool arguments before rendering. The React renderer interprets semantic tokens and never executes provider code.

## Watch and tests

The web app installs `watch/bangle-app.js` through the Espruino Nordic UART BLE service and transfers the validated Cue Display Document JSON. At 176×176 the watch adapts nested text, icons, lists, and page content to wrapped/paginated text; image elements show their alternative text because watch image decoding is not implemented. Tapping a displayed action sends its registered action ID back to Cue; side-effecting actions still require browser confirmation. Run `npm test`, `npm run build`, `npm run verify:demo`, and `py -3.14 -m unittest discover -s tests -v` for automated checks. `data/seed/tool-routing-benchmark.json` supplies synthetic English/Finnish positive, ambiguous, and no-tool cases; `src/intelligence/retrieval/benchmark.js` evaluates them when given the real browser embedding callback. The installed Espruino CLI supports hardware/IDE connections but no Bangle.js 2 emulator is included in this project/tooling, so emulator verification remains unperformed. Real Android/calendar/web integrations and image-to-watch optimization/transfer are intentionally out of scope.
