# World State — Stale-Entry Expiry & Provenance Tracking

> **Status:** §11 rollout steps 1–4 implemented (2026-07-03) — see `world_state/provenance.js`
> (`buildProvenance`, `applyExpiry`, `groundingGate`, `purgeStaleEntries`), wired into
> `refresh.js` (full pipeline: grounding gate → expiry → provenance rebuild) and
> `sections.js` (grounding gate only, per §7). All of it is **off by default**
> (`expiryEnabled: false`, `groundingEnabled: false`) — see the "🧹 Stale-Entry
> Expiry & Grounding" settings group in the World State modal to turn it on.
> `expiryMode: 'mark'` and `groundingMode: 'soft'` are the conservative
> defaults when enabled; `quarantine`/`remove` and `strict` are available but
> opt-in, per the risk table in §10.
>
> This document describes a more robust, code-level approach to preventing
> World State "bloat" — stale entries that never retire, and phantom entries
> the LLM invents. It is intended as a reference if the current **prompt-only**
> fix (see `prompts.js`, hardened "Core rules" + tightened section descriptions)
> ever proves insufficient.

---

## 1. Why this exists

Three failure modes were observed, primarily with highly capable ("flagship")
models that obey instructions very literally and "helpfully" invent detail:

1. **Speculation** — entries like *"Coombs identification ... all unexplored"*
   landing in `## Pending` / `## Unresolved Threads`. The model treats "open
   question" as an invitation to produce its own meta-analysis.
2. **Zombie entries** — an NPC (e.g. *Dr. Aboud*) referenced 60+ messages ago
   that never disappears, because the previous default rule was *"preserve
   stable facts unless contradicted"* and the NPC is never inside the scan
   window to be contradicted.
3. **Phantom invention** — an NPC (e.g. *Lorraine*) appears that was never
   established in chat or in the prior state.

### Why prompt-only may not be enough long-term

Prompts are a *soft* constraint. A strong model can still drift, especially
over long sessions or when the scan window (`maxScanMessages`, default 20, capped
at 30) genuinely cannot see the last mention of an entity. A code-level guard
gives a *hard* floor on staleness that does not depend on the model's compliance.

---

## 2. Design goals

- **Provenance tracking** — every tracked entity (NPC, location, item, thread)
  records *when* it was last touched (message index) and *where* the evidence is
  (message index(es)).
- **Deterministic expiry** — entries whose last-touch exceeds a configurable
  threshold are removed (or demoted) by the extension, independent of the LLM.
- **Grounding check** — optionally validate that every name in the regenerated
  state actually appears in the scan window or the prior state, flagging/gating
  phantom names before they are saved.
- **Non-destructive / opt-in** — defaults conservative; user can disable.
- **Minimal parsing surface** — works on the existing free-text Markdown world
  state, so no schema migration is required to ship.

---

## 3. Terminology & current mechanics (for implementers)

- The world state is a **free-text Markdown string** stored at
  `meta[CHAT_DATA_KEY].text` (see `world_state/data.js`).
- Sections are defined in `SECTIONS` (`data.js`); extraction/replacement helpers
  live in `world_state/sections.js` (`extractOnlySection`, `replaceSection`).
- Refresh happens in `world_state/refresh.js`:
  - `getRecentMessagesForScan()` builds the look-back window (`maxScanMessages`,
    clamped 1..30).
  - `refreshWorldState()` calls the LLM, then overwrites `text` wholesale.
- Auto-refresh runs every N messages (`getAutoRefreshInterval()`, default 5).
- There is currently **no per-entry metadata** and **no post-generation lint**.

---

## 4. Data model (proposed addition)

Add a sibling object to the world state text under the same chat metadata key:

