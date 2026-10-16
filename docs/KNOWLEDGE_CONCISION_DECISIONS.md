# Knowledge concision — Phase 0 decision record

**Status:** Recorded Phase 0 design decisions, 2026-10-16.
**Source:** `docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md` (Phase 0, "Decisions to record before leaving this phase") plus the supported-formats decision required by the Phase 0 fixture work item.
**Companion documents:** `docs/KNOWLEDGE_CONCISION_WRITER_INVENTORY.md` (writer/seam inventory), `test/fixtures/knowledge_concision.js` + `test/knowledge_concision_fixtures.test.js` (baseline fixtures).
**Standing:** These are the recorded defaults the plan §2 contemplates ("proposed defaults"). The implementation plan remains the discussion record; co-author review may amend any decision here — amend the decision, not just the code.

---

## D1 — Recovery storage, schema versioning, verified persistence, failure behavior

**Decision:** Cleanup recovery originals live in a **dedicated sentinel entry inside the resolved Knowledge lorebook** (comment prefixed `[MWT:cleanup-recovery]`, exact title fixed at implementation), using the existing lorebook-store infrastructure — no new storage dependency. Not a field inside the `[MWT:store]` JSON, not localStorage, not `pushHistory`.

**Evaluation required by the plan, with evidence:**

1. **Originals never enter any prompt/injection projection.** Injection is host-driven: ST's world-info engine decides from entry fields; MWT's own injections go through a separate `setExtensionPrompt` path this module never uses. The production precedent is the `[MWT:store]` entry itself: `key: []`, `keysecondary: []`, `enabled: false`, `disable: true`, `constant: false`, `selective: false`, `vectorized: false`, `excludeRecursion: true`, `preventRecursion: true` (knowledge/store.js:1163–1181), **re-asserted on every save** (knowledge/store.js:1183–1203 — the code comment documents that `constant` and `vectorized` are the only two flags that bypass keyword matching, so they must be re-asserted every write). The recovery container adopts the identical flag set and re-assertion. Residual risk, accepted and mitigated: between MWT saves a host-side import or World Info editor edit could flip flags live; the re-assertion on every recovery write is the mitigation, and recovery contents are additionally treated as untrusted data (never rendered as instructions). Note the container rides inside the Knowledge book even when that book is bound to an activation slot — exactly how the store entry coexists with a bound book today.
2. **Survive reload.** Book files are server-side and persist across host reloads; entry writes go through the awaited `saveWorldInfo(name, wi, true)` form (`saveBookNow`, knowledge/store.js:1267). A plain entry in the book file is re-read on every load — same durability as the store entry.
3. **Exportable.** Host book export carries every entry by design (knowledge/store.js header rationale: a hidden top-level JSON key was rejected precisely because converters rebuild books from `entries`). The extension's own unified backup needs explicit wiring — that is D3.

**Why a sentinel entry rather than a store field (the alternative evaluated):** two real distinctions and one non-distinction, stated plainly so nobody inherits an overclaim.

- **Real — failure-domain isolation:** a corrupt store JSON pauses the whole store (fail-closed hydration, knowledge/store.js:377–721); recovery payload corruption must not be able to pause ordinary knowledge writes. A separate entry also keeps recovery out of store schema versioning/migrations entirely and is parsed only when recovery is read.
- **Real — serialization coupling:** `applyStoreToWorldInfo` re-serializes the store entry's entire JSON on EVERY book save (knowledge/store.js:1143–1157); a store field would re-stringify every recovery original on every save even when recovery is unchanged. The sentinel's content is rewritten only by recovery writes.
- **NOT a distinction — persistence payload:** book saves are whole-book (`saveWorldInfo` posts the entire world-info object), so recovery bytes ride every save of that book whichever entry holds them, and the book file grows by the recovery originals. That cost is inherent to in-book storage, is disclosed here, and is why D2's controls (size surfacing, explicit deletion, quota-exhaustion-blocks-new-cleanup) exist. "Rewritten only by recovery writes" therefore means *content updates and serialization happen only on recovery writes* — not fewer book saves.

**Schema versioning:** the container content is JSON `{ version: 1, records: [...] }` with its own container version, refused untouched when a future version is encountered — the embedded quarantine container's exact pattern (`STORE_QUARANTINE_FIELD`, knowledge/store.js:966; future-version refusal knowledge/store.js:968–998). Record shape (Phase 3 implements, listed here so it is not left implicit):

```
actionId, createdAt, bookName, scopeKey, entityName (canonical registry key),
entityStableId, entryUid, actionType: 'ledger-condensation' | 'field-cleanup',
status: 'original-saved' | 'applied' | 'failed' | 'outcome-uncertain',
originalContent (exact bytes, line endings included), replacementFingerprint,
appliedAt?
```

