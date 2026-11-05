# Why
Web transcription succeeds, but note generation at the internal Codex responses endpoint returns HTTP 401. Reusing the web-session token has not established authorization for that endpoint.

# What Changes
Add a separate Continue with ChatGPT OAuth flow for notes, mediated by a foreground local Node companion. Replace the internal Codex notes request with the documented public Responses API using the newly authorized token. Preserve the existing web transcription flow and compact panel.

# Capabilities
- oauth-notes: authorize notes generation through ChatGPT plan usage.

# Impact
Adds a local runtime requirement, loopback host permission, sign-in/account controls, OAuth lifecycle handling, and targeted tests. No API key, hosted server, automatic startup, publishing, or changes to browser credentials.
