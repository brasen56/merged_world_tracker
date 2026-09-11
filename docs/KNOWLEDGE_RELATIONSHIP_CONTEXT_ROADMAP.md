# Knowledge relationship context — deferred roadmap

**Status:** DEFERRED. Not scheduled. Pick this up only if a trigger below fires.
**Date:** 2026-09-08
**Supersedes:** the implementation half of `KNOWLEDGE_RELATIONSHIP_CONTEXT_PROPOSAL.md`
(that document stays as the design record; where the two disagree, this one is current)
**Area:** Knowledge Tracker / relationship storage and prompt injection

---

## 1. Why this is deferred

The proposal's four phases were justified by one measurement: a minor NPC whose
managed relationship block cost over 900 tokens. Phase 0 — compaction of the
existing block, no new machinery — removed most of that cost on its own:

| case | before | after | saved |
| --- | --- | --- | --- |
| the reported minor NPC (3 edges) | ~76 tok | ~22 tok | 71% |
| a 40-edge major NPC | ~1545 tok | ~68 tok | 96% |

Shipped in `09219ea` on `testing`, then validated in live sessions by the
author plus two testers. No further relationship-cost complaints followed.

The remaining phases buy **relevance** (only the current scene's subgraph
reaches the prompt) on top of the **bound** that already exists. That is a real
improvement, but it costs a new Knowledge-owned injection path, a budget-spec
change, cast-detection sharing, a settings surface, and a migration — and no
observed problem currently needs it.

---

## 2. What already shipped (the starting point for any future work)

In `knowledge/relationships.js`:

- **`formatRelationshipBlock()`** (line ~667) renders a bounded projection, not
  a copy of the graph.
- **`selectRelationshipEdges(edges, { maxEdges, maxChars })`** (line ~597) —
  pure. Dedupes targets case-insensitively, then ranks: manual before auto
  (via `isEdgeAutoManaged`, whose fail-safe direction treats a missing `source`
  as manual), then structural salience (`TYPE_PRIORITY`), then target name,
  then original position. Applies the character budget by dropping whole edges
  from the tail and re-rendering — never by truncating a name. Keeps a single
  oversized edge rather than rendering nothing. Returns `{ selected, omitted }`;
  `omitted` is currently unused by callers and exists for a future diagnostics
  surface.
- **`renderRelationshipEdges(edges)`** (line ~652) — pure. Collapses same-type
  targets into one clause, sorts targets alphabetically inside a clause, emits
  no trailing period.
- **`RELATIONSHIP_BLOCK_MAX_EDGES = 12`**, **`RELATIONSHIP_BLOCK_MAX_CHARS = 400`**.
- Notes are excluded from prompt text entirely. They remain in the store, the
  relationship editor, and the graph view.

In `interiority/generation.js`:

- **`_formatRelationshipsForRoster()`** (line ~576) also stopped rendering
  notes. It already was the roster-filtered, sealed-minds-correct projection
  the proposal described — for the interiority sub-call, not the narrator
  prompt.

Tests: `test/relationships.test.js`, describes `notes are evidence, not prompt
text`, `selectRelationshipEdges`, `rendering is deterministic`, `a dense graph
stays bounded`. The reported real-world block is pinned verbatim.

**The two pure functions are the seam.** Any future contextual-injection work
should call them with a scene-filtered edge list rather than writing a second
opinion about which relationships matter.

---

## 3. Triggers — when to actually build this

Pick this up if one of these is observed, not on general principle:

1. **A capped block reads wrong in play.** An NPC's 12 most salient edges are
   the wrong 12 for the scene at hand, repeatedly, and the narrator acts on
   stale connections. This is the trigger the contextual work is actually for.
2. **Relationship prose is measurably crowding the context** again — e.g. a
   long campaign where dozens of NPC entries activate per turn and 12 edges
   each still adds up.
3. **`omitted` is routinely large** across the cast (say most NPCs dropping
   half their graph), meaning the cap is doing heavy lifting and relevance
   would beat salience-ranking.
