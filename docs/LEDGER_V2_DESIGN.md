# Ledger module design (v2)

**Status:** Draft for review — nothing built, not yet scheduled. Scope from Brasen's v2 call (2026-11-16): the §7.1 proposals from World State refresh, debts by counterparty, and the item change log, plus the additions from the planning session (proposal data model, debt-aware fold-forward, planner-only projection, pinned items).
**Written:** 2026-11-16.
**Decisions continue v1 numbering** (D13+). Phase numbering also continues (v1 shipped Phases 1–3; Phase 4 host QA pending — v2 starts at Phase 5).
**Companion to `LEDGER_V1_DESIGN.md`** — that doc stays authoritative for shipped v1 behavior (D1–D12). Its §7 sketches this release; where the two disagree, this doc wins.

## 1. Goal

v1 made the ledger trustworthy but kept the original disease: **the user still forgets to update it** (v1 §1). v2 closes that loop without giving up D1's human-in-the-loop — World State's refresh *reports* what it saw in prose, the Ledger turns each report into a **proposal**, and the user accepts or rejects with one click. Code still does the arithmetic; the model still never writes.

Alongside that, v2 adds the two audit surfaces v1 deferred as "money needs a history; items rarely do" (D6) — which stops being true the moment proposals start feeding the ledger — plus the seams those surfaces force open: the fold-forward rule (D9) would silently destroy an unpaid debt at the 200-entry cap, so the cap and the fold both change.

## 2. Decisions this design adopts

