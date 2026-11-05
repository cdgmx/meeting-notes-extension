## Requirements
### Requirement: Stable earlier notes
Every accepted rolling update preserves all prior notes exactly and appends only the new delta. Prior transcript provides context, not authorization to rewrite previous notes. Empty delta is valid. Concurrent note changes must not be overwritten.
### Requirement: Safe progress
Save notes and successful notesCursor together, retain transcript and existing failure handling. Invalid output does not advance progress or discard saved text.

### Requirement: Context-aware recent self-healing
Store bounded topic, subjects and purpose derived only from recorded transcript. Unknown context stays unknown; context guides resolving misheard words without inventing speech. Apply corrections only to the current latest five transcript segments and preserve all older text and all original transcription. Clear resets context with notes/transcript. Invalid context must not erase previous valid context or valid notes; report it explicitly.