4. **Users ask for off-screen relationships to matter** — the pin feature (§4.4)
   is the cheap answer and may be worth building alone, without the injection.

If none of these fire, the compaction is the whole fix and this document stays
closed.

---

## 4. Remaining work, in dependency order

### 4.1 Prerequisite — shared scene-cast module

**Not in the original proposal, and it is the single biggest de-risking item.**

The proposal listed "active-cast detection" as a risk of Option A: aliases,
group-chat speakers, single-character chats, name omission, swipes. That
detection already exists and is battle-tested — `buildSceneRoster()` in
`interiority/generation.js:167`, with `resolveUserNames()` / `isUserName()`
handling the player-character exclusion (including the `name1` short-form trap
that has bitten this codebase before — see the PC-identity notes).

Lift it into a module both Knowledge and Interiority import (e.g.
`core/scene_cast.js`), rather than reimplementing it in Knowledge. Two
divergent answers to "who is in this scene" is the failure mode to avoid, and
Knowledge must not be gated on the interiority module being enabled.

Deliverable: the roster builder moves, `interiority/generation.js` imports it,
existing interiority tests stay green unchanged.

### 4.2 Knowledge needs a budget key

`core/budget.js:74` declares Knowledge as:

```js
{ id: 'knowledge', label: '🧠 Knowledge', key: null, mechanism: 'lorebook', defaultPriority: 4, advisory: true }
```

Knowledge has **no `setExtensionPrompt` key today** — its cost is advisory only,
because it reaches the prompt through SillyTavern's lorebook system. A
contextual relationship injection would be Knowledge's first real injection.

That means:

- a new entry in `BUDGET_MODULE_SPECS` (either flipping the knowledge spec or
  adding a separate `knowledge_relationships` spec — a separate spec is
  cleaner, since the dossier entries stay advisory/lorebook),
- a matching entry in `DEFAULT_BUDGET_SETTINGS.modules`,
- `normalizeBudgetSettings()` tolerating chats saved before the key existed,
- diagnostics + redaction + panic-switch wiring through
  `applyExtensionPromptInjection` in `core/injection.js`, which is the one seam
  every injection funnels through.

The proposal's Phase 2 treated this as free wiring. It is small, but it is
schema surface with a backward-compatibility requirement.

### 4.3 The injection itself

Build the payload with the §2 pure functions against a cast-filtered edge list:

- select edges whose **subject and target are both in the active cast**, plus
  any pinned edges,
- register one bounded block through `applyExtensionPromptInjection`,
- clear it when the mode is off, the graph is empty, scope changes, or
  generation is cancelled,
- fail open: a failure to build or register omits relationship context and
  never touches the stored graph.

Shape:

```text
<mwt_relationship_context>
- Pete → Derek Sandhorn: employee
- Derek Sandhorn → Pete: employer
</mwt_relationship_context>
```

Note this is the *global scene subgraph* — different from interiority's
per-NPC, sealed-minds blocks, which must stay per-NPC. Both can exist; they
serve different consumers (narrator prompt vs. interiority sub-call).

### 4.4 Settings — one toggle, not five modes

The proposal offered five modes (Contextual / Pinned only / Stance only /
Full-legacy / None). **Reject that.** Five modes is five combinations of stale
prompt surface that must clear one another, to serve a preference almost nobody
exercises — and the proposal's own acceptance criteria then have to guarantee
"duplicate context is impossible" across all of them.

Ship instead:

- one setting to enable contextual injection (default off until proven),
- when it is on, NPC entries keep only the stance line,
- the escape hatch, if anyone asks for it, is a single boolean: "include
  relationship notes in lorebook entries" (default off).

Migration is then just: change what `formatRelationshipBlock` emits and call
`syncAllRelationshipsToLorebooks()`. The managed block is delimited by stable
HTML comments and `stripRelationshipBlock`/`injectRelationshipBlock` are
idempotent, so **re-syncing is the migration** — no bespoke migration machinery,
no counts-and-preview flow unless a user asks for one.

### 4.5 Prompt pins