```js
// meta[CHAT_DATA_KEY].provenance (NEW)
{
  entities: {
    // key = normalized entity name (lowercased, trimmed)
    "dr. aboud": {
      label: "Dr. Aboud",          // display name as last seen
      lastTouchedMsg: 142,          // 0-based chat index of last mention
      lastTouchedAt: 1719600000000,// epoch ms
      source: "chat",               // "chat" | "prior-state" | "user"
      section: "Off-Screen",        // last section it lived in
      mentionCount: 7
    }
  },
  lastBuiltAtMsgIndex: 165,         // chat length when provenance was last built
  schemaVersion: 1
}
```

Storage helpers should be added to `data.js` (e.g. `getProvenance()`,
`setProvenance()`, mirroring the existing `getWorldStateData` pattern), with a
migration path that treats a missing `provenance` object as "needs rebuild".

---

## 5. Core algorithm

### 5.1 Build provenance (lightweight scan)

A deterministic pass that does **not** call the LLM. Run it:

- after every successful refresh, and
- opportunistically on `MESSAGE_RECEIVED` (cheap; bounded by scan window).

Steps:

1. Read the scan window (`getRecentMessagesForScan` already gathers the text;
   reuse the same slice but keep message indices).
2. Tokenize into name candidates. Two sources of "known names":
   - Names already present in the current world state text (regex over
     `**Name**:` and `**Name** [` headers across sections).
   - Names from a chat entity extraction pass (capitalized noun phrases, or
     better: reuse the Knowledge module's NPC scan if available — see §9).
3. For each known name, record the **highest** chat index where it appears in the
   window as `lastTouchedMsg`.
4. Merge with existing `provenance.entities` (don't lose history for names not
   in the current window — just don't advance their `lastTouchedMsg`).

Keep this **O(names x window)** and cheap.

### 5.2 Expiry policy

Configurable in `settings.js` (new fields with safe defaults):

```js
expiryEnabled: false,        // off by default
expiryStaleAfterMsgs: 40,    // drop if not referenced in last N messages
expirySections: ['Off-Screen', 'Pending', 'Unresolved Threads', 'Active Threads'],
expiryMode: 'remove',        // 'remove' | 'quarantine' | 'mark'
```

Apply **after** a refresh, before `setWorldStateData({ text })`:

- For each section in `expirySections`, enumerate its entries.
- For each entry, resolve the primary name (the bolded token).
- If `currentMsgIndex - entity.lastTouchedMsg > expiryStaleAfterMsgs`:
  - `remove` -> drop the bullet entirely.
  - `quarantine` -> move to a `## Archive (Stale)` section (kept out of injection).
  - `mark` -> append `(stale)` so the LLM sees the signal next refresh.

Edge cases to handle:
- Entities in the **Current Scene / Present** line and **Key Character States**
  are **never** expired (they are the active cast).
- The protagonist/POV character should be pinned via a configurable
  `pinnedEntities` list (names that never expire).
- If an entity has no provenance record at all (never seen in a window),
  **do not** auto-remove on the first pass — give it one grace cycle, otherwise
  a brand-new NPC introduced in the latest message could be nuked.

### 5.3 Grounding check (anti-invention gate)

A **pre-save lint** that catches phantoms like *Lorraine*:

1. After the LLM returns the new state text, parse out every bolded name.
2. Build the set of "grounded" names = (names in scan window) U (names in the
   **previous** state) U (pinnedEntities).
3. Any name in the new state **not** in the grounded set is suspicious:
   - **Soft mode (default):** log a warning + strip the offending bullet/line,
     then save the cleaned text.
   - **Strict mode:** reject the whole generation and retry once (mirrors the
     existing `validateOutput` retry path in `refresh.js`).

This directly addresses symptom 3 and is far cheaper than re-prompting.

---

## 6. Where the code lives (suggested file layout)

```text
world_state/
├── data.js          # + getProvenance()/setProvenance(), EXPIRY defaults
├── settings.js      # + expiryEnabled, expiryStaleAfterMsgs, expirySections,
│                    #   expiryMode, groundingMode, pinnedEntities
├── prompts.js       # (already hardened - keep the prompt fix as layer 1)
├── refresh.js       # call applyExpiry() + groundingGate() before setWorldStateData
├── sections.js      # (unchanged, but provenance build can reuse extractOnlySection)
└── provenance.js    # NEW: buildProvenance(), applyExpiry(), groundingGate(),
                     #      name extraction helpers
```

`provenance.js` should be a leaf-ish module importing only `data.js` / `settings.js` to avoid circular deps (the rest of the module graph already has tight coupling around `refresh.js`).

---

## 7. Integration points in the refresh flow

In `refreshWorldState()` (`refresh.js`), right before the existing `setWorldStateData({ text })`:

```js
// pseudo-code
let finalText = text;
let prov = getProvenance();

// (a) anti-invention gate
const grounding = groundingGate(finalText, {
  scanNames: collectNamesFromScan(),
  priorNames: collectNamesFromText(oldText),
  pinned: getSettings().pinnedEntities,
  mode: getSettings().groundingMode, // 'soft' | 'strict'
});
if (!grounding.ok) {
  // soft: grounding.cleanedText already has phantoms stripped
  // strict: throw to trigger the existing retry path
}
finalText = grounding.cleanedText ?? finalText;

// (b) expiry
finalText = applyExpiry(finalText, prov, {
  currentMsgIndex: getChat().length,
  // ...expiry settings
});

// (c) rebuild provenance from the saved text + scan
prov = buildProvenance(finalText, scanWithIndices);
setProvenance(prov);

setWorldStateData({ text: finalText });
```

The per-section regeneration path (`regenerateSection` in `sections.js`) should apply the **grounding gate only** (expiry is a whole-document concern and should not run on a single-section regen).

---

## 8. UI surface (optional, when shipping)

- World State settings panel (`render.js`): a collapsible **"Stale-entry
  management"** group with the settings from §5.2 + a live readout of how many
  entries are currently within/over the staleness threshold.
- Editor view: a subtle `(stale — last seen N msgs ago)` annotation next to
  bullets the expiry pass has *marked* but not removed (requires `expiryMode:
  'mark'`).
- A manual **"Purge stale entries"** button that runs `applyExpiry` on demand.

---

## 9. Reuse opportunities with other modules

- **Knowledge module** (`knowledge/`) already scans chat for NPCs and maintains
  an NPC registry. Its name-extraction logic is the ideal source for
  `collectNamesFromScan()` rather than reinventing NER. Consider exporting a
  shared `extractEntityNames(messages)` helper from `core/`.
- **Chronicle module** timestamps events; could seed `lastTouchedAt` for
  cross-referencing calendar staleness (e.g. "Friday session contents now
  unprocessed for ~21 hours" type entries are time-driven, not message-driven,
  and need a separate time-based expiry on `## Pending`).

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Regex name extraction misses/garbles names | Conservative: only act on **bolded** tokens that already parse cleanly; never auto-remove ambiguous matches. |
| Expire something the user wanted to keep | Default `expiryEnabled: false`; `pinnedEntities`; grace cycle for unseen entities; quarantine/mark modes before remove. |
| Provenance grows unbounded | Cap `entities` map; prune entries older than `2 x expiryStaleAfterMsgs` that are no longer in the state text. |
| Grounding false-positive strips a valid new character | Soft mode strips the *bullet*, not the section; log every strip so the user can see/undo via history (`pushToHistory` runs before save). |
| Cost of extra scans | Build pass is O(names x window) with no LLM call; negligible vs. the refresh itself. |

---

## 11. Suggested rollout

1. ✅ **Done (2026-07-03).** Provenance **building + read-only UI**, no mutation.
   `world_state/provenance.js` (`buildProvenance()`, `getStalenessReport()`,
   `extractBoldNames()`) + `data.js` (`getProvenance()`/`setProvenance()`) +
   a "🕒 Entity Provenance" panel in the World State modal (`render.js`).
   Wired to rebuild after full refresh (`refresh.js`) and section regen
   (`sections.js`), plus a manual "Rebuild Provenance" button.
   Name extraction is text-only (bolded tokens) — the chat-side NER source
   from §5.1 step 2b and the §9 Knowledge-module reuse are **not** done.
2. ✅ **Done (2026-07-03).** `applyExpiry()` in `provenance.js`, with
   `expiryMode: 'mark'` as the default (non-destructive — appends
   `(stale — last seen N msgs ago)`). Gated behind `expiryEnabled` (off by
   default). Runs in the full-refresh pipeline (`refresh.js`) only, per §7 —
   never on per-section regen. `NEVER_EXPIRE_SECTIONS` hard-exempts "Current
   Scene" and "Key Character States" regardless of configured
   `expirySections`. Entities with no provenance record get a grace cycle
   (never acted on). `buildProvenance()` also now prunes prior-only entities
   older than `2 × expiryStaleAfterMsgs` (§10 unbounded-growth mitigation).
3. ✅ **Done (2026-07-03).** `groundingGate()` in `provenance.js`, default
   `groundingMode: 'soft'` (strip offending bullet line + `console.warn`).
   Gated behind `groundingEnabled` (off by default). Wired into **both** the
   full-refresh pipeline and per-section regen (`sections.js`), since
   grounding — unlike expiry — is relevant to a single section too.
   Grounded-name check is word-level (skips short words/titles like "Dr.")
   against the scan window ∪ prior state ∪ `pinnedEntities`, so a partial
   later reference ("Aboud") still grounds an earlier full introduction
   ("Dr. Aboud"). Since **v2.4.1** (TODO §1 identity service) the union
   also includes the knowledge registry's user-approved alias list
   (`collectRegistryAliasGroups()`): an approved alias spelling grounds
   outright, and a canonical name grounds through an alias appearing in
   the evidence.
4. ✅ **Done (2026-07-03).** `expiryMode: 'quarantine'` (moves stale entries to
   a `## Archive (Stale)` section, excluded from prompt injection via
   `injection.js`'s `splitWorldState()`) and `'remove'` are implemented and
   exposed in settings alongside `'mark'` — nothing hides them from the UI,
   but they remain opt-in (`expiryMode` defaults to `'mark'`). Likewise
   `groundingMode: 'strict'` is implemented: on rejection it retries the
   generation once with the rejection reason as a reminder, then — rather
   than discarding an otherwise-valid refresh — falls back to a soft strip
   instead of failing the whole refresh. A manual "🧹 Purge Stale Entries"
   button (`purgeStaleEntries()`, always mode `'remove'`) is available
   independent of the configured `expiryMode`, per §8.

Each step is independently useful and individually revertible (flip
`expiryEnabled` / `groundingEnabled` back to `false`, or change `expiryMode`
back to `'mark'`, to fall back to a more conservative behavior at any time).

**Known gaps vs. the original design:**
- §5.1 step 2b (chat-side NER / Knowledge-module reuse for name extraction)
  is still not implemented — name extraction remains text-only (bolded
  tokens in the world-state document).
- §9's Chronicle time-based expiry for `## Pending` is not implemented.

---

## 12. Quick reference: which guard fixes which symptom

| Symptom | Prompt fix (done) | Code guard (future) |
|---|---|---|
| Speculation (Coombs) | Core rules anti-speculation + tightened Pending/Unresolved descriptions | (not needed — prompt is the right layer) |
| Zombie entry (Dr. Aboud) | "rolling snapshot / drop if stale" core rule | **`applyExpiry()`** (§5.2) |
| Phantom invention (Lorraine) | "traceable / never invent" core rule | **`groundingGate()`** (§5.3) |

The prompt fix is **layer 1** (handles most cases, ships immediately). The
code guards here are **layer 2** (a hard floor for the long tail).
