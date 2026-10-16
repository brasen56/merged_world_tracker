# Knowledge concision — writer inventory (Phase 0)

**Status:** Phase 0 deliverable, recorded 2026-10-16.
**Source:** `docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md` (Phase 0, "Inventory every model-driven field/ledger mutation … Record where shared validation must run").
**Scope:** Every code path in this repository where model-generated output can become NPC/world-info entry text, plus the seams a shared field contract (Phase 1) and cleanup guard rails (Phases 2–4) must cover. Line numbers were verified against the `experimental` branch on 2026-10-16; they will drift, so each entry names the function to re-locate.

## 1. The physical write layer

Every mutation of Knowledge-book NPC entries funnels through four writers in `knowledge/lorebook.js`:

| Writer | Location | Writes |
| --- | --- | --- |
| `writeToLorebook(name, content, keywords, existingUid)` | knowledge/lorebook.js:180 | Entire NPC entry `content`/`key`/`comment`. The only content writer for Knowledge-book NPC entries. |
| `writeStateTracker(uid, name, content)` | knowledge/lorebook.js:155 | Entire state-tracker entry content (sentinel-checked). |
| `writeProfileToLorebook(name, content, existingUid)` | knowledge/lorebook.js:465 | Entire Growth-profile entry in the "NPC Profiles" book (`key: []`, never injected). |
| `relabelLorebookEntry(...)` | knowledge/lorebook.js:334 | Label/keywords only, never content. |

Guards already inside `writeToLorebook`: stale-uid/store-entry refusal (lorebook.js:205–214), KNOWLEDGE-01 NPC-identity comment check (lorebook.js:215–242), adopt-before-create via `findEntryUidByNpcIdentity` (lorebook.js:261–276), `assertHydrated` on create (lorebook.js:294), `pushHistory` snapshot (lorebook.js:279). **There is no field-level type/structure/size validation of `content` at any writer.** The only size validation anywhere in the module is the state tracker's `validateStateOutput` cap (4× original + 2000 chars, lorebook.js:1162).

## 2. Flow-by-flow inventory

### 2.1 Compact scan and dossier scan

- **Generation:** `runScan({trigger})` — knowledge/lorebook.js:1205. System prompt from `buildScanSystemPrompt` (knowledge/prompts.js:183; compact template prompts.js:7, dossier template prompts.js:81). Two-attempt parse loop with `normaliseOutput` + lenient parse (lorebook.js:1265–1285); player-name filter is the only content filter (lorebook.js:1270–1277).
- **Proposal construction:** `buildStagingItems(scanResult)` — knowledge/staging.js:114. All scan records pass through here before any formatter:
  - creates via `formatMinorEntry` / `formatMajorEntry` / `formatDossierEntry` (lorebook.js:620 / :626 / :919);
  - update items get `applyFieldOwnership(regKey, data.fields)` (knowledge/staging.js:235, :258; ownership filter: knowledge/field_ownership.js:11 — nulls Growth-owned Personality only);
  - reclassified `new_*` matching a tracked NPC: staging.js:149–177 (`applyFieldOwnership` at :152, `fieldsFromScanRecord` at lorebook.js:761);
  - orphan `update_*` → synthesized creates: staging.js:222–258 via `synthesize*FromUpdate` (lorebook.js:733, :738, :1144).
- **Dossier specifics:** the dossier scan prompt can return every dossier field including `secrets` and `canon_lock` (prompts.js:118–137) — **the scan path does not filter `canon_lock`**; only Personality is ownership-filtered. Existing entries are fed back via `buildScanEntryProjection` (lorebook.js:1067, called at lorebook.js:1227–1237).
- **Triggers:** manual Scan (render.js:252–283); auto cadence `onMessageReceived → queueTrackerWork → runScan({trigger:'auto'})` (knowledge/index.js:204–211, :448–496); slash command `/wt-scan` (core/commands.js:67–77 → knowledge/index.js:873).

### 2.2 Staged scan enrichment (v2.12.1 append-only path)