Per-edge `promptPinned: true`, honoured as rank 0 in `selectRelationshipEdges`.
Useful on its own even without contextual injection: it is the answer to "this
off-screen relationship must always be visible."

A separate short prompt-note field stays deferred. Notes are evidence; if a
user wants prose in the prompt, pinning plus a shorter note is the workaround
until a real need appears.

### 4.6 Relationship lifecycle metadata — still separate, still later

Unchanged from the proposal §9. `status: active | historical`,
`firstSeenTurn`, `lastConfirmedTurn`, `confirmationCount`, with the rules:

- absence from recent messages is **not** evidence of removal,
- only explicit contradictory evidence marks an auto edge historical,
- manual edges are never aged automatically,
- historical edges stay inspectable but leave normal prompt ranking,
- aging lowers priority; it never deletes.

Keep this decoupled. It is a semantics problem ("when is a relationship over?")
and coupling it to a cost fix means neither ships. It is also the only thing
that would actually shrink `[MWT:store]`.

---

## 5. Facts worth not re-deriving

- **The `[MWT:store]` entry costs zero prompt tokens**, whatever ST's counter
  says. `applyStoreToWorldInfo()` in `knowledge/store.js` writes it with
  `key: []`, `disable: true`, `enabled: false`, `constant: false`,
  `vectorized: false`, and **re-asserts all of those on every save** so a user
  edit or an import cannot turn it into an injecting entry. A ~19k-token store
  is a signal about graph size (notes at up to 280 chars/edge, plus two entity
  ids per edge), not a prompt cost. Do not "optimise" it; §4.6 is the only
  thing that legitimately shrinks it.
- **Note churn is a prompt-cache problem, not only a size one.** Auto-extract
  runs on a cadence (`relationshipAutoExtractEveryN`, default 10) and treats a
  rephrased note as an update (`knowledge/relationships.js:949` area). Before
  compaction, every cadence tick could rewrite a lorebook entry sitting high in
  the prompt and invalidate cache from that point down. This is why the
  rendered output must be deterministic, and why
  `syncRelationshipsToLorebook`'s unchanged-check matters.
- **`Stance toward {{user}}:` is byte-for-byte load-bearing.** Presets gate NPC
  yielding on that exact prefix. It stays static in the NPC entry under every
  option considered here.
- **Sealed minds is structural, not stylistic.** An NPC's block gets only that
  NPC's outbound edges. Any shared renderer must not quietly widen this.
- **Option B (one World Info entry per NPC pair) was rejected** and should stay
  rejected: it is O(n²) entries, needs a pair registry with create/update/
  delete/rename/merge/restore/UID-collision handling, and depends on selective
  matching behaviour that varies with aliases, recursion, scan depth, and fork
  configuration.
- **Existing bloated blocks only shrink after "💾 Sync to Lorebooks"** in the
  Relationships tab. Auto-extract re-syncs only the NPCs it touched.

---

## 6. Acceptance criteria carried forward

If §4.3 is ever built:

- the injection never exceeds its configured hard budget,
- only active-cast edges appear unless pinned,
- ordinary edge notes are never injected,
- the graph, notes, source locks, and stable ids survive unchanged,
- `Stance toward {{user}}:` stays byte-for-byte compatible,
- enabling contextual injection clears the NPC-entry relationship lines, so the
  same edges can never appear twice in one prompt,
- rename, merge, delete, backup/restore, chat switch, group chat, swipe, and
  cancellation tests stay green,
- diagnostics can show the exact payload and its estimated token cost,
- a failure to build or register leaves the graph untouched and does not block
  generation.

---

## 7. Open questions, if resumed

1. Separate budget spec (`knowledge_relationships`) or flip the existing
   knowledge spec off advisory? Separate is the current leaning — dossier
   entries genuinely are lorebook-mechanism and should stay advisory.
2. Does the scene subgraph want both directions of a pair, or is one line per
   pair enough for the narrator?
3. Should `omitted` surface anywhere in the UI (a "3 more not shown" hint in
   the Relationships tab), or stay internal?
