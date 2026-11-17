_Thanks to Jason Mayes for the watch._

# Cue

Cue is a browser-first assistant demo for trusted, registered tools. Normal app use needs no Python server or application backend: provider data, tool registry, workflows, embeddings, operation results, preferences, and local usage counters are stored in the user's browser. The packaged providers use synthetic data and do not connect to personal Anki, calendar, notification, alarm, knowledge-base, or web accounts.

## Run locally

1. Install Node.js 20+ and run `npm ci`.
2. Run `npm run dev`, then open the Vite URL in a supported Chromium browser. `/` opens `/landing`; choose **Continue without a watch** to open `/app`.
3. Use a demo scenario or enter a request. In **Web AI** mode, discovery, MiniLM embeddings, argument resolution, and trusted provider execution remain in the browser. **Automatic** keeps straightforward requests local and can use OpenRouter for complex planning or eligible argument normalization. **Always Dots 3** sends the request and registered tool catalog to OpenRouter without initializing local retrieval models; switching to a local mode initializes retrieval when needed.
4. External AI uses the server-configured `OPENROUTER_API_KEY`; users do not enter or receive the key. Local Vite middleware reads the unprefixed key from `.env` on the server, while the deployed Netlify function reads it from the Netlify environment. External modes may send your request text and tool schemas to OpenRouter through the server; provider records and provider-data search evidence are not sent. Avoid sensitive request text.
5. Use **Reset demo session** to restore the packaged synthetic providers, tools, and records. **Export local backup** downloads a JSON copy of local app data.

Python is not required for app operation. The browser seeds from version-controlled synthetic JSON fixtures; the old SQLite baseline and Python backend have been removed.

## Browser storage and privacy

- The browser seeds its own database from version-controlled synthetic JSON under `data/seed/`, including precomputed MiniLM tool vectors. It does not open or modify existing personal `semantic_mastery.db` or `cue_memory.db` databases.
- When cross-origin isolation and OPFS are available, Cue uses SQLite WASM with OPFS. Otherwise it falls back to IndexedDB. Browser storage persistence is requested where supported; browser eviction and user-cleared site data remain possible.
- Conversations, pending confirmations, operation idempotency records, cached embeddings, and provider mutations persist locally. Side effects require confirmation and are not automatically repeated after an interrupted or failed operation.
- Per-request statistics are stored locally in the browser. Public telemetry is off by default and requires explicit opt-in on the landing page. When enabled, Cue automatically uploads one record per completed request containing only a random deduplication ID, execution mode, local/external model names, timing, reported token counts, tool counts, clarification/multi-step counts, and completion status. Prompts, transcripts, responses, tool arguments, provider records, account details, and browser identifiers are never included in the telemetry record. Failed/offline uploads are queued locally and retried; opting out clears queued uploads. Previously contributed aggregates cannot be withdrawn. OpenRouter token counts and model identifiers are returned as safe metadata by the server proxy; no extra AI calls are made.

## Netlify and optional global statistics

The static app deploys from `dist`; `public/_redirects` routes `/api/openrouter` to its server function and supplies the SPA fallback, and `public/_headers` configures security and cross-origin-isolation headers needed by the SQLite OPFS worker. `netlify.toml` deploys the OpenRouter proxy and optional global-statistics function.

To enable public request statistics:

1. Apply [`supabase/migrations/20261118000000_request_telemetry.sql`](./supabase/migrations/20261118000000_request_telemetry.sql) to the Supabase project. The table stores one privacy-limited row per request with model-call metadata; public reads return aggregates only. The older daily counter migrations are not used by this endpoint.
2. Configure `DATABASE_URL` and `OPENROUTER_API_KEY` as server-side Netlify environment variables. Their functions read them only on the server; do not use `VITE_` variables or expose them in browser code.
3. For local testing, add `DATABASE_URL` to `.env` and run Vite. Its local middleware invokes the same global-statistics handler used by Netlify; the database URL remains server-side.

Without that function and database configuration, Cue continues to work and keeps request statistics locally; public aggregates are unavailable. The telemetry endpoint validates a strict allowlist, deduplicates with the random request ID, stores raw statistics server-side, and exposes only computed aggregates, mode averages, and model aggregates—never raw rows. The OpenRouter function accepts bounded prompts/tokens, applies a per-IP in-memory rate limit, returns only validated output plus model/token metadata, and never returns the server key to the browser.

## Architecture

- `src/storage/` implements versioned browser storage, OPFS-to-IndexedDB migration, local seeding, backup export, workflow persistence, atomic operation claims, numeric usage counters, per-request statistics, and the consent-gated telemetry retry queue.
- `src/providers/` contains the trusted local synthetic adapters for Anki, Knowledge, Web Search, Calendar, Notifications, and Alarms. `src/intelligence/` performs local semantic retrieval, optional cross-encoder reranking, deterministic argument resolution, plan validation, confirmation, and dispatch. Model proposals cannot select unregistered tools or bypass schemas, permissions, confirmation, or execution-plan validation.
- `src/intelligence/openRouter.js` sends bounded prompts to the same-origin server proxy. The Netlify function or local Vite middleware adds the server-only key; plans are checked against the locally registered tool catalog and execution-plan contract before dispatch.
- `src/display/schema/cue-display-v1.schema.json` defines Cue Display Document v1. The shared validator checks nested elements, actions, asset references, and registered-tool arguments before rendering.
- `/landing` and `/app` are client-side routes. A shared Bangle connection manager keeps watch state alive across route changes; the watch is optional.

## Tests and limitations

Run `npm test` and `npm run build`. Synthetic retrieval fixtures cover English and Finnish routing, ambiguity, and no-tool outcomes. Tests mock BLE; physical Bangle.js behavior is not verified here.

The provider adapters are intentionally synthetic, not live third-party integrations. Global statistics require the optional Supabase/Netlify setup above. OpenRouter requires network access and a user-owned key. Browser storage support, model downloads, WebGPU, and BLE availability depend on the browser and device.

The interface uses Century Gothic when it is installed on the user's device, with a sans-serif fallback where the proprietary font is unavailable.