- `enrichStagingItem(item)` — knowledge/lorebook.js:791. Update items: label-verified load (`loadEntryContent`, lorebook.js:383, called at :830), then merge dispatch to `buildUpdatedMinorContent` / `buildUpdatedDossierContent` / `buildUpdatedMajorContent` (lorebook.js:833–845) producing `item.mergedContent`.
- Create→update promotion when the book already holds the NPC (lorebook.js:806–822). **Gap:** the promotion fills `item.fields` via `fieldsFromScanRecord` *without* `applyFieldOwnership` (lorebook.js:816) — the one place scan fields reach a merge without the Growth filter.
- The append-only enrichment contract lives in the prompt (`DOSSIER_ENRICH_PROMPT`, prompts.js:231) plus `appendLedgerLines` behavior; pinned by test/knowledge_ledger_prompt.test.js and test/knowledge_scan_ledger.test.js (CHANGELOG v2.12.1).
- **Callers:** render.js:265, render.js:419, knowledge/index.js:468, `scanAndAccept` (knowledge/index.js:912).

### 2.3 Single-NPC update

- `runNpcUpdate(name, uid)` — knowledge/lorebook.js:1312. `NPC_UPDATE_PROMPT` / `DOSSIER_UPDATE_PROMPT` (prompts.js:56, :189); two-attempt parse; Growth guard inlined (Personality nulled when `hasEvidenceFile(name)`, lorebook.js:1369–1371); merges via `buildUpdatedDossierContent` / `buildUpdatedMajorContent` (lorebook.js:1373–1375). User-clicked only (render.js:579–620).

### 2.4 Enrich

- `runNpcEnrich(name, uid)` — knowledge/lorebook.js:1395. `DOSSIER_ENRICH_PROMPT` (prompts.js:231); `applyFieldOwnership(name, result.fields)` at lorebook.js:1448, then `buildUpdatedDossierContent` at :1449. `new_knowledge` is append-only. User-clicked only (render.js:626–664).

### 2.5 Selected-field refresh (🎯 Fields)

- `runDossierFieldRefresh(name, uid, fieldKeys)` — knowledge/lorebook.js:1528. `DOSSIER_FIELD_REFRESH_PROMPT` (prompts.js:270).
  - Request scoping: `sanitizeDossierRefreshFields` (lorebook.js:1481) drops unknown keys, always drops `canon_lock`, drops `personality` when a Growth evidence file exists.
  - Response scoping: only requested keys kept, empty string → null (lorebook.js:1599–1606); merge via `buildUpdatedDossierContent(currentContent, fields, [])` — no ledger writes on this path.
  - Reads recent messages (unlike the Phase 6 cleanup mode, which must be entry-only). `image_tags` is a selectable key today and is NOT excluded.
- User-clicked only (modal: render.js:2025, run handler render.js:2136–2190); unchanged merges stamp watermarks via `recordDossierFieldRefresh` (knowledge/dossier_status.js:88).

### 2.6 State tracker (model output written essentially verbatim)

- `runStateUpdate` — lorebook.js:1291; `validateStateOutput` (lorebook.js:1162) checks leak tags, transcript runs, added/dropped `UPPERCASE:` fields, and the module's only size cap (lorebook.js:1191). Written via `writeStateTracker`. Not a dossier-field path, listed for completeness.

### 2.7 Growth profiles and evidence (separate book / evidence store)

- `captureEvidence` (growth.js:235): verbatim-quote verification (`findQuoteMatch`, growth.js:287–306); appends to the evidence store **without staging** on the auto cadence (`runContinuousCaptureAll`, growth.js:1119, fired from knowledge/index.js:269–349).
- `generateProfile` (growth.js:335): output returned verbatim; banned-typology vocabulary is prompt-only. Reaches a lorebook only through explicit user "Save to Lorebook" → `saveProfile` (growth.js:493) → `writeProfileToLorebook` (render.js:1301–1330).
- `consolidateEvidence` (growth.js:732): model output stays in the evidence store, never the lorebook.

### 2.8 Relationship extraction and sync (model output → entry text)

- `runRelationshipExtract` — relationships.js:848 (`RELATIONSHIP_EXTRACT_SYSTEM_PROMPT`, prompts.js:463); scope re-check after the API call (relationships.js:897–900).
- `applyExtractedRelationships` (relationships.js:922): enum whitelists (`RELATIONSHIP_TYPES`/`USER_STANCES`, :940, :979), `neutral` dropped (:941, :980), both endpoints must resolve to registry entries (:944–946, :981), notes capped at 280 chars (:949), hand-entered edges never overwritten (:956, :987).
- Projection into entries: `formatRelationshipBlock` (relationships.js:667) + `injectRelationshipBlock` (:507) via `syncRelationshipsToLorebook` (relationships.js:682 → `writeToLorebook` :710). Runs automatically after extract/rename/merge and on manual edits (knowledge/index.js:504–568; render.js:3088+). The managed block (`<!-- mwt:relationships:start/end -->`, knowledge/state.js:36–37) is regenerated, not model prose — cleanup must leave it byte-identical.

