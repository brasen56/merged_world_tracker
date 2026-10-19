# Targeted Growth capture (Phase 2)

In an NPC's Growth modal, **Targeted Capture** first previews scenes selected by
VectFox. **Run Targeted Capture** is a second, explicit action. **Cancel** aborts
the pending request where the provider supports it and always prevents the
uncommitted batch from being saved. Closing the modal also requests cancellation.
Earlier successful batches remain saved if a later batch fails or is cancelled.
Catch Up retains its existing chronological behavior.

Both extensions need the Phase 2 changes. MWT requires VectFox API v1 with
`capabilities.candidate_windows.available`, `findCandidateWindows`, and source
resolution. Missing/disabled/unsupported integrations report an error rather than
claiming a successful empty search. No private VectFox modules are imported by MWT.

## Bounds and evidence

- Current-chat originals only; no cross-chat original loading.
- At most four candidate windows, 40 sources per window, 120 sources total.
- Overlapping source references are merged by VectFox; resolved original identities
  are deduplicated again by MWT before generation.
- At most 16,000 message characters per batch and 48,000 per run. Whole messages
  exceeding a budget are omitted, not silently truncated and marked covered.
- Auxiliary dossier/world/chronicle context is limited to 2,000 characters each.
- At most four generation calls, with retries disabled. Planning uses at most one
  candidate request and four resolution requests; commit revalidation uses at most
  four more resolution requests. VectFox's candidate request internally reads history
  once and resolves at most 120 references once. Reads never generate or embed.
- No surrounding messages are added outside the selected original source sets.
- Only verified originals are sent to capture. Changed, missing and unresolved
  originals are reported unavailable, never replaced by event summaries.
- Shared verification resolves quotes against the supplied originals. Recovered
  originals retain their own timestamp and source identity, not a container index.
  Existing unverified-quote flags and observation deduplication remain in effect.

Coverage is persisted in each evidence file's `meta.targetedCoverage`: source chat,
NPC entity identity (or name fallback), original host identity (or unambiguous
resolved-source fallback), content fingerprint, and processing time. Coverage and
observations share the checked evidence commit, including zero-observation results.
The evidence schema validates coverage and the existing metadata backup/restore path
preserves it. Failed/cancelled/refused batches stay retryable. Changed fingerprints
are eligible after VectFox supplies freshly verified references (edits may require
event repair/re-extraction). Neither chronological watermark is modified.

## Validation and long-chat comparison

Automated tests cover recovered-original timestamps, overlap, repeat skipping,
zero-observation coverage, edits, malformed generation, cancellation, stale scopes,
source changes during generation, refused commits, schema validation and API bounds.

A representative live comparison remains a release-validation task; no model-backed
efficiency claim has been made. Use separate restored copies of the same long-chat
backup and NPC evidence state for Catch Up and Targeted Capture. Record:

1. Chat length, ILS-recovered originals, event coverage limitations and NPC identity.
2. Model/provider/settings and the selected targeted scene references.
3. Generation calls, actual provider prompt/completion tokens, runtime and failures.
4. Verified observations, distinct useful behavioral claims, original messages covered,
   duplicate/repeated variants and missed important behavior (manual review).
5. Repeat-run cost, an edited-source rerun, cancellation and resumed work.

Targeted results expose `calls`, `inputChars`, `messages`, `verified`, `added` and
`skipped`. The existing capture provider returns text only, so `tokenUsage` is
explicitly null; record actual tokens from provider diagnostics rather than inventing
an estimate. Fewer observations or repeated variants alone are not an improvement.