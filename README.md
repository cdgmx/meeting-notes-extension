# Meeting Notes (experimental Chrome extension)

Meeting Notes captures the current tab's audio in approximately five-second WAV batches, transcribes it through your signed-in ChatGPT browser session, and creates rolling notes through a separate ChatGPT OAuth connection. Transcription is batched, not streaming; provider latency affects when text appears. Notes update separately and may arrive later. Existing notes stay unchanged; each update appends newly generated text. The model may occasionally repeat information or misunderstand speech. Your microphone is not captured. Notes can revise only the five most recent transcript batches as they catch up; older batches remain unchanged, and original text remains available under **Transcript → Original transcription**. The model keeps a small topic, subjects and purpose context inferred from speech to help corrections. Unknowns should remain empty, but model inferences and corrections can be wrong.

## Setup

1. Install Node.js 22 or newer. In this folder run `npm ci`.
2. In Chrome, sign in to `https://chatgpt.com`. Load this folder using **Load unpacked** at `chrome://extensions` with Developer mode enabled. Copy the extension's ID from that page.
3. On macOS, install the helper once from this folder:
   ```sh
   node install-helper.mjs --extension-id YOUR_CHROME_EXTENSION_ID
   ```
   The installer registers this extension in your current user's Google Chrome profile. Keep this folder and the Node installation in place. It refuses to replace an existing helper registration. For manual recovery, stop the automatic helper, run `npm run companion -- --extension-id YOUR_CHROME_EXTENSION_ID`, then open **Notes connection → Manual connection recovery** and enter its pairing code. Both modes use port 1455 and cannot run together.
4. Reload the extension in `chrome://extensions` and accept the native messaging permission. Open a meeting/video webpage and click **Meeting Notes** in Chrome's toolbar or Extensions menu. The helper starts automatically when the panel connects.
5. Expand **Notes connection**, select **Add an account**, and click **Continue with ChatGPT**. Complete the OpenAI consent screen in the new tab. Return to the panel, click **Refresh connection**, and choose a notes model from your account's catalog. The browser session used for transcription and the notes account are independent.
6. Click **Start listening**. Click the extension's toolbar icon again for each new tab to grant capture access. Chrome settings and New Tab cannot be captured.

Select **Stop** to finish the last batch. Keep the meeting tab open; capture continues with the panel closed. **Copy notes** copies the result. Account/model controls are disabled while capture is active or finishing. If processing cannot keep up, capture stops with an error. Received transcripts remain saved when notes fail.

## Connection and data

The companion uses OpenAI's documented dynamic OAuth registration, PKCE, state and nonce validation, verified ID tokens, account model discovery and public Responses API. Notes use the selected model with `store: false`. The persistent capture document owns the long notes request; the service worker only handles short connection operations. It does not call the Codex notes endpoint or send the browser-session token for notes. Entitlements and usage limits still depend on the selected ChatGPT account; adding request headers cannot grant access.

OAuth access and refresh tokens remain in companion memory, never in extension storage. Closing the helper clears them; restarting it requires sign-in again. Chrome starts it while the extension is connected. **Sign out** clears local OAuth credentials and attempts remote refresh-token revocation. If revocation cannot be confirmed, the panel says so. Saved account registrations and a host identifier remain in `~/.config/meeting-notes/registration.json` (owner-only permissions); they contain no OAuth tokens. To remove saved registrations, stop the companion and delete that file. A temporary local pairing secret is sent through Chrome native messaging and is not an OAuth token.

Prompt, transcript-derived meeting context, original and corrected transcripts, and notes remain in Chrome extension local storage until cleared or the extension is removed. They are not encrypted by this extension. Audio goes to ChatGPT's web transcription service; recent transcript segments, instructions and existing notes go to OpenAI for note generation. Corrections can be wrong. Inform participants and obtain any needed consent before recording.

## Limitations and checks

Web transcription still uses an undocumented ChatGPT web endpoint and may change or reject the browser session. Compatibility of five-second batches requires a live trial. The separate OAuth flow supports notes, not audio transcription. An earlier live test confirmed web transcription and encountered HTTP 401 at the now-removed Codex notes endpoint. The automatic helper and OAuth workflow have local mocked coverage; a complete live browser-to-notes run still requires verification. Do not rely on it for a meeting before a successful trial.

Run `npm test` for local checks. They exercise the OAuth lifecycle, JWT validation, loopback access boundary, refresh, model selection, stream completion, tab capture guidance and transcript persistence with mocked Chrome/provider APIs. No credentials or live consent are needed for tests.

To remove the helper registration, close Chrome and delete `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.meeting_notes.helper.json` and `com.meeting_notes.helper.sh`. The installer creates no system-wide service.
