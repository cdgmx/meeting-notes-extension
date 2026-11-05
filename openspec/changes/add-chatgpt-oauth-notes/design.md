# Context
The observed 401 does not prove a specific audience or scope mismatch. The supported integration explicitly requires its own OAuth token and the public Responses endpoint. Source: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

# Decisions
1. A foreground Node companion binds only 127.0.0.1. It handles the required loopback OAuth callback, token exchange and note requests. Setup binds the companion to this extension's exact origin and a generated local pairing secret. Reject other origins, Host values and unauthorized API requests; callback authorization uses the pending OAuth transaction instead.
2. Implement dynamic registration with the real app name, a stable host ID, PKCE S256, per-attempt state and nonce, exact redirect matching, single-use callback and bounded expiry. Validate ID tokens against official issuer/JWKS, audience and nonce. Preserve an existing session until replacement validation succeeds. Never log credentials or authorization codes.
3. Keep access/refresh tokens in companion memory. Restart requires sign-in again. Persist only non-secret registration/host identity with restricted file permissions. Serialize refreshes and clear tokens on sign-out. No background daemon installation.
4. Panel provides Continue with ChatGPT, connection status and sign-out. Discover account-available models and let the user select a notes model; do not assume the existing model is entitled. Keep access help collapsed.
5. Companion sends note context to https://api.openai.com/v1/responses with store:false and stream:true. Accept output only after response.completed. Bound request sizes, cancel upstream work on timeout/disconnection and retain transcript on note failure.
6. Audio transcription remains the current cookie-inclusive ChatGPT web request. OAuth plan usage does not support the transcription API. Make the separate connections clear without a wall of text.

# Verification
Regression checks cover unauthorized loopback requests, callback mismatch/replay/expiry, token validation, failed/rotated refresh, sign-out, model selection, incomplete streams and preserved transcripts. Browser checks cover sign-in/cancellation, compact controls and a short public-video transcription-to-notes run after user consent. Independent spec/security/simplicity review required before completion.

# Sources
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

# Approval
User explicitly approved this design and tasks with “approve” in the current conversation.