**Verified persistence and failure behavior:** persist-and-verify before mutating the target — write the container through the awaited book save, re-load the book, and verify the original is present byte-for-byte; any failure blocks Apply and leaves the live entry unchanged. The patterns to copy are the store's hydration commit under `withStoreLock` (knowledge/store.js:158, :197, commit at :616–672) and the backup restore transaction (`beginStoreTransaction` + capture/rollback, knowledge/store.js:1074–1102, backup/index.js:407–486). `pushHistory` is explicitly rejected as recovery: ≤50 snapshots, quota errors swallowed (knowledge/lorebook.js:93–103; plan §3).

**Consequences:** every book walk must skip the new sentinel (the store entry's `isStoreEntry` precedents, enumerated in writer-inventory §6); restore verifies scope/book/entity/UID bindings and refuses on mismatch (conflict view, never blind overwrite); display names alone never identify a destination (knowledge/identity.js, knowledge/reconcile.js).

---

## D2 — Retention policy and user controls

**Decision (v1 default, per the plan):** **no silent age- or count-based eviction of cleanup originals.** Recovery records persist until the user explicitly deletes them.

- **Visibility:** a recovery listing (Phase 4 UI, not only a console command) showing each record's entity, date, action type, status, and size, plus the container's total size — all sizes labelled estimates (D4's estimator).
- **Export:** per-record and whole-container export as a clearly labeled, versioned JSON file, validated on import (round trip required — D3).
- **Explicit deletion:** offered per record and for the whole container, with the consequence stated at the confirmation step (after deletion, that original is no longer recoverable; the live entry is unaffected).
- **Quota/capacity exhaustion:** a failed recovery save **blocks the new cleanup** (fail closed, D1) and surfaces the error with remedies (export then delete older recovery records; free browser/server storage). Existing recovery records are never discarded to make room. No count cap; cumulative size is surfaced instead.
- **Deleted entities:** records whose destination entity is gone stay listed as "destination missing", remain exportable and explicitly deletable, and are never auto-purged.
- **Renamed/merged entities:** restore re-verifies stable identity (D1); mismatch shows a conflict and refuses to write.
- **Deleted books:** the container lives in the book, so deleting the book deletes its recovery records along with the entries they protect — acceptable and documented (the data the originals would restore no longer exists either).
- **Book export/import:** the container entry rides host book exports for free (D1); re-importing a book into another scope is a manual, clearly labeled path, not the primary restore UX.

---

## D3 — Backup behavior

**Decision:** cleanup recovery **is included in the versioned unified backup** as a top-level envelope container (`cleanupRecovery`), following the envelope `quarantine` precedent.

- **Envelope:** `buildBackupEnvelope` gains the optional container (backup/data.js:108; `quarantine` precedent at :162–165); present only when non-empty so envelopes without recovery keep the exact historical shape. The container carries its own `version` field (core/quarantine.js:20 precedent). **No `FORMAT_VERSION` bump** — unknown top-level fields are ignored by older builds, exactly how `quarantine` shipped.
- **Collection:** explicit addition to `collectBackup`'s knowledge-store block (backup/collect.js:91, whitelist at :157–166) reading the container from the resolved Knowledge book. A **refused** container (future version / unsafe to read) aborts the export visibly with the quarantine-refusal semantics (backup/collect.js:180–189): a backup must never silently omit recovery records.
- **Import/restore:** tolerant validation — a malformed container warns but never blocks the rest of the restore (`quarantine` import precedent, backup/validate.js:297–307); the commit merges records keyed by `actionId`, current-wins on exact duplicates, preserving unrecognized fields for forward compatibility.
- **Round trip:** launch requires a tested export→import round trip extending the `test/backup_schema_roundtrip.test.js` pattern; an export-only promise is not sufficient (plan decision 3).

---

## D4 — Field validation bounds and request-capacity policy

### D4a — Generous per-field validation bounds

Enforced at the writer-inventory seams S1–S7 before any merge/format. **These are structural backstops against runaway event-log values (thousands of characters), not scope enforcement** — per plan §2.2 a valid 13-word Role must not fail for word count, and deliberately, the reported 149-character Role example (test/fixtures/knowledge_concision.js, `REPORTED_ROLE_LINE`) **passes** the Role bound: its problem is semantic scope, which the Phase 1 prompt contract addresses, not length.

Bounds were chosen as ≥ ~2× the longest legitimate value in the Phase 0 fixtures and are maximum characters per stored value:

| Field | Max chars | Structural rules |
| --- | --- | --- |
| Tone | 120 | single line |
| Perceived as | 200 | single line |
| Descriptor | 200 | single line; header-slot only |
| Role | 400 | single line |
| Where to Find | 300 | single line |
| Read on PC | 400 | single line |
| Current Agenda | 400 | single line |
| Canon Lock | 800 | single line; ordinary paths only — never writable by cleanup |
| Image Tags | 400 | never model-writable; bound is defense-in-depth at the S6 choke |
| First seen | 300 | creation paths only |
| Appearance | 900 | single line (see below) |
| Voice | 600 | single line |
| Background | 1200 | single line |
| Personality | 900 | single line; Growth ownership unchanged |
| Secrets | 1200 | single line; tier separator ` \| ` as today |
| Ledger fact | 800 | non-empty; no line breaks |
| Ledger source / date | 80 / 80 | non-empty source falls back to `unknown` |
| Header line | 300 | `name \| species \| descriptor` shape, creation paths |

**"Single line" is a storage-format constraint, not a style choice:** entries are line-oriented (`Label: value`, one line per field, knowledge/lorebook.js:985–1032), so a value containing a line break corrupts the structure. Validation **rejects** line-break-containing values; it never joins, slices, or reflows them.

**Rejection behavior (uniform):** a value failing type/structure/size is dropped with a field-specific surfaced reason; the existing entry keeps its old value, a new entry falls back to its unknown/empty convention; unrelated valid updates in the same proposal are retained; retries stay bounded to the existing two-attempt pattern. Also rejected, never silently sliced: label/heading forgery (a value whose text would parse as another field label or a `Knowledge Ledger:` heading), and managed-block markers (`<!-- mwt:relationships:`). Values may be string/number/boolean, plus the documented structured shapes for secrets/canon_lock that `stringifyDossierValue` already coerces (knowledge/lorebook.js:899); anything else is rejected before coercion.

### D4b — Request-capacity policy

- **Estimator:** `estimateTokens` (core/context.js:322) — the SillyTavern tokenizer when the host exposes one, otherwise `ceil(chars / 4.5)` (core/context.js:314). Every size shown to users is labelled an **estimate**, with the mode disclosed (tokenizer vs heuristic). The heuristic is never presented as a provider measurement, and the reported 15,118-token entry size remains a user report, not a benchmark.
- **Which model's limits apply:** the context limit and the output allowance both attach to the **resolved Knowledge connection** — the connection profile / model the Knowledge module itself uses (`connectionProfileId` / `modelName` / `maxTokens`, knowledge/settings.js:13–22), resolved exactly as an ordinary Knowledge scan resolves it — never implicitly the main chat model's limits. If the resolved profile declares no context limit, the limit is *unknown* (check 4 below); it is never defaulted from the chat model or guessed.
- **Combined budget — input and output share one window, and the checks are joint, not independent.** A request that passes only because input and output were checked separately is precisely the failure this rule exists to prevent: a 12,000-token input with an 8,000-token allowance must NOT pass against a 16,000-token context. Before sending, every applicable check passes:
    1. **Output need fits the allowance:** `estimatedOutputNeed ≤ maxTokens`, where `estimatedOutputNeed = ceil(0.75 × ledgerTokens) + 400` — proposed records + per-record source mappings + advisory notes + JSON overhead, a **documented planning heuristic, labelled as such**, not a provider fact. The plan's caveat stands: the 8,000-token default is not evidence that a 15,000-token source can yield a complete mapped result.
    2. **Reserve only what the request asks for:** the request's output reservation is `requestedOutput = min(maxTokens, estimatedOutputNeed)` — never ask the provider for more than the estimate needs.
    3. **Combined fit, when the context limit is known** (profile-declared or explicitly configured): `inputEstimate + requestedOutput + SAFETY_MARGIN_TOKENS ≤ contextLimit`, where `inputEstimate` covers the ledger section, the minimal identity context, AND the prompt/system overhead, and `SAFETY_MARGIN_TOKENS = 512` is a fixed documented constant covering estimator-vs-tokenizer drift and request framing the estimate cannot see.
    4. **Unknown context limit:** display "unknown" and enforce checks 1–2 only; a guessed limit is never advertised as provider-verified, and refusal happens only against an explicitly known or configured limit.
- **Refusals (each names the failed check, the numbers involved, and the configuration change that helps — raise the output allowance, point the Knowledge profile at a larger-context model, or hand-trim the entry for now):** any failure of the applicable checks above, before the request is sent.
- **Truncated/repaired output is a failure, not a proposal:** a provider-reported `finish_reason: length`, or JSON that only parses after lenient repair (core/api.js:792, :964 — repair records a warning), counts as failed condensation. Cleanup uses strict parsing after explicitly permitted wrapper normalization and never truncation repair (plan invariant 12; Phase 2 implements).
- **No silent clipping of the ledger**; automatic chunking remains deferred.

---

## D5 — Field-refresh reuse assessment (does Phase 6 join the initial release?)

**What the existing 🎯 Fields refresh already provides:** selected-fields-only operation; response scope enforced in code to exactly the requested keys, empty string → null (knowledge/lorebook.js:1599–1606); `canon_lock` always dropped and Growth-owned `personality` dropped when an evidence file exists (`sanitizeDossierRefreshFields`, knowledge/lorebook.js:1481); staged review before write; no ledger writes (`buildUpdatedDossierContent(currentContent, fields, [])`).

**Changes required for a separate entry-only cleanup mode:**

1. **New prompt variant** reading `<current_entry>` only — no recent messages — with cleanup semantics (concise current value, displaced-detail notes, refuse-on-ambiguity). This contradicts the refresh prompt's "echo or fill" rule (knowledge/prompts.js:270–284), so it is a separate template, not a flag.
2. **Eligibility narrowing:** additionally exclude `image_tags` (selectable today) and managed relationship blocks from any rewrite; add byte-preservation tests for all unselected text including the block.
3. **Response schema additions:** per-field explanation and displaced-detail notes (new channel, not just values).
4. **Per-field keep/edit/accept decisions in the UI** — the current flow accepts one merged content blob.
5. **Ownership recheck at Apply** (ownership can change between proposal and application), and routing through the Phase 3 recovery/commit service instead of `handleAccept`/`scanAndAccept`.
6. **No Growth/secret-lifecycle changes; no relocation of displaced details** into the ledger, Current Agenda, or Canon Lock (plan Phase 6).

**Assessment:** items 1, 3, and 4 are new surfaces (template, schema channel, decision UI), not tweaks to the existing flow — Phase-4-scale work on top of Phase 3 plumbing. **Decision: Phase 6 ships as a follow-up release by default**, matching the plan's release role ("Follow-up unless independently ready"). It may join the initial release only if, after Phase 4 passes its exit gate, the changes above land without delaying Phase 5's representative-size and host validation. The Phase 6 exit criteria in the plan are unchanged.

---

## D6 — Supported ledger formats and boundaries (from the Phase 0 fixture work item)

The boundary corpus lives in `test/fixtures/knowledge_concision.js` (`KNOWLEDGE_CONCISION_DOCUMENTS`); `test/knowledge_concision_fixtures.test.js` pins that each supported document parses and each ambiguous one is honestly ambiguous under the **current** parser semantics.

**Supported — all must hold, else refuse with a user-readable reason:**

1. **Exactly one ledger heading:** a line whose trimmed, case-insensitive text is exactly `knowledge ledger:` — nothing else on the line. (Case variants like `knowledge ledger:` are fine — the current matcher is case-insensitive, knowledge/lorebook.js:642.) Note: the append-time regex tolerates trailing text on the heading line; cleanup deliberately requires the stricter exact form.
2. **Section extent:** the contiguous run of `- `-prefixed lines after the heading (blank lines tolerated), ending at the first non-blank non-item line — the `ledgerItemIndices` convention (knowledge/lorebook.js:659). Indented items count.
3. **Empty ledger:** the `- (no entries yet)` placeholder or zero items → nothing to condense; explain and offer nothing to rewrite.
4. **Line endings:** LF, CRLF, or mixed are all supported; the rewrite must leave every byte outside the replaced ledger span untouched, including endings, and preserve the trailing-final-newline convention (or its absence).
5. **Trailing managed relationship block** (`<!-- mwt:relationships:start/end -->`) is a normal section terminator; it stays byte-identical.
6. **Header-agnostic:** compact (`Name | Species | descriptor`) and dossier (`[Dossier] …`) entries are both eligible — condensation touches only the ledger span and never inserts markers, reorders labels, or normalizes anything else (which is why `buildUpdatedDossierContent` is not the cleanup patcher).

**Refuse (ambiguous/unsupported — never guess a boundary):**

- Zero headings, even if `- ` lines exist (append flows would create a section, but condensation cannot know which lines are the ledger).
- Two or more headings.
- A heading with extra text on its line.
- Additional `- ` item lines after the section's terminating line (e.g., past an intervening prose line) — the true ledger extent is ambiguous; refuse with the suspect lines listed rather than silently condensing a subset.
- Any case where the ledger span cannot be determined byte-exactly.

---

## Cross-reference

| Decision | Feeds |
| --- | --- |
| D1 | Phase 3 (recovery service), writer-inventory §6 (walk-point skips) |
| D2 | Phase 3 (retention controls), Phase 4 (recovery UI) |
| D3 | Phase 3/5 (backup round trip) |
| D4a | Phase 1 (`knowledge/field_contract.js` bounds + seams S1–S7) |
| D4b | Phase 4 (preflight + disclosure), Phase 5 (refusal evidence) |
| D5 | Phase 6 scoping |
| D6 | Phase 2 (`knowledge/ledger_cleanup.js` boundary parsing) |
