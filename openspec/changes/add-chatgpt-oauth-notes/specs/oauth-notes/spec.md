## ADDED Requirements
### Requirement: Separate authorization for notes
The system SHALL authorize notes through the documented ChatGPT plan OAuth flow and public Responses endpoint, without reusing the web-session token for notes.
#### Scenario: Successful authorization
- **WHEN** the user completes a valid OAuth transaction
- **THEN** notes use the resulting account-bound token and an available selected model
#### Scenario: Invalid or cancelled authorization
- **WHEN** authorization is cancelled, expires, is replayed, or fails state/nonce/token validation
- **THEN** no replacement session is activated
### Requirement: Local credential boundary
The companion SHALL retain OAuth credentials in memory, restrict loopback API access to the paired extension, and clear credentials on sign-out.
#### Scenario: Unpaired request
- **WHEN** an unpaired client attempts a note or session API request
- **THEN** the companion rejects it without exposing credentials or generating notes
### Requirement: Preserve transcription
The system SHALL preserve the working web transcription path and saved transcript when note generation fails.
#### Scenario: Notes rejected
- **WHEN** Responses rejects or incompletely streams a note request
- **THEN** the panel reports note failure and keeps the received transcript
