_Thanks to Jason Mayes for the watch._

# Bangle.js Memory demo

Existing React/Vite UI with browser-side multilingual embeddings and a local Python backend. Transcript processing has two independent modes: Anki semantic search and an OpenAI-compatible Chat Completions endpoint. Transcription remains optional; the main workflow accepts manually entered transcript text.

## Run locally

1. Install Node.js 20+ and Python 3.11+; run `npm install`.
2. Terminal 1: set `LLM_API_KEY` in the backend process environment, or set it in the root `.env` file (the Python backend loads it; `.env` is gitignored). PowerShell example: `$env:LLM_API_KEY='your-key'; npm run backend`. Never prefix it with `VITE_`; the key is not exposed to frontend code or responses. `.env.example` contains only a placeholder. HTTPS is required for remote endpoints. To intentionally use a private/local endpoint set `ALLOW_LOCAL_LLM=1` in the backend environment.
3. Terminal 2: run `npm run dev`, then open its localhost URL in a supported Chromium browser. Connect the Bangle.js using **Connect Bangle.js**.
4. Enter a sample transcript and choose **Anki semantic search**. The browser embeds it using the existing MiniLM implementation; backend searches `semantic_mastery.db` read-only, returning note text, IDs, deck, and cosine similarity. Results are shown in the UI and the best note is sent over BLE.
5. For **OpenAI-compatible API**, configure endpoint, model, and prompt in the UI. Configure `LLM_API_KEY` in the backend environment before use. API mode does not access the Anki DB. The backend requires `{ "version": 1, "display_text": "string" }`; API mode has not been live-tested and must not be tested until the key is configured.

Use **Start microphone** to keep the rolling audio buffer available. **Freeze rolling buffer** only snapshots audio; the watch's tap trigger snapshots the buffer and starts transcription and processing on the laptop. The hold-to-transcribe control remains separate.

## Watch installation and protocol

Use **Install on watch** in the web UI. It connects over the standard Espruino Nordic UART BLE service, interrupts/resets the running application into the Espruino console, uploads the display app and its `.info` metadata into Storage, verifies file lengths, launches the app, and waits for the app's `BM_BLE_READY` startup signal. Confirm **BLE READY** is visible on the watch before testing. The app temporarily displays received UART text and replies to the raw `TEST` probe with `ACK:TEST\n`. Tap, swipe, and BLE receive callbacks are active only while the display app is open. Bangle.js UI lifecycle callbacks return to the clock and remove only the app's BLE listener and outstanding timers on app unload. The app provides paged text and persistent latest-result storage. Physical watch behavior and receipt of `ACK:TEST` have not been verified here.

The web app reuses the verified project Nordic UART service and RX/TX characteristic UUIDs in `src/services/bluetooth.ts`. Frames use `BM`, protocol v1, little-endian message IDs, 10-byte maximum payload chunks under the conservative 20-byte ATT limit, stream parsing, reassembly, deduplication, timeouts, and acknowledgements. Result delivery retries up to three times if the watch does not acknowledge the complete message. Display text is limited to 512 UTF-8 bytes.

## Tests and limitations

Run `C:/Python314/python.exe -m unittest discover -s tests` and `npm run build`. The backend has offline tests for read-only DB search, stored-vector decoding, output validation, URL protections, and watch byte limits. No API request is issued by tests. The official Espruino emulator and real-watch BLE workflow were not successfully exercised here; use the watch installation steps above for manual hardware validation. Web Bluetooth requires a supported Chromium browser on localhost/HTTPS.