| # | Decision | Why |
|---|----------|-----|
| D13 | **Proposals ride the World State refresh as a trailing report block, stripped before document validation.** Both full and delta refreshes request it; it never enters the stored document, so the document contract ("use ONLY the exact section headers") is untouched and D12 holds. | No extra API call (§7.1's core promise). Cost is ~100–200 output tokens when money/items changed, none when they didn't. |
| D14 | **Report items are gated deterministically, in code, before they become proposals.** The evidence quote must appear in the frozen scan window (whitespace-normalized containment); a currency name must resolve to a ledger currency; a quantity decrease must match an existing item name (case-insensitive). Failures drop the item with a console line — no retry, no second call. | Same discipline as the grounding gate (`world_state/provenance.js`): check the model's claims against the exact evidence it was given (the frozen-evidence rule, `world_state/refresh.js`). A piggyback must never be able to spend more than the tokens it already spent. |
| D15 | **Proposals live inside `mwt_ledger` (schema version 2), not a separate store.** Migration 1→2 adds the new arrays and optional fields; the backup key (`backup/data.js`), registry entry and pause behavior are unchanged. | One backup, one validation path. Tombstones (D17) are small; a second store would double the registry/backup surface for state that is useless without the ledger it targets. |
| D16 | **Every proposal carries its source message's receipt identity plus a content digest.** Identity comes from `core/message_identity.js` (persistent `mwt_uuid`, survives edits — the §7.1 "stable per-message key" landmine is already cleared; Chronicle's breakage was index-based). Expiry: message gone → the proposal drops; digest mismatch (swipe or edit changed the message) → badge "source changed", the user decides. | The identity keys the message *slot*, not the swipe variant. A swipe to a variant where the payment never happened leaves the slot alive with different content — the digest catches exactly that, and human review covers the rest. |
| D17 | **Resolved proposals persist as dedupe tombstones.** A repeat whose dedupe key matches any pending/accepted/rejected proposal is dropped silently. Tombstones are capped (§3.4). | §7.1: "refresh windows can overlap, so the same payment could be reported twice." Deleting resolved proposals on decision would let the next overlapping window re-propose an accepted event. The cap only needs to exceed the overlap distance — bounded by `maxScanMessages` — so a few hundred tombstones is generous forever. |
| D18 | **Accept/reject stays the only write path** (D1 carries forward verbatim). Batch accept/reject for a refresh's harvest. Accepting appends the transaction / applies the item change with `source` set to the proposal id. | No auto-apply setting, not even "safe" ones. Overlapping windows and swipe churn make silent writes a double-counting machine; the one-click accept is the whole point. |
| D19 | **Debts are a view, not a record.** Transactions gain an optional free-text `counterparty`; the Debts view is the nonzero net per (counterparty, currency). Paying a debt off is just a payment with the counterparty set — the net walks to zero. | D3's logic: a stored debt total can drift from its history; a computed net can't. No new lifecycle (no "settled" flag to forget), and an overdrafted balance is representable today (v1 Q3: negatives allowed, badge red). |
| D20 | **Fold-forward is debt-aware, and the cap re-tunes.** Rows with a `counterparty` whose per-(counterparty, currency) net is nonzero are never folded into "Carried forward"; if the retained rows can't fit under the cap, the fold refuses (existing `RangeError` path) rather than hide a debt. The cap also rises 200 → 500 once proposals start appending entries (v1 §9 D9 anticipated re-tuning; Brasen: "can always increase it"). | D9's fold collapses the oldest prefix per currency — past 200 entries it would swallow an unpaid debt with no trace. Debt-awareness makes **any** cap safe; the raise just slows the fold down for logs filling at refresh cadence. |
| D21 | **The item change log is a capped, display-only ring (100 entries).** Auto-appended by user edits and accepted proposals; trim drops the oldest with an "older changes trimmed" marker. | Unlike transactions there is no arithmetic to preserve, so a plain trim is honest. Fed by proposals (D18), the log becomes the item-side answer to "where did my 200 gold go". |
| D22 | **Pinned items win the injection cap.** A per-item pin sorts to the front of the 15-row carried slice (`CARRIED_ITEM_LIMIT`, `ledger/injection.js`); the "…and N more" line is unchanged. | Today the cap slices list order — the grandfather's sword can lose its slot to the third waterskin. The user, not insertion order, should choose what survives the cap. |
| D23 | **Stored items reach the Story Planner, not the narrator.** A planner-only Ledger projection (full inventory including Stored, notes, per-currency net worth) enters the planner's author context with its own budget entry — the `knowledge/planner_context.js` pattern ("Safe, planner-only projection", budgets pinned in `story_planner/schema.js`). The narrator injection is unchanged. | This is §7.2's "show Stored items on demand", re-aimed. The narrator injection runs every turn behind a 15-item cap; planning runs once. A stash — exactly what Stored is for (D6) — fits the second budget, not the first. |
| D24 | **A narrator-side "storage visible" toggle stays deferred.** Moving an item Stored→Carried already works for one item; a scene-wide reveal would need auto-un-reveal (scene tracking) or an honest lie (items claimed in-hand that aren't). | Ranked last of the §7.2 candidates. Revisit only if planner projection (D23) leaves a felt gap — the shape then is a manual toggle plus a `where` field, phrased "owned but not on hand". The `where` field ships anyway (§3.1) because it costs nothing. |
| D25 | **Money locations (purses, banked gold) are explicitly out.** The money-side analog of Carried/Stored would complicate the balance model and the injection's "Never state a different amount" contract. | Coherent, and testers haven't asked. Revisit only on demand; if it ever lands, it is an optional transaction field shaped like `counterparty`, not a second ledger. |
| D26 | **The deferred slash commands ride along** (`/wt-ledger-add <amount> [currency] [note]`, `/wt-item <name> [qty]`) — v1 Phase 3's optional extra. | Cheap filler; the panel stays primary (D2). |

## 3. Proposal data model

### 3.1 Store shape, v1 → v2

```js
// chat_metadata.mwt_ledger — version 2
{
  version: 2,
  currencies: [ /* unchanged */ ],
  transactions: [
    // v1 fields unchanged; two optional fields added:
    { id: 't2', currency: 'c1', amount: -30, note: 'Paid the smith', date: '14 March 1203', kind: 'entry',
      counterparty: 'Aldric the smith',  // optional free text — powers the Debts view (D19)
      source: 'p7' },                    // optional — proposal id when an accept created this row (D18)
  ],
  items: [
    { id: 'i1', name: 'Grandfather\'s sword', qty: 1, note: 'Notched blade', carried: true,
      pinned: false,   // optional — wins the injection cap (D22)
      where: '' },     // optional short free text — storage location, meaningful when carried=false (D24)
  ],
  itemLog: [           // newest last, capped at 100 (D21)
    { id: 'l3', name: 'Rope (50 ft)', change: 'qty', detail: '2 → 1', source: 'p9', date: '14 March 1203' },
    // change ∈ added | removed | qty | note | carried | edited; source = 'user' or a proposal id
  ],
  proposals: [        // pending first; resolved entries persist as tombstones (D17)
    {
      id: 'p7',
      kind: 'money',                          // or 'item'
      money: { currency: 'c1', amount: -30 }, // signed minor units, resolved by code (§3.2)
      // item: { name: 'Grandfather\'s sword', qtyChange: -1, carried: true },
      counterparty: 'Aldric the smith',       // optional, model-suggested; feeds D19 on accept
      evidence: 'She counted out thirty gold coins and pressed them into his palm.',
      msg: { identity: 'uuid:…', digest: '…' },  // receipt identity + content digest (D16)
      seenAt: 214,                            // display-only message index at proposal time
      status: 'pending',                      // pending | accepted | rejected | stale
    },
  ],
}
```

- Migration 1→2 (`ledger/schema.js`, following the `migrations: { 0: … }` pattern): add `itemLog: []`, `proposals: []`; leave every existing row untouched. v1 validation already lets unknown fields survive, so hand-edited records with the new fields present migrate trivially.
- `item` proposal semantics: `qtyChange` is signed. Positive on an unknown name → an "add item" proposal (created Carried unless `carried: false`); negative must match an existing item (D14) and steps qty down; a proposal that would reach zero proposes a **confirmed removal**, not a silent row loss (D6's rule). `carried`, when present, is the suggested state *after* the event — the sword pulled from storage mid-scene.
- `itemLog.name` is a snapshot, not a reference: log entries outlive the item row they describe.
- Ids keep v1's hygiene: short, never reused (`data.js` ids rule; Knowledge's reused-uid history is the cautionary tale).

### 3.2 The report block (model → code)

The refresh prompt gains a **Ledger snapshot** section — carried and stored item names, per-currency balances, currency names with decimals — and asks for a fenced block *after* the document:

```
```mwt-ledger-report
{"kind":"money","currency":"gold","amount":"-30","counterparty":"Aldric","evidence":"She counted out thirty gold coins and pressed them into his palm"}
{"kind":"item","name":"Rope (50 ft)","qtyChange":"-1","evidence":"he cut a length from his rope"}
```
```

- Amounts arrive as **major-unit text** (`"-30"`, `"12.50"`); code resolves the currency name → id and parses with `parseAmount(amount, decimals)` (`ledger/data.js`). Unresolvable currency or unparseable amount → the item drops (D14).
- The block is stripped from the model output **before** `validateFullRefreshOutput` / `parseDeltaPatch` ever see it — the document contract is unaware it existed (D13). In delta mode the same block trails the patch ops.
- An empty block, a missing block, or garbage inside it is a non-event: the refresh outcome is unaffected.
- The snapshot is included only when the ledger is non-empty and its store is healthy; a paused or invalid ledger store means the block is neither requested nor parsed (its writes would be refused anyway).

### 3.3 From report line to proposal (code, deterministic)

1. **Evidence gate** (D14): the line's `evidence` must appear in the frozen scan window after whitespace normalization. Drop otherwise.
2. **Resolution**: currency name → id + minor units; item name → existing row (case-insensitive trim match) or new-item flag.
3. **Dedupe**: key = `msg.identity + kind + (currency id | normalized name) + (amount | qtyChange)`. Matches any existing proposal regardless of status → dropped silently (D17).
4. **Persist as `pending`** with identity + digest + `seenAt`.

### 3.4 Expiry and tombstones

- On chat change and on opening the Ledger tab, walk `proposals`: source message identity absent from the chat → remove (it can never be re-verified); digest mismatch → `status: 'stale'`, shown with a "source changed" badge and still decidable by hand (D16).
- Tombstones = accepted/rejected/stale rows. Cap at 300; over the cap, drop oldest **resolved** rows first. 300 exceeds any real overlap distance (`maxScanMessages`-bounded), so a dropped tombstone cannot realistically be re-proposed by a later overlapping window.

### 3.5 The overdraft tie-in

Accepting a money proposal that would push a currency's balance below zero is allowed (v1 Q3) but gets a warning, and when the report supplied a `counterparty`, one extra button: **"track as debt from ⟨counterparty⟩"** — the same transaction with the counterparty attached, so it shows in Debts (D19). The two features were chosen separately; this is the seam that makes them feel designed together.

## 4. Debts view

- A grouping inside Finances: nonzero nets per (counterparty, currency), sign convention stated in the UI — net < 0 means *the player owes* them, net > 0 means *they owe the player* (amounts are player-signed throughout, D3/D4).
- Settlement needs no ceremony: pay them back with the counterparty filled in and the net walks to zero; the row leaves the view when it hits exactly zero.
- Honest limit, stated here so nobody "fixes" it silently: counterparty matching is **exact free text**. "Aldric", "the smith" and "Aldric the smith" are three counterparties. A merge tool is a nicety for later, not v2.

## 5. Fold-forward and the cap (D20 in full)

`foldTransactions` (`ledger/data.js`) currently replaces the oldest prefix with one carried row per currency. v2 adds one exclusion: a row with `counterparty` set whose (counterparty, currency) net among the foldable prefix is nonzero is **retained in place**, after the carried aggregates. If retained rows + one carried row per currency can't fit under the cap, the fold throws (existing `RangeError` contract — refuse, keep everything, the save surfaces why) rather than fold away a payable or receivable.

- Zero-net counterparty rows fold like any other — a debt paid off is ordinary history.
- The cap rises to **500** (D20). With proposals appending at refresh cadence, 200 would fold away months of audit; 500 keeps the file tens of KB (v1 §5's save-cost bound is unchanged).
- The invariant is the exclusion, not the number: any future cap change inherits debt-safety for free.

## 6. Refresh piggyback mechanics (World State side)

- `world_state/prompts.js`: the full-refresh system prompt gains a short report contract paragraph; `buildUserMessage` gains the Ledger snapshot section (D13). `world_state/delta.js`: `buildDeltaUserMessage` gains the same request; the strip runs before `parseDeltaPatch`.
- `world_state/refresh.js`: after normalising output and before validation, extract-and-strip the block (both refresh paths); on success, hand the lines to `ledger/proposals.js` via a detached read + validated write — the same store discipline as every other Ledger write. A refused proposal write (paused store, stale panel) drops the harvest with a console line; it never blocks the refresh that carried it.
- No changes to the grounding gate, expiry, or the document validator — the block is gone before any of them run.
- Budget: one line in the refresh's input (snapshot) and ≤ ~200 output tokens when events exist. The injection budget entry (`core/budget.js`) is untouched — proposals add no narrator tokens.

## 7. Item change log

- Append points: user add/edit/delete/carry-toggle in the panel, accepted item proposals, and accepted money proposals that touch a named item's row (none today — money and items stay separate records).
- Per-item drill-down (a collapsible "history" row in Inventory) plus a flat "recent changes" strip; both read the same ring. Trim marker: "…older changes trimmed" (D21).
- `date` is prefilled from the story clock when readable (`core/calendar_state.js`), same as transactions — display-only, never parsed back (v1 §3).

## 8. Planner-only projection (D23)

- New `ledger/planner_context.js`, shaped like `knowledge/planner_context.js`: a pure build from a detached `getLedger()` read. Contents: per-currency net worth, carried list with quantities, stored list with `where`, notable notes — names and numbers only, no transaction history, no proposals.
- One budget entry in `story_planner/schema.js`'s `AUTHOR_CONTEXT_BUDGETS`, with a test pinning the two sides equal (the Knowledge precedent keeps its pin; the Ledger one gets the same).
- Gated on the planner's author-context opt-in — nothing new reaches users who never enabled planner context.

## 9. User surface changes

- **Proposal inbox** at the top of the Ledger tab: pending count badge on the 💰 floating button and the tab label; each row shows the proposal, its evidence quote (the one-glance verdict D14 makes trustworthy), the source message index, and stale badges ("source changed"). Accept / reject per row; "accept all" / "reject all" per harvest (D18).
- **Finances**: counterparty field on the add/edit row (autocomplete from existing counterparties later, free text now); the Debts grouping (§4); accepted-from-proposal rows carry a small source chip (`source`, D18).
- **Inventory**: pin star (D22), `where` field on stored rows, per-item history drill-down (§7).
- **Overdraft dialog** (§3.5).

## 10. Code layout

| File | Job |
|------|-----|
| `ledger/proposals.js` | New, pure: report-line parsing, evidence gate, resolution, dedupe keys, expiry walk, apply-on-accept. No host imports. |
| `ledger/planner_context.js` | New, pure: the D23 projection. |
| `ledger/data.js` | v2 fields, debt-aware fold (§5), item-log ring, pin-aware injection ordering helper. |
| `ledger/schema.js` | `currentVersion: 2`, `migrations: { 0: …, 1: migrateLedgerV1ToV2 }`. |
| `ledger/store.js` | Save paths append item-log rows; proposal writes; unchanged backup key (D15 payoff). |
| `ledger/render.js` | Inbox, Debts grouping, pins, `where`, drill-down, overdraft dialog. |
| `world_state/prompts.js`, `delta.js`, `refresh.js` | Snapshot section, report request, strip-and-handoff (§6). |
| `story_planner/schema.js` | One budget entry (§8). |

Shared files otherwise untouched: `core/budget.js`, `backup/data.js`, `schema/registry.js`, `dashboard/` (Overview row gains nothing — the badge already says the number). Rough size: two new files plus moderate edits; the pure core carries the risk, the World State side is deliberately thin (strip + handoff).

## 11. Delivery plan

- **Phase 5 (pure core):** `data.js` v2 + debt-aware fold + item-log ring + `proposals.js` parse/dedupe/apply + migration 1→2. Tests: fold never hides a nonzero counterparty net at any cap; dedupe across statuses; evidence-gate drops; migration round trip; pin ordering.
- **Phase 6 (piggyback):** snapshot + report request + strip in both refresh paths; tombstone expiry. Tests: block never reaches the validators; a refused proposal write can't fail the refresh; delta output with a trailing block parses.
- **Phase 7 (surface):** inbox, Debts, pins, `where`, drill-down, overdraft dialog.
- **Phase 8 (planner + commands):** `planner_context.js`, budget entry + pin, slash commands.
- **Phase 9 (host QA):** a branch inherits proposals and tombstones; swipe-after-propose shows the stale badge; backup round trip carries v2 fields; delta-mode users get proposals.

## 12. Open questions

1. **Debts in the injection?** Should the narrator see "owes Aldric 50 gold" when nonzero counterparty nets exist (one capped line), or is the Debts view user-only? Lean: include — the narrator otherwise invents debt status mid-scene, which is the exact failure v1 §1 describes — but it spends narrator tokens every turn, so it needs the co-author's call.
2. **Tombstone cap (300) and log cap (100):** numbers plucked from the maxScanMessages overlap bound and "a screenful of audit" respectively. Both trivially tunable at the constants.
3. **Counterparty as free text vs Knowledge registry:** suggesting counterparties from Knowledge's NPC registry would be nicer than typing, but it crosses the module boundary D-era v1 drew ("the Ledger imports only `core/`"). Lean: free text in v2, registry autocomplete as a later opt-in seam.
4. **Per-item reveal anyway?** D24 defers the narrator-side storage toggle. If planner projection leaves the gap felt, the shape is settled (manual toggle + `where`, phrased "owned but not on hand") — confirm deferral is acceptable.
5. **`seenAt` display:** message indexes shift under deletion/ILS condensing. It is display-only (identity + digest do the work); worst case the index is briefly wrong next to a quote that is still verbatim. Acceptable, or hide the index and show only the quote?
