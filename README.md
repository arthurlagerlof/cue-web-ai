_Thanks to Jason Mayes for the watch._

# Cue

Cue is a browser-first assistant demo for trusted, registered tools. Normal app use needs no Python server or application backend: provider data, tool registry, workflows, embeddings, operation results, preferences, and local usage counters are stored in the user's browser. The packaged providers use synthetic data and do not connect to personal Anki, calendar, notification, alarm, knowledge-base, or web accounts.

## Run locally

1. Install Node.js 20+ and run `npm ci`.
2. Run `npm run dev`, then open the Vite URL in a supported Chromium browser. `/` opens `/landing`; choose **Continue without a watch** to open `/app`.
3. Use a demo scenario or enter a request. In **Web AI** mode, discovery, MiniLM embeddings, argument resolution, and trusted provider execution remain in the browser. **Automatic** keeps straightforward requests local and can use OpenRouter for complex planning or eligible argument normalization. **Always Dots 3** sends the request and registered tool catalog to OpenRouter without initializing local retrieval models; switching to a local mode initializes retrieval when needed.
4. External AI uses the server-configured `OPENROUTER_API_KEY`; users do not enter or receive the key. Local Vite middleware reads the unprefixed key from `.env` on the server, while the deployed Netlify function reads it from the Netlify environment. External modes may send your request text and tool schemas to OpenRouter through the server; provider records and provider-data search evidence are not sent. Avoid sensitive request text.
5. Use **Reset demo session** to restore the packaged synthetic providers, tools, and records. **Export local backup** downloads a JSON copy of local app data.

On `/app`, start the microphone and click or tap **Transcribe** to process up to the last 10 seconds. Hold the button to add up to five more minutes before releasing. On the watch, tap to process the last 10 seconds; extended capture is available only in the browser.

The watch shows a disconnected screen and disables its controls when its BLE connection drops. Connect it to Cue over Bluetooth to use the tap control; the BLE indicator reflects a connection to any device, not necessarily Cue.

During a clarification, say “go back” to cancel the pending request, or “no, I meant” followed by a new request to start over with it. You can also choose **Start over** in the browser or on the watch. Earlier completed actions are not undone; if there were any, Cue asks you to state the new request separately. Reinstall the watch app to get the new control.

Whisper prefers WebGPU and falls back to CPU via WebAssembly if WebGPU is unavailable or fails. The selected Whisper model is downloaded separately for each backend; CPU transcription can be slower, especially for larger models. Local MiniLM embeddings still require WebGPU. Always Dots 3 normally avoids local retrieval, but continuing some clarification choices locally initializes it.

Calendar requests for this week or next week use Monday as the start of the week.

OpenRouter requests time out after 55 seconds at the proxy, with a 60-second browser limit. Hosting platforms may impose shorter limits. If requests continue timing out, retry or use **Web AI** mode.

For Dots 3 Note Preview, Cue requests non-reasoning mode and asks for JSON planning responses to reduce latency. When no tool is needed, it uses the planner's conversational answer, or requests one separately if the planner returns no answer text. Actual latency and support for this setting depend on the OpenRouter provider; other configured models keep their default reasoning settings.

Python is not required for app operation. The browser seeds from version-controlled synthetic JSON fixtures; the old SQLite baseline and Python backend have been removed.

## Browser storage and privacy

- The browser seeds its own database from version-controlled synthetic JSON under `data/seed/`, including precomputed MiniLM vectors for tool descriptions, keywords, examples, and provider records. It does not open or modify existing personal `semantic_mastery.db` or `cue_memory.db` databases. Run `npm run build:seed-embeddings` after changing seed content or the embedding model; it reuses matching vectors and computes missing ones locally with the same pinned q8 MiniLM model as the browser.
- The seed embedding build fixes synthetic dates to its current UTC date. Those dates stay fixed in the browser, so passing days never trigger re-embedding; demo records can therefore show outdated dates. Re-run `npm run build:seed-embeddings` to update the packaged dates and vectors. User-created or edited records and newly registered provider content are indexed locally as needed.
- When cross-origin isolation and OPFS are available, Cue uses SQLite WASM with OPFS. Otherwise it falls back to IndexedDB. Browser storage persistence is requested where supported; browser eviction and user-cleared site data remain possible.
- Conversations, pending confirmations, operation idempotency records, cached embeddings, and provider mutations persist locally. Side effects require confirmation and are not automatically repeated after an interrupted or failed operation.
- Per-request statistics are stored locally in the browser. Index initialization and rebuilding are excluded from request inference and response timing; response timing therefore represents request processing rather than elapsed wall-clock time when indexing occurs. The statistics page defaults to all requests and can filter local and community aggregates to an exact demo request; older records without request text are excluded from filtered views. Public telemetry is off by default and requires explicit opt-in on the landing page; users who previously opted in must opt in again to share request text. When enabled, Cue uploads the original request text (including speech transcripts) and a record containing a random deduplication ID, selected and actual execution modes, local/external model names, timing, reported token counts, tool counts, clarification/multi-step counts, and completion status. Request text may contain sensitive information; requests over 100 KB are not shared. Responses, tool arguments, provider records, account details, and browser identifiers are not included. Failed/offline uploads are queued locally and retried; opting out clears queued uploads but does not delete already uploaded records. Records remain in the database until manually deleted. OpenRouter token counts and model identifiers are returned by the server proxy; no extra AI calls are made.

