## Requirements
### Requirement: Timely ordered transcription
Captured audio is transcribed in short ordered batches without waiting for note generation; completed text is saved and shown promptly. It must not be described as streaming or guaranteed real time.
### Requirement: Preserve transcript and notes
A slow notes response must not overwrite newer transcript segments; invalid or stale corrections must be skipped without inventing alignment. Notes work is serialized and pending updates coalesced. Stop flushes and drains accepted work, and failures and overflow are explicit.
### Requirement: Verification
Regress slow notes blocking later transcription, late correction merging, note coalescing, queue overflow, stop and failures, and verify a real short video where permitted. Independent spec, quality and security review are required.
