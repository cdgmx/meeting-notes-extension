# Meeting Notes (experimental Chrome extension)

Meeting Notes captures the current tab's audio in approximately five-second WAV batches, transcribes it through your signed-in ChatGPT browser session, and creates rolling notes through a separate ChatGPT OAuth connection. Transcription is batched, not streaming; provider latency affects when text appears. Notes update separately and may arrive later. Existing notes stay unchanged; each update appends newly generated text. The model may occasionally repeat information or misunderstand speech. Your microphone is not captured. Notes can revise only the five most recent transcript batches as they catch up; older batches remain unchanged, and original text remains available under **Transcript → Original transcription**. The model keeps a small topic, subjects and purpose context inferred from speech to help corrections. Unknowns should remain empty, but model inferences and corrections can be wrong.

## Setup

1. Sign in to `https://chatgpt.com` in Chrome. Turn on Developer mode at `chrome://extensions`, choose **Load unpacked**, and select this folder. Copy the extension ID shown there.
2. Install the local helper for your computer:
   - **Windows 64-bit:** Double-click `Setup Meeting Notes.cmd`, enter the extension ID, and wait for setup to finish. Setup downloads a pinned official Node runtime, checks its SHA-256 and installs locked dependencies in `%LOCALAPPDATA%\MeetingNotesHelper`. No administrator access or system Node installation is required. The folder with this extension must remain available to Chrome. Windows setup has automated checks but has not yet been verified on an end-user Windows machine.
   - **macOS:** Install Node.js 22 or newer. In this folder run `npm ci`, then `node install-helper.mjs --extension-id YOUR_CHROME_EXTENSION_ID`. Keep this folder and Node in place.
3. Reload the extension at `chrome://extensions` and accept the native messaging permission. Open your meeting or video webpage and click **Meeting Notes** in Chrome's toolbar or Extensions menu. The helper starts automatically.
4. Expand **Notes connection**, select **Add an account**, and click **Continue with ChatGPT**. Complete sign-in and consent in the new tab. Return to the panel, click **Refresh connection**, and choose a notes model. The browser session used for transcription and the notes account are independent.
5. Click **Start listening**. Click the extension's toolbar icon again for each new tab to grant capture access. Chrome internal pages, protected media and some websites cannot be captured. Only tab audio is captured; the microphone is not.

Setup refuses to replace an existing helper folder or native host registration. On macOS, manual recovery is available: stop the automatic helper, run `npm run companion -- --extension-id YOUR_CHROME_EXTENSION_ID`, then enter its code under **Notes connection → Manual connection recovery**. Both modes use port 1455 and cannot run together.

Select **Stop** to finish the last batch. Keep the meeting tab open; capture continues with the panel closed. **Copy notes** copies the result. Account/model controls are disabled while capture is active or finishing. If processing cannot keep up, capture stops with an error. Received transcripts remain saved when notes fail.

## Connection and data

The companion uses OpenAI's documented dynamic OAuth registration, PKCE, state and nonce validation, verified ID tokens, account model discovery and public Responses API. Notes use the selected model with `store: false`. The persistent capture document owns the long notes request; the service worker only handles short connection operations. It does not call the Codex notes endpoint or send the browser-session token for notes. Entitlements and usage limits still depend on the selected ChatGPT account; adding request headers cannot grant access.

OAuth access and refresh tokens remain in companion memory, never in extension storage. Closing the helper clears them; restarting it requires sign-in again. Chrome starts it while the extension is connected. **Sign out** clears local OAuth credentials and attempts remote refresh-token revocation. If revocation cannot be confirmed, the panel says so. Saved account registrations and a host identifier remain in `~/.config/meeting-notes/registration.json` (on Windows, under the user home directory). They contain no OAuth tokens. To remove saved registrations, stop the companion and delete that file. A temporary local pairing secret is sent through Chrome native messaging and is not an OAuth token.

Prompt, transcript-derived meeting context, original and corrected transcripts, and notes remain in Chrome extension local storage until cleared or the extension is removed. They are not encrypted by this extension. Audio goes to ChatGPT's web transcription service; recent transcript segments, instructions and existing notes go to OpenAI for note generation. Corrections can be wrong. Inform participants and obtain any needed consent before recording.

## Limitations and checks

Web transcription still uses an undocumented ChatGPT web endpoint and may change or reject the browser session. Compatibility of five-second batches requires a live trial. The separate OAuth flow supports notes, not audio transcription. An earlier live test confirmed web transcription and encountered HTTP 401 at the now-removed Codex notes endpoint. The automatic helper and OAuth workflow have local mocked coverage; a complete live browser-to-notes run still requires verification. Do not rely on it for a meeting before a successful trial.

Run `npm test` for local checks. They exercise the OAuth lifecycle, JWT validation, loopback access boundary, refresh, model selection, stream completion, tab capture guidance and transcript persistence with mocked Chrome/provider APIs. No credentials or live consent are needed for tests.

To remove the helper, close Chrome first. On macOS, delete `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.meeting_notes.helper.json` and `com.meeting_notes.helper.sh`. On Windows, after confirming the registration belongs to Meeting Notes, delete the `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.meeting_notes.helper` registry key and `%LOCALAPPDATA%\MeetingNotesHelper` folder. Do not delete an existing registration belonging to another installation. Setup creates no system-wide service. If setup stops, check the error and remove only a confirmed leftover from this installation before retrying.