## Netlify and optional global statistics

The static app deploys from `dist`; `public/_redirects` routes `/api/openrouter` to its server function and supplies the SPA fallback, and `public/_headers` configures security and cross-origin-isolation headers needed by the SQLite OPFS worker. `netlify.toml` deploys the OpenRouter proxy and optional global-statistics function.

To enable public request statistics:

1. Apply the migrations in [`supabase/migrations/`](./supabase/migrations/) in timestamp order. The request comparison migration removes the unused daily counter table and its data. The telemetry table stores opted-in request text and model-call metadata; the public endpoint returns aggregates only. Earlier records without a selected mode remain in overall totals but are excluded from selected-mode comparisons.
2. Configure `DATABASE_URL` and `OPENROUTER_API_KEY` as server-side Netlify environment variables. Their functions read them only on the server; do not use `VITE_` variables or expose them in browser code.
3. For local testing, add `DATABASE_URL` to `.env` and run Vite. Its local middleware invokes the same global-statistics handler used by Netlify; the database URL remains server-side.

Without that function and database configuration, Cue continues to work and keeps request statistics locally; public aggregates are unavailable. The telemetry endpoint validates a strict allowlist, deduplicates with the random request ID, stores opted-in request text and statistics server-side, and exposes only computed aggregates, mode averages, and model aggregates—never raw rows. Database administrators can access the records for later testing; they are retained until manually deleted. Comparisons group requests by selected mode, use measured averages rather than estimated savings, and display sample sizes and periods. Token averages include only requests with complete reported token counts (including zero for requests with no external calls); external latency is averaged per call. Comparisons are unpaired and small samples can be misleading. The OpenRouter function accepts bounded prompts/tokens, applies a per-IP in-memory rate limit, returns only validated output plus model/token metadata, and never returns the server key to the browser.

## Architecture

- `src/storage/` implements versioned browser storage, OPFS-to-IndexedDB migration, local seeding, backup export, workflow persistence, atomic operation claims, numeric usage counters, per-request statistics, and the consent-gated telemetry retry queue.
- `src/providers/` contains the trusted local synthetic adapters for Anki, Knowledge, Web Search, Calendar, Notifications, and Alarms. `src/intelligence/` performs local semantic retrieval, optional cross-encoder reranking, deterministic argument resolution, plan validation, confirmation, and dispatch. Model proposals cannot select unregistered tools or bypass schemas, permissions, confirmation, or execution-plan validation.
- `src/intelligence/openRouter.js` sends bounded prompts to the same-origin server proxy. The Netlify function or local Vite middleware adds the server-only key; plans are checked against the locally registered tool catalog and execution-plan contract before dispatch.
- `src/display/schema/cue-display-v1.schema.json` defines Cue Display Document v1. The shared validator checks nested elements, actions, asset references, and registered-tool arguments before rendering.
- `/landing` and `/app` are client-side routes. A shared Bangle connection manager keeps watch state alive across route changes; the watch is optional.
- The browser negotiates a compact watch-only representation of Display Documents; older watch apps receive the original v1 document instead. Plain Dots 3 answers are sent as text to avoid duplicating them in the watch document. The watch shows thinking while a request runs, then loading while a response is transferred. Display transfers still have a 2,450-byte UTF-8 limit, and larger results are not yet streamed to the watch. Reinstall the watch app after updating it.

## Tests and limitations

Run `npm test` and `npm run build`. Synthetic retrieval fixtures cover English and Finnish routing, ambiguity, and no-tool outcomes. Tests mock BLE; physical Bangle.js behavior is not verified here.

The provider adapters are intentionally synthetic, not live third-party integrations. Global statistics require the optional Supabase/Netlify setup above. OpenRouter requires network access and a user-owned key. Browser storage support, model downloads, WebGPU, and BLE availability depend on the browser and device.

The interface uses Century Gothic when it is installed on the user's device, with a sans-serif fallback where the proprietary font is unavailable.