### 2.9 Acceptance paths (reviewed and unreviewed)

| Path | Location | Trigger | Guards |
| --- | --- | --- | --- |
| Single Accept & Write (`handleAccept`) | render.js:80 (wiring :442–468) | user-clicked | placeholder rejection (`STAGING_PLACEHOLDERS`, staging.js:41; check render.js:447–459); editor text wins over model text; then `writeToLorebook` identity guards |
| Accept All | render.js:481–499 | user-clicked + `confirm()` | placeholder guard added for batch (:493); sequentially calls `handleAccept` |
| State-tracker accept | render.js:82–85 → `writeStateTracker` | user-clicked | sentinel check inside writer |
| `scanAndAccept()` | knowledge/index.js:898 | **programmatic only** (exported; no settings/UI/console binding today) | module-pause refusal (:902), fail-closed unverified update (:923–926), fail-closed placeholder (:930–933), then `writeToLorebook`/`writeStateTracker` (:944–966) |
| NPC import (`importNpcs`) | staging.js:611+ | user file | uid reconciliation; refused records quarantined before mutation |

There is no settings-based auto-approval of scans. Per plan invariant 9, cleanup proposals must be structurally barred from `handleAccept`, Accept All, and `scanAndAccept` — all three would accept any future staged item type by shape.

## 3. Formatter/merge choke layer (pure functions)

All model text becomes entry text through `knowledge/lorebook.js` pure functions:

| Function | Line | Role |
| --- | --- | --- |
| `stringifyDossierValue` | lorebook.js:899 | Coerces objects/arrays to strings — coercion, **not** validation. |
| `formatLedgerLine` | lorebook.js:647 | `- fact via source — date` rendering. |
| `appendLedgerLines` | lorebook.js:690 | Ledger-section insertion (end of section, replaces placeholder, starts a section when absent). |
| `buildUpdatedMinorContent` | lorebook.js:710 | Tone/Perceived as/descriptor. |
| `buildUpdatedMajorContent` | lorebook.js:721 | Compact fields + ledger append. |
| `buildUpdatedDossierContent` | lorebook.js:985 | All dossier fields + ledger append; normalizes the `[Dossier]` marker (:1012–1014) and inserts missing labels before the ledger (:1022–1030). **Not** byte-preserving — cleanup (Phase 2) must not reuse it for replacement. |
| `formatMinorEntry`/`formatMajorEntry`/`formatDossierEntry` | lorebook.js:620/:626/:919 | Create records. **Caveat:** `formatMajorEntry` and `formatDossierEntry` inline the ledger-line template instead of calling `formatLedgerLine` — validation added only to `formatLedgerLine` misses creates. |
| `synthesize*FromUpdate` | lorebook.js:733/:738/:1144 | Orphan-update creates. |
| `buildPromotedContent`/`buildDemotedContent` | lorebook.js:849/:858 | Promote/demote ledger section add/remove (not model text). |
| `fieldsFromScanRecord` | lorebook.js:761 | Scan record → fields map. |

Ledger format constants: `LEDGER_HEADER_RE = /^knowledge ledger:/i` (lorebook.js:642), `LEDGER_PLACEHOLDER = '- (no entries yet)'` (lorebook.js:644), heading written as `Knowledge Ledger:` (lorebook.js:629, :695, :740, :853, :930), section membership via `ledgerItemIndices` (lorebook.js:659 — run of `- ` items, blank lines tolerated, ends at the first non-blank non-item line, which is what keeps a trailing relationship block out of the section).

## 4. Where shared validation must run (the Phase 1 seam table)

One seam per flow, chosen where the flow's data is fully assembled and still pure:

| # | Flow | Seam | Covers |
| --- | --- | --- | --- |
| S1 | Compact + dossier scans | `buildStagingItems` (staging.js:114) | Every scan record, create and update, before any formatter. |
| S2 | Staged enrichment | merge dispatch in `enrichStagingItem` (lorebook.js:833–841) | Update merges; also the natural place to close the promotion ownership gap (:816). |
| S3 | Single-NPC update | beside the Growth guard before the merge (lorebook.js:1369–1375) | Parsed fields + new knowledge. |
| S4 | Enrich | beside `applyFieldOwnership` (lorebook.js:1448–1449) | Parsed fields + append-only knowledge. |
| S5 | Field refresh | the response scope-enforcement block (lorebook.js:1599–1606) | Already-narrowed per-field values; a per-field contract check drops in with no new plumbing. |
| S6 | Belt-and-braces choke | `buildUpdatedDossierContent` (lorebook.js:985) + `appendLedgerLines` (lorebook.js:690) | Every model-derived update and ledger append in update flows, whichever caller slipped through S1–S5. Creates additionally need coverage at `formatDossierEntry`/`formatMajorEntry` (or upstream at S1). |
| S7 | Physical writes | `handleAccept` (render.js:80) and `scanAndAccept` (knowledge/index.js:898) write sites | The only points that also see user-edited proposal text, which no formatter validates. Cleanup Apply must NOT be routed through either (plan invariant 9). |

Phase 2's ledger-cleanup parsing/patching is additive (new module) and must preserve raw spans rather than reuse S6 — `buildUpdatedDossierContent` normalizes headers and line endings and cannot promise ledger-only byte-for-byte replacement.

## 5. Gaps found during this inventory (inputs to Phase 1)

1. **No field validation anywhere:** no writer or merger checks type, structure, size, newlines, or label-forgery in field values; `stringifyDossierValue` coerces instead of rejecting.
2. **Scan/update/enrich paths can write `canon_lock`** — only the 🎯 Fields path forbids it (`sanitizeDossierRefreshFields`). Field-ownership filtering (`applyFieldOwnership`) covers Growth-owned Personality only (field_ownership.js:11).
3. **Ownership gap in create→update promotion:** `enrichStagingItem` promotion fills `item.fields` without `applyFieldOwnership` (lorebook.js:816).
4. **Creates bypass `formatLedgerLine`:** `formatMajorEntry`/`formatDossierEntry` inline the template (lorebook.js:631, :932), so ledger-line validation added to `formatLedgerLine` alone misses creation paths.
5. **Auto-scan cadence rewrites stable fields:** the scan prompt's "FILL MISSING FIELDS" + clipped `<existing_entry>` projection interacted badly historically (lorebook.js:1035–1058 documents the fix); the remaining exposure is prompt-driven rewrites the shared contract must bound.
6. **`scanAndAccept` exists as an unreviewed write path** with no caller today — cleanup proposals must be excluded from it by construction, and Phase 1 should not add new unreviewed item types it could consume.
7. **Line endings are not preserved by appends:** `appendLedgerLines` inserts LF lines into CRLF entries (pinned as a baseline in test/knowledge_concision_fixtures.test.js, "BASELINE CAPTURE" test). Phase 2's cleanup patching must preserve CRLF; Phase 1 may leave append behavior as-is.

## 6. Walk points that must skip a recovery container (input to the recovery-storage decision)

A dedicated recovery container entry in the Knowledge book (decision D1, `docs/KNOWLEDGE_CONCISION_DECISIONS.md`) must be skipped everywhere the book's entries are walked or enumerated. Known walk points today (the `[MWT:store]` entry's `isStoreEntry` precedents):

- knowledge/lorebook.js:208 (writeToLorebook uid guard), :343 (relabel guard), :426 (entry walk in import/scan book reads)
- knowledge/reconcile.js:18, :76 (uid/identity reconciliation)
- knowledge/staging.js:377, :766 (export/import walks)
- knowledge/relationships.js (roster/edge enumeration over registry — key by name, not entry walk, verify at implementation)
- backup/index.js:207 (backup book walk)
- knowledge/lorebook.js:1205 `runScan`'s already-tracked projection (reads registry uids, not a full walk — verify at implementation)

Phase 3 must add the container's sentinel check at each of these, and Phase 0's exit gate records this list so the implementation author does not have to re-derive it.

## 7. Non-goals

This inventory does not change any behavior. It records where validation must run (Phase 1), where cleanup parsing must not reuse merge helpers (Phase 2), which write sites are barred to cleanup Apply (Phases 3–4), and which walks must skip a recovery container (Phase 3 / decision D1).
