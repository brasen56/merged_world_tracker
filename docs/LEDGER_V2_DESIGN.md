# Ledger module design (v2)

**Status:** Revision 2 design; Phases 5–8 implemented (pure core, piggyback integration, review surface, planner context and commands). Phase 6's GLM/local-model measurement review passed (see §11); Phase 9 host QA remains pending. `ledgerProposals` remains off by default. Scope from Brasen's v2 call (2026-11-16): the §7.1 proposals from World State refresh, debts by counterparty, and the item change log, plus the additions from the planning session (proposal data model, debt-aware fold-forward, planner-only projection, pinned items).
**Written:** 2026-11-16. **Revised:** 2026-11-18 (rev 2, code-checked review; what changed and why is in §13).
**Decisions continue v1 numbering** (D13+). Phase numbering also continues (v1 shipped Phases 1–3; Phase 4 host QA pending — v2 starts at Phase 5).
**Companion to `LEDGER_V1_DESIGN.md`** — that doc stays authoritative for shipped v1 behavior (D1–D12). Its §7 sketches this release; where the two disagree, this doc wins.

## 1. Goal

v1 made the ledger trustworthy but kept the original disease: **the user still forgets to update it** (v1 §1). v2 closes that loop without giving up D1's human-in-the-loop — World State's refresh *reports* what it saw in prose, the Ledger turns each report into a **proposal**, and the user accepts or rejects with one click. Code still does the arithmetic; the model still never writes.

Alongside that, v2 adds the two audit surfaces v1 deferred as "money needs a history; items rarely do" (D6) — which stops being true the moment proposals start feeding the ledger — plus the seams those surfaces force open: the fold-forward rule (D9) would silently destroy an unpaid debt at the 200-entry cap, so the cap and the fold both change.

## 2. Decisions this design adopts

| # | Decision | Why |
|---|----------|-----|
| D13 | **Proposals ride the World State refresh as a trailing report block, cut from the *raw* model output before `normaliseOutput` runs** (rev 2). Both full and delta refreshes request it; it never enters the stored document, so the document contract ("use ONLY the exact section headers") is untouched and D12 holds. Only the block from the attempt that **commits** is harvested; a refresh that fails harvests nothing. | No extra API call (§7.1's core promise). The cut must precede `normaliseOutput` (`core/api.js`): when text surrounds a fence, it keeps only the first fenced block's contents, so "document + fenced report" would become the report alone (§6.1). |
| D14 | **Report items are gated deterministically, in code, before they become proposals.** The evidence quote must match one message inside the frozen scan window's message range, via `core/quote_match.js` (rev 2); a currency name must resolve to **exactly one** ledger currency (case-insensitive; duplicate names → ambiguous → drop); a quantity decrease must match an existing item name (case-insensitive). Failures drop the item with a console line and a Diagnostics counter — no retry, no second call. | Same discipline as the grounding gate (`world_state/provenance.js`): check the model's claims against the exact evidence it was given (the frozen-evidence rule, `world_state/refresh.js`). `quote_match.js` is already the shared "quoted words appear in one chat message" boundary for Knowledge and Story Planner, and it already refuses ILS summaries. Duplicate currency names are still allowed in v1 (the personal/business tester case), so name resolution must refuse ambiguity rather than guess. |
| D15 | **Proposals live inside `mwt_ledger` (schema version 2), not a separate store.** Migration 1→2 adds the new arrays and optional fields; the backup key (`backup/data.js`), registry entry and pause behavior are unchanged. **A malformed proposal or item-log row can never make the ledger invalid** (rev 2): those rows are validated separately and skipped, never failing `validateLedgerRecord` (§3.6). | One backup, one validation path for money. `validateLedgerRecord` failing turns the money injection off ("kept but inactive until fixed"); an audit row must not be able to do that. |
| D16 | **Every proposal carries its source message's receipt identity plus a content digest of that message's raw `mes`.** Identity comes from `core/message_identity.js` (persistent `mwt_uuid`, survives edits — the §7.1 "stable per-message key" landmine is already cleared; Chronicle's breakage was index-based). **Staleness is computed when the inbox renders, not stored** (rev 2): message gone → the proposal drops; digest mismatch (swipe or edit) → "source changed" badge, the user decides; swiping back to the original clears the badge. The message index shown in the inbox is looked up from the identity at render time, so it is never wrong. | The identity keys the message *slot*, not the swipe variant. A swipe to a variant where the payment never happened leaves the slot alive with different content — the digest catches exactly that. A stored `stale` status would stay stuck after a swipe back. |
| D17 | **Resolved proposals persist as dedupe tombstones.** A repeat whose dedupe key matches any pending/accepted/rejected proposal is dropped silently. Tombstones are capped (§3.4). | §7.1: "refresh windows can overlap, so the same payment could be reported twice." Deleting resolved proposals on decision would let the next overlapping window re-propose an accepted event. |
| D18 | **Accept/reject stays the only write path** (D1 carries forward verbatim). Batch accept/reject for a refresh's harvest. Accepting appends the transaction / applies the item change with `source` set to the proposal id. | No auto-apply setting, not even "safe" ones. Overlapping windows and swipe churn make silent writes a double-counting machine; the one-click accept is the whole point. |
| D19 | **Debts are a view over loan rows, not a record** (rev 2). Transactions gain an optional free-text `counterparty` and an optional `loan: true` flag (a loan row requires a counterparty). The Debts view is the nonzero net of **loan rows only** per (counterparty, currency). Sign: amounts stay player-signed (D3/D4), so **net > 0 means the player owes them** (they handed over money: borrowed) and **net < 0 means they owe the player** (lent out). Repaying is a loan row with the opposite sign; the net walks to zero. A plain purchase with a counterparty is ordinary history and never appears in Debts. | D3's logic: a stored debt total can drift from its history; a computed net can't. Rev 1 summed *all* counterparty cash flow, which only equals a debt for loans, and read the sign backwards even then: borrowing +50 showed "they owe the player", and "Paid the smith −30" showed "player owes the smith 30" after paying. |
| D20 | **Fold-forward is debt-aware, and the cap re-tunes** (rev 2). The fold aggregates the oldest prefix per currency as today, except that loan rows aggregate per **(currency, counterparty)**: when that prefix net is nonzero, it becomes its own carried row (`kind: 'carried'`, `loan: true`, the counterparty kept); when it is zero, the rows fold into the plain currency carry. The cap rises 200 → 500. | Aggregating instead of retaining keeps every debt net exact and makes the fold fail only when currencies + open-debt counterparties exceed the cap — not in any real chat. Rev 1's "retain rows, refuse the fold when they don't fit" turned the `RangeError` (today an impossible-cap guard) into a reachable lock where no further save succeeds. |
| D21 | **The item change log is a capped, display-only ring (100 entries).** Auto-appended by user edits and accepted proposals; trim drops the oldest with an "older changes trimmed" marker. | Unlike transactions there is no arithmetic to preserve, so a plain trim is honest. Fed by proposals (D18), the log becomes the item-side answer to "where did my 200 gold go". |
| D22 | **Pinned items win the injection cap.** A per-item pin sorts to the front of the 15-row carried slice (`CARRIED_ITEM_LIMIT`, `ledger/injection.js`); the "…and N more" line is unchanged. | Today the cap slices list order — the grandfather's sword can lose its slot to the third waterskin. The user, not insertion order, should choose what survives the cap. |
| D23 | **Stored items reach the Story Planner, not the narrator** (rev 2: seam corrected). A planner-only Ledger block (full inventory including Stored, `where`, per-currency balances, open debts) is built by a `core/` reader and prepended to the planner prompt as application-owned context — the `buildCalendarPlannerContext` / `buildAmbientPlannerContext` pattern (`story_planner/generation.js`), with its own character cap constant. It is **not** part of author context. The narrator injection is unchanged. | This is §7.2's "show Stored items on demand", re-aimed. `AUTHOR_CONTEXT_BUDGETS` is the Standard/Expanded/Large dropdown for *private NPC* context, which only runs on reviewed scoped requests behind a privacy warning; an entry there would add a fourth dropdown option, and gating on that opt-in would mean the stash almost never reaches the planner. Inventory isn't private. |
| D24 | **A narrator-side "storage visible" toggle stays deferred.** Moving an item Stored→Carried already works for one item; a scene-wide reveal would need auto-un-reveal (scene tracking) or an honest lie (items claimed in-hand that aren't). | Ranked last of the §7.2 candidates. Revisit only if planner projection (D23) leaves a felt gap — the shape then is a manual toggle plus a `where` field, phrased "owned but not on hand". The `where` field ships anyway (§3.1) because it costs nothing. |
| D25 | **Money locations (purses, banked gold) are explicitly out.** The money-side analog of Carried/Stored would complicate the balance model and the injection's "Never state a different amount" contract. | Coherent, and testers haven't asked. Revisit only on demand; if it ever lands, it is an optional transaction field shaped like `counterparty`, not a second ledger. |
| D26 | **The deferred slash commands ride along** (`/wt-ledger-add <amount> [currency] [note]`, `/wt-item <name> [qty]`) — v1 Phase 3's optional extra. | Cheap filler; the panel stays primary (D2). |
| D27 | **No cross-module imports** (rev 2, new). The report parser, evidence gate, resolution and dedupe key live in a pure `core/ledger_report.js`. World State calls it, then hands the gated lines to the Ledger through a `mwt:ledger-report` document event carrying the chat id; the Ledger listener re-checks that the chat is still current and does the write. | `world_state/` imports from no other feature module today, and v1 drew the same line for Ledger ("imports only `core/`"). `quote_match.js` already sets the precedent: shared trust boundaries live in `core/`. |
| D28 | **The snapshot and report request are gated on: `enableLedger` on, the new `ledgerProposals` setting on, the ledger non-empty, its store healthy and not paused** (rev 2, new). Any gate closed → the request is left out of the prompt and any block that arrives anyway is cut and ignored. | Enable flags have not gated cross-module reads in the past (the onboarding review found exactly this). A disabled Ledger must cost zero prompt tokens. |
| D29 | **Measure before building the inbox** (rev 2, new). `ledgerProposals` ships **off by default** in Phase 6, with Diagnostics counters (§6.4). The counters measure (a) whether the report is accurate enough to be worth reviewing and (b) whether World State document validation fails more often with the request in the prompt, checked on GLM and at least one local model. **The default stays off regardless (Q6, resolved 2026-11-18); the counters only inform whether a later release flips it.** | Asking a small model for a second output format after the document is the most likely real-world regression, and it's cheap to measure before Phase 7's UI exists. Local models already needed their own hardening pass for Chronicle. |
| D30 | **Open debts reach the narrator injection** (Q1 resolved). One line after the money line, only when nonzero loan nets exist, capped at three counterparties plus "and N more": `Debts: owes Aldric 50 gold; owed 20 silver by the guild.` Same honesty rule as D11 — listed loans are definite, unlisted ones may exist (the user won't loan-flag every tab). | The narrator otherwise invents debt status mid-scene — the exact failure v1 §1 describes. A few narrator tokens only while debts exist, and safe only since D19's loan-only nets (rev 1's all-counterparty net would have told the narrator the player owes every shopkeeper they've paid). |

## 3. Proposal data model

### 3.1 Store shape, v1 → v2

```js
// chat_metadata.mwt_ledger — version 2
{
  version: 2,
  currencies: [ /* unchanged */ ],
  transactions: [
    // v1 fields unchanged; three optional fields added:
    { id: 't2', currency: 'c1', amount: -30, note: 'Paid the smith', date: '14 March 1203', kind: 'entry',
      counterparty: 'Aldric the smith',  // optional free text — who it was with
      source: 'p7' },                    // optional — proposal id when an accept created this row (D18)
    { id: 't3', currency: 'c1', amount: 50, note: 'Borrowed from Aldric', date: '15 March 1203', kind: 'entry',
      counterparty: 'Aldric the smith',
      loan: true },                      // optional — counts toward Debts (D19); requires counterparty
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
      money: { currency: 'c1', amount: -30, loan: false }, // signed minor units, resolved by code (§3.2)
      // item: { name: 'Grandfather\'s sword', qtyChange: -1, carried: true },
      counterparty: 'Aldric the smith',       // optional, model-suggested
      evidence: 'She counted out thirty gold coins and pressed them into his palm.',
      msg: { identity: 'uuid:…', digest: '…' },  // receipt identity + digest of raw mes (D16)
      status: 'pending',                      // pending | accepted | rejected  (staleness is computed, D16)
    },
  ],
}
```

- Migration 1→2 (`ledger/schema.js`, following the `migrations: { 0: … }` pattern): add `itemLog: []`, `proposals: []`; leave every existing row untouched. v1 validation already lets unknown fields survive, so hand-edited records with the new fields present migrate trivially. `validateLedgerRecord` currently requires `version === 1`; it moves to 2.
- New transaction-field rules in `validateLedgerRecord`: `counterparty`, when present, is a string; `loan`, when present, is boolean, and `loan: true` requires non-empty `counterparty`. These are money rows, so they are validated strictly like the rest.
- `item` proposal semantics: `qtyChange` is signed. Positive on an unknown name → an "add item" proposal (created Carried unless `carried: false`); negative must match an existing item (D14) and steps qty down; a proposal that would reach zero proposes a **confirmed removal**, not a silent row loss (D6's rule). `carried`, when present, is the suggested state *after* the event — the sword pulled from storage mid-scene.
- `itemLog.name` is a snapshot, not a reference: log entries outlive the item row they describe.
- Ids keep v1's hygiene: short, never reused (`data.js` ids rule; Knowledge's reused-uid history is the cautionary tale). Proposal and log ids are unique within their own arrays; they don't join the currency/transaction/item id set. A `source` pointing at a trimmed tombstone renders as a plain "from refresh" chip.
- `seenAt` (rev 1) is dropped: the inbox looks up the live index from the identity (D16).

### 3.2 The report block (model → code)

The refresh prompt gains a **Ledger snapshot** section — carried and stored item names, per-currency balances, currency names with decimals — and asks for a fenced block *after* the document:


```mwt-ledger-report
{"kind":"money","currency":"gold","amount":"-30","counterparty":"Aldric","evidence":"She counted out thirty gold coins and pressed them into his palm"}
{"kind":"money","currency":"gold","amount":"50","counterparty":"Aldric","loan":true,"evidence":"Aldric pressed fifty gold into her hand. Pay me back by midsummer"}
{"kind":"item","name":"Rope (50 ft)","qtyChange":"-1","evidence":"he cut a length from his rope"}
```


- **Scope of the report:** only money and items of the player character (`{{user}}` / `name1`), never NPCs paying each other. `loan: true` only when the text makes it a borrowing, a lending or a repayment; a purchase is never a loan. The prompt says both explicitly, plus (added after the first tester run) the sign contract: one line per event, never both sides of a transfer or an expected future repayment as a second line; signs are player-perspective (handed over negative, received positive); lending is one negative line with `loan: true`, borrowing one positive line.
- Amounts arrive as **major-unit text** (`"-30"`, `"12.50"`); code resolves the currency name → id and parses with `parseAmount(amount, decimals)` (`ledger/data.js`). Unresolvable or ambiguous currency, or unparseable amount → the item drops (D14).
- The snapshot is capped (a constant, e.g. 40 item names with a "…and N more" tail) so a large inventory can't grow every refresh prompt. Names are listed exactly so the model can copy them.
- The block is cut from the model output **before** `normaliseOutput` (§6.1) — the document contract is unaware it existed (D13). In delta mode the same block trails the patch ops.
- An empty block, a missing block, or garbage inside it is a non-event: the refresh outcome is unaffected.
- When any D28 gate is closed, the block is neither requested nor harvested.

### 3.3 From report line to proposal (code, deterministic)

1. **Evidence gate** (D14): the line's `evidence` must match one message in the frozen window's message records (§6.2) via `findQuoteMatch` / `quoteMatchesMessage` (`core/quote_match.js`), checked against the live chat restricted to the window's index range. A message that changed during the API call no longer matches and the line drops. When a quote matches more than one message (a later recap of the payment), the earliest match wins. The matched message supplies `msg.identity` and `msg.digest`.
2. **Resolution**: currency name → exactly one id + minor units; item name → existing row (case-insensitive trim match) or new-item flag. Resolution runs against the ledger as it is at write time (a detached read in the Ledger listener), not the snapshot the prompt saw — the user may have edited mid-call.
3. **Dedupe**: key = `msg.identity + kind + (currency id | normalized name) + (amount | qtyChange)`. Matches any existing proposal regardless of status → dropped silently (D17). Known limit: two identical payments in the *same* message (twice 30 gold) collapse into one proposal; the user adds the second by hand. **Sign-pair contradiction** (added after the first tester run, where one "hand Ezra $650" became both −650 and +650): money lines for the same source message, currency and |amount| with opposite signs quoting the *same* evidence are one double-reported transfer — code cannot pick a side, so both drop with a `contradictory` counter (D14's no-guessing rule). Two real opposite events in one message quote different evidence and survive. A sign-flipped re-report whose evidence matches a stored proposal (any status) drops the newcomer only; the stored row was already reviewable.
4. **Context excerpt** (Phase 9 QA, 2026-11-21): code copies the sentences around the quote, verbatim, from the frozen record text it matched (`excerptAroundQuote`, `core/quote_match.js`). It starts with the sentences containing the quote and widens by whole neighbouring sentences, earlier first, up to 300 characters, skipping non-narrative blocks. It is stored as `context` only when it adds something to the quote. No report field asks the model for it, so small models cannot invent it. Known limit: when the thing paid for is named in a *different* message, the excerpt won't contain it; the source chip's message number (§3.7) covers that while the message exists.
5. **Persist as `pending`** with identity + digest (+ `context`).

### 3.4 Expiry and tombstones

- On chat change and on opening the Ledger tab, once history is hydrated, walk `proposals`: source message identity absent from the chat → remove pending and rejected rows. Retain accepted rows for the missing-source warning in §3.7, subject to the resolved-row cap below. This audit rule takes precedence over missing-source expiry. Digest mismatch is not stored; the inbox computes it (D16).
- The same pass stamps `condensed: true` on an accepted row whose source is found inside an ILS summary's originals (accepted rows only; validated). ILS flatten deletes those originals, and without the stamp a flattened source would read as deleted. ILS refreshes the chat after condensing, which runs this pass, so the stamp lands before any realistic flatten. Remaining gap: condensing and then flattening with no chat refresh, deletion or Ledger tab visit in between. Those rows show the "deleted" warning instead.
- Tombstones = accepted/rejected rows. Cap at 300; over the cap, drop oldest resolved rows first. In full-refresh mode windows overlap by `maxScanMessages` minus the refresh cadence; delta mode scans only since the watermark, so it barely overlaps at all. 300 resolved proposals is far past either.

### 3.5 The overdraft tie-in

Accepting a money proposal that would push a currency's balance below zero is allowed (v1 Q3) but gets a warning. When the proposal has a `counterparty`, one extra button: **"accept, and record the shortfall as owed to ⟨counterparty⟩"** (rev 2). It writes the proposed transaction plus a loan row (`loan: true`, same counterparty, amount = the shortfall, positive). The shortfall is the smaller of this payment's magnitude and the resulting deficit: earlier overspending is never attributed to this counterparty. A previously nonnegative balance lands at zero; an existing negative balance stays unchanged. Debts shows the player owing only this payment's shortfall. (Rev 1 attached the counterparty to the negative transaction itself, which showed the full amount in Debts *and* a negative balance.)

### 3.6 Audit-row validation (rev 2)

- `validateLedgerRecord` checks only that `proposals` and `itemLog` are arrays when present. Their rows are checked by a separate `validateLedgerAudit`, whose issues are reported to Diagnostics at a non-blocking severity.
- Rows that fail are kept as stored (reads never repair, per `store.js`) but skipped by render, dedupe and expiry. The next proposal write leaves them in place; a Maintenance tool can clear them later if testers ever hit one.
- Currency precision edits rescale transactions and pending proposals exactly or refuse the edit. Resolved money proposals keep their original amount with an optional `money.decimals` snapshot (integer 0–15, resolved rows only); dedupe converts this historical value exactly to current precision. Unrepresentable historical values cannot collide with current reports and never block precision edits.

### 3.7 Accepted proposals whose source changed (rev 2)

The digest check also runs for **accepted** proposals. A transaction or item-log row with a `source` proposal gets a chip worded by what the lookup actually knows (`createLedgerSourceIndex`, `ledger/proposals.js`). The lookup runs once per render or expiry pass, and it never uses a saved index, so messages moving around can't make it stale:

| Source state | Chip | Warning |
|---|---|---|
| In the chat, same text | `from refresh · message #N` | no |
| In the chat, different text | `… · message #N · source changed after accept` | yes |
| Inside an ILS summary's originals (Ref or legacy embedded, nested) | `… · condensed into summary #M` (+ changed, if the original differs) | only if changed |
| Not found, stamped `condensed` (§3.4) | `… · condensed; original no longer stored` | no |
| Not found, never seen condensed | `… · source deleted after accept` | yes |

Nothing is undone automatically (D18); the user decides whether the payment still happened. This is the realistic swipe failure — accept −30, then swipe the message to a version where nobody paid. A deleted source still warns, because delete-and-regenerate is effectively a swipe. It's partly contained already: refresh scans stop at `getStableHistoryEnd`, which leaves out the newest, still-changing messages. The ILS originals are read through `core/ils_originals.js` (moved out of `knowledge/ils_compat.js`, which re-exports it), and only when a source is not in the chat. The read-only rule stands.

Accepting a money proposal writes its `context` excerpt (§3.3) as the transaction note, falling back to the quote. Resolved rows drop `context`, so only pending rows carry it. The transaction list clips long notes at a word boundary on the summary line, and the edit form shows them whole. Notes never enter any prompt.

## 4. Debts view

- A grouping inside Finances: nonzero nets of **loan rows** per (counterparty, currency) (D19). The UI states the sign in words: "You owe Aldric 50 gold" for net > 0, "Aldric owes you 20 gold" for net < 0.
- Settlement needs no ceremony: repay with a loan row for the same counterparty and the net walks to zero; the row leaves the view when it hits exactly zero.
- The add/edit row gets a "Loan or repayment" checkbox next to the counterparty field. (Remember ST's global `input[type=checkbox] { display: grid }`: the label needs inline-flex, as in v1.)
- Honest limit, stated here so nobody "fixes" it silently: counterparty matching is **exact free text**. "Aldric", "the smith" and "Aldric the smith" are three counterparties. A merge tool is a nicety for later, not v2.

## 5. Fold-forward and the cap (D20 in full)

`foldTransactions` (`ledger/data.js`) currently replaces the oldest prefix with one carried row per currency. v2 changes the grouping key: plain rows group by currency as today; loan rows group by (currency, counterparty).

- After the prefix is chosen, each loan group whose total is nonzero becomes its own carried row (`kind: 'carried'`, `date: null`, `loan: true`, `counterparty` kept, note "Carried forward (owed)" unless the user renamed it — the same keep-the-edited-note rule v1 fixed). Each loan group whose total is zero merges into its currency's plain carried row instead: a paid-off debt is ordinary history.
- Every debt net is preserved exactly, because the aggregate *is* the prefix net.
- The prefix-size loop counts carried rows as currencies + nonzero loan groups. The existing `RangeError` stays as the impossible-cap guard; it fires only when that count alone exceeds the cap.
- The cap rises to **500** (D20). With proposals appending at refresh cadence, 200 would fold away months of audit; 500 keeps the file tens of KB (v1 §5's save-cost bound is unchanged).
- The invariant is the grouping, not the number: any future cap change inherits debt-safety for free.

## 6. Refresh piggyback mechanics (World State side)

### 6.1 Cutting the block

- `world_state/refresh.js` (full, retry and catch-up paths) and the delta path: cut the report block from the **raw** `fetchFn` result, then pass the remainder to `normaliseOutput` as today. `normaliseOutput` itself is not changed.
- Why it can't come later: when text surrounds a fence, `normaliseOutput` keeps only the first fenced block's contents. It only spares a `mwt-ledger-report` fence today because its `[a-z]*` tag pattern stops at the hyphen; a model that writes ```` ```json ```` or ```` ```ledger ```` for the report would wipe out the document.
- An explicit `mwt-ledger-report` fence is cut along with any trailing chatter. An explicit opener left unclosed as the final fence line (truncated output, or a forgotten closing fence) is cut with the rest of the output: complete rows are kept, a cut-off last row is dropped as a parse error, and a complete explicit report earlier in the output wins. Unclosed fallback fences are never cut. Fallback `json`/`jsonl`/`ledger` or untagged fences must trail the output and contain report rows, valid JSON, or an empty body. Thinking blocks are stripped before looking, using the same pattern as `normaliseOutput`.
- The cut happens on every attempt so the validators never see a report; only the committing attempt's lines are kept (D13).

### 6.2 Window records

- `getRecentMessagesForScan` and `getMessagesSinceForScan` return the joined `Name: text` string only. They gain a parallel list of message records (`{ index, identity }`), and catch-up chunks carry the same list next to `scanWindow.text`. Identities come from `getOrCreateReceiptIdentity`, called while the window is built — before the first await, like the rest of the frozen evidence.

### 6.3 Prompts and handoff

- `world_state/prompts.js`: the full-refresh system prompt gains a short report contract paragraph; `buildUserMessage` gains the Ledger snapshot section (D13), read through a `core/` helper so World State doesn't import Ledger (D27) and captured once pre-flight like `formatChangeNote` (the frozen-evidence rule — retries must not see a ledger that changed mid-call). `world_state/delta.js`: `buildDeltaUserMessage` gains the same request.
- After the committing write — behind the same `captureScope` chat-switch check World State already runs before writing — the gated lines go out as a `mwt:ledger-report` event with the chat id. The Ledger listener checks the chat is still current, resolves, dedupes and writes through `saveLedger` (detached read + validated write, same store discipline as every other Ledger write). A refused write (paused store, chat changed) drops the harvest with a console line and a counter; it never blocks or fails the refresh that carried it.
- No changes to the grounding gate, expiry, or the document validator — the block is gone before any of them run.

### 6.4 Budget and measurement

- Input: the snapshot section plus a short contract paragraph on **every** refresh while D28's gates are open (not only when money moved). Output: ≤ ~200 tokens when events exist. The injection budget entry (`core/budget.js`) is untouched — proposals add no narrator tokens.
- Diagnostics counters (D29): reports seen, lines kept, lines dropped by reason (evidence, currency unresolved, currency ambiguous, item unmatched, parse, duplicate), proposals later accepted/rejected, and World State validation failures per refresh **with and without** the report request in the prompt.

## 7. Item change log

- Append points: user add/edit/delete/carry-toggle in the panel and accepted item proposals. Log rows come from diffing the previous and next item lists in `saveLedger`, so every save path is covered. Backup restore and migration don't log.
- Per-item drill-down (a collapsible "history" row in Inventory) plus a flat "recent changes" strip; both read the same ring. Trim marker: "…older changes trimmed" (D21).
- `date` is prefilled from the story clock when readable (`core/calendar_state.js`), same as transactions — display-only, never parsed back (v1 §3).

## 8. Planner-only projection (D23)

- New `buildLedgerPlannerContext()` in `core/` (alongside `buildCalendarPlannerContext`), pure apart from a detached read of `mwt_ledger`: per-currency balances, carried list with quantities, stored list with `where`, open debts in words — names and numbers only, no transaction history, no proposals, no notes beyond the item's own short note.
- `story_planner/generation.js` prepends it as `wrapTag('ledger', …)` next to the ambient and calendar blocks, so custom templates get it too. Its own character cap constant (e.g. 2,000 characters, overflow summarized as "…and N more stored items"); not an `AUTHOR_CONTEXT_BUDGETS` entry.
- Gated on `enableLedger` and a healthy, non-empty store (D28's pattern). A planner-side checkbox ("Include ledger") defaults on; it's the user's off switch if a stash spoils plans.

## 9. User surface changes

- **Proposal inbox** at the top of the Ledger tab: pending count badge on the 💰 floating button and the tab label; each row shows the proposal, its evidence quote (the one-glance verdict D14 makes trustworthy), the live source message index, and "source changed" badges. Accept / reject per row; "accept all" / "reject all" per harvest (D18).
- **New-item proposals** get an "apply to existing item" picker (rev 2): "rope" vs "Rope (50 ft)" fails the exact match, and without the picker the only choices are reject or a duplicate row.
- **Finances**: counterparty field and "Loan or repayment" checkbox on the add/edit row (autocomplete from existing counterparties later, free text now); the Debts grouping (§4); accepted-from-proposal rows carry a small source chip (`source`, D18) and the "source changed after accept" chip (§3.7).
- **Inventory**: pin star (D22), `where` field on stored rows, per-item history drill-down (§7).
- **Overdraft dialog** (§3.5).
- **Settings**: `ledgerProposals` ("Suggest ledger changes from World State refresh"), off by default until D29's measurements say otherwise.

## 10. Code layout

| File | Job |
|------|-----|
| `core/ledger_report.js` | New, pure: report-block cut, line parsing, evidence gate (via `core/quote_match.js`), currency/item resolution, dedupe keys (D27). |
| `core/` Ledger reader | New: the snapshot for the refresh prompt and `buildLedgerPlannerContext` (D23), both reading `mwt_ledger` without importing `ledger/`. |
| `ledger/proposals.js` | New: the `mwt:ledger-report` listener, expiry walk, apply-on-accept, overdraft-with-loan. |
| `ledger/data.js` | v2 fields and validation, `validateLedgerAudit`, loan-aware fold (§5), item-log ring, pin-aware injection ordering helper. |
| `ledger/injection.js` | Debts line after the money line (D30); pinned carried items first (D22). |
| `ledger/schema.js` | `currentVersion: 2`, `migrations: { 0: …, 1: migrateLedgerV1ToV2 }`. |
| `ledger/store.js` | Item-log diffing on save; proposal writes; unchanged backup key (D15 payoff). |
| `ledger/render.js` | Inbox, existing-item picker, Debts grouping, loan checkbox, pins, `where`, drill-down, chips, overdraft dialog. |
| `world_state/refresh.js`, `delta.js`, `prompts.js` | Window records, raw-output cut, snapshot section, report request, post-commit event (§6). |
| `story_planner/generation.js` | Prepend the Ledger block (§8). |
| `core/settings.js` | `ledgerProposals` default (off). |

Shared files otherwise untouched: `core/api.js` (`normaliseOutput` is not changed — the cut happens before it), `core/budget.js`, `backup/data.js`, `schema/registry.js`, `dashboard/` (Overview row gains nothing — the badge already says the number). Rough size: three new files plus moderate edits; the pure core carries the risk, the World State side stays thin (window records, cut, event).

## 11. Delivery plan

**Phase 6 implementation (2026-11-19):** Full/validation-retry/grounding-retry,
catch-up, delta-patch and delta-no-change commits cut reports before normalization
and publish only after the checked write. `core/ledger_refresh.js` owns the gated,
bounded snapshot and handoff; `ledger/proposals.js` owns resolution, persistence
and expiry. The Ledger tab has an experimental read-only pending list and opt-in.
Diagnostics copy reports include session totals; accepted/rejected measurements
will become actionable with Phase 7's controls. Automated regression tests live
in `test/ledger_phase6.test.js`. Manual exit gate still pending: review GLM and one
local model's samples and counters. Default remains off (Q6).
*Tester-run follow-up (2026-11-19):* MESSAGE_DELETED routes to Ledger expiry
(`routeMessageDeleted`), and showing the Ledger tab re-runs expiry and re-renders
the pending list (tab switches toggle `hidden`; they never rebuild the pane), so a
deleted source message clears without a chat switch or modal reopen. The pending
list shows formatted amounts with `loan`/counterparty and marks digest-mismatched
sources "(source message edited)" until Phase 7's badge; sign-pair contradictions
drop both lines (§3.3).

**Exit Gate for Phase 6**: Passed on ba45b7f2; GLM (and other larger models) passed with no issue. Local models UNDER 12B **may** not work well. Tested on gemma 8b and 4 of 5 tests worked, with 1 retry (first message always hallucinated the ledger quote AND amount when there was no transaction to record). 12B models: 4 of 5 tests worked on first attempt.

- **Phase 5 (pure core):** `data.js` v2 (loan/counterparty fields and validation, loan-aware fold, item-log ring, `validateLedgerAudit`, pin ordering) + migration 1→2 + `core/ledger_report.js` (cut, parse, gate, resolve, dedupe). Tests: the fold preserves every (counterparty, currency) loan net at any cap and never throws below currencies + open debts; a zero-net loan group folds into the plain carry; Debts sign (borrow → "you owe"); a purchase with a counterparty never appears in Debts; dedupe across statuses; evidence-gate drops; duplicate currency names drop as ambiguous; a malformed proposal row leaves `validateLedgerRecord` valid; migration round trip; the injection debts line appears only with nonzero loan nets, caps at three counterparties, and keeps D11's honesty phrasing (D30).
- **Phase 6 (piggyback, measure first — D29):** window records, raw-output cut in every refresh path, snapshot + report request behind `ledgerProposals` (default off) and D28's gates, post-commit event, Ledger listener persisting proposals, expiry walk, Diagnostics counters, and a bare pending list (no inbox polish) so testers can see what arrives. Tests: a document + ```` ```json ```` report survives intact (the `normaliseOutput` trap); the block never reaches the validators; a failed refresh harvests nothing; a chat switch mid-refresh writes no proposals into the new chat; a refused proposal write can't fail the refresh; delta output with a trailing block parses; a disabled Ledger adds nothing to the prompt. **Exit gate:** counters from GLM and one local model, and the `ledgerProposals` default decided then. A SETUP_GUIDE paragraph lands with this phase: what the setting does, why it's off, and the local-model caution (Q6).

- **Phase 7 (surface):** inbox, existing-item picker, Debts + loan checkbox, chips (§3.7), pins, `where`, drill-down, overdraft dialog.

**Phase 7 implementation (2026-11-20):** The inbox supports per-row and atomic per-harvest acceptance/rejection, live source indexes and change badges, and a new-item merge picker. New harvests carry an optional `harvest` receipt; older proposals without one are reviewed separately rather than guessed into a batch. Overdraft review offers cancellation, a negative balance, or a shortfall loan when a non-loan payment names a counterparty (loan proposals cannot create a second loan). Item changes are diffed at `saveLedger`, attributed to the user or accepted proposal, and shown in per-name history plus recent changes with the trim marker. Finances exposes exact-name counterparties, loans and computed Debts; Inventory exposes pins and storage locations. Accepted rows show refresh/source-change chips. Pending counts supplement the existing money badge and appear on the Ledger tab. Planner context and slash commands remain Phase 8; host/mobile QA remains Phase 9.

- **Phase 8 (planner + commands):** `buildLedgerPlannerContext` + planner wiring and checkbox, slash commands.

**Phase 8 implementation (2026-11-21):** `core/ledger_context.js` reads a detached, validated Ledger and builds an independently capped 2,000-character planner projection: exact balances, open loan debts in words, carried items and stored items with locations and short item notes. Each section reserves space so a large carried list cannot crowd out every stored item; omitted rows have explicit counts. Stored possessions are explicitly not on hand. Full-plan (including custom templates), scoped Add/Refresh, and targeted operations receive the application-owned `<ledger>` block. Story Planner Settings has a default-on **Include ledger** checkbox (`includeLedger`); this is independent of author-context budgets, narrator injection and proposal opt-in. Disabled, paused, absent, empty, invalid and future-version Ledgers contribute no block; malformed audit rows remain non-blocking.

`/wt-ledger-add <amount> [currency] [note]` records signed major-unit decimal text through the validated save seam. Currency names match case-insensitively, support quoted multi-word names, and must be unambiguous. With one currency the name can be omitted; remaining arguments are the note. With multiple currencies an explicit name is required. Currencies are created only in the panel. Negative balances remain allowed; commands do not invent loans. `/wt-item <name> [qty]` adds a positive whole quantity (default 1), incrementing one exact case-insensitive match while preserving its carry/storage fields, or creating a carried item. Duplicate names refuse; quote multi-word or numeric-ending names. Both commands refuse disabled/paused/invalid/future stores and use `saveLedger` for validation, folding, item-log attribution and injection refresh. Regression coverage is in `test/ledger_phase8.test.js`; host/mobile command and checkbox QA remains Phase 9.

- **Phase 9 (host QA):** a branch inherits proposals and tombstones; swipe-after-propose shows the badge and swiping back clears it; swipe-after-accept shows the transaction chip; backup round trip carries v2 fields; delta-mode users get proposals; a chat with two same-named currencies drops those lines; checkbox labels render on ST mobile.

## 12. Open questions

1. ~~**Debts in the injection?**~~ — **resolved (2026-11-18): include** — D30, one line capped at three counterparties, D11's honesty phrasing. (Rev 2's note stands: only now safe, since rev 1's net would have told the narrator the player owes every shopkeeper they've paid.)
2. **Tombstone cap (300) and log cap (100):** fine as constants; both trivially tunable.
3. **Counterparty as free text vs Knowledge registry:** free text in v2; registry autocomplete as a later opt-in seam, because it would cross the module boundary (D27).
4. **Per-item reveal anyway?** D24 deferral stands. If planner projection leaves the gap felt, the shape is settled (manual toggle + `where`, phrased "owned but not on hand").
5. ~~`seenAt` display~~ — resolved in rev 2: not stored; the inbox looks up the live index from the identity (D16).
6. ~~**New (rev 2): `ledgerProposals` default after Phase 6.**~~ — **resolved (2026-11-18): off by default**, with a SETUP_GUIDE recommendation (local models needed their own hardening pass for Chronicle and World State before, and this adds a second output format to the same prompt). The "on for API models, off for local" split was considered and rejected: one documented behavior beats a default that depends on the server type. The D29 counters still run; they inform whether a *later* release flips the default, not this one.

## 13. Revision 2 notes (2026-11-18)

A code-checked review against `ledger/`, `world_state/refresh.js`, `core/api.js`, `core/quote_match.js`, `core/message_identity.js` and `story_planner/`. The direction is unchanged; these are corrections where rev 1 relied on code that doesn't work as assumed.

| Change | Where | Reason |
|--------|-------|--------|
| Debts count `loan: true` rows only, and the sign flips (net > 0 = player owes) | D19, §3.1, §3.2, §4 | Rev 1 summed all counterparty cash flow: borrowing showed as "they owe the player", and any purchase with a counterparty (including the doc's own "Paid the smith" example) showed as a debt. |
| Overdraft button records the shortfall as a loan row | §3.5 | Rev 1 showed the same shortfall twice — as a negative balance and as a debt. |
| Fold aggregates loan rows per (currency, counterparty) instead of retaining them and refusing | D20, §5 | Rev 1's refusal made the `RangeError` reachable, locking all saves; D20 (global net) and §5 (prefix net) also disagreed. |
| The report is cut from the raw output before `normaliseOutput` | D13, §6.1 | `normaliseOutput` keeps only the first fenced block when text surrounds it; a ```` ```json ```` report would replace the document. |
| Scan windows return message records; evidence gate uses `core/quote_match.js` | D14, §3.3, §6.2 | The frozen window is one joined string with no message indexes, so rev 1 had no way to fill `msg.identity`. |
| Ambiguous currency names drop | D14 | Duplicate currency names are still allowed in v1. |
| Harvest only from the committing attempt, after the chat-switch check | D13, §6.3 | Rev 1 didn't say which retry's report counts or how a chat switch mid-refresh is handled. |
| Staleness computed at render; `seenAt` dropped; accepted rows get a source-changed chip | D16, §3.1, §3.4, §3.7 | A stored `stale` status stays stuck after a swipe back; the real swipe risk is on accepted proposals. |
| Audit rows validated separately and skipped | D15, §3.6 | One bad proposal row would otherwise turn off the money injection. |
| Report parsing in `core/`, handoff by event | D27, §6.3, §10 | `world_state/` has no feature-module imports today. |
| Gate on `enableLedger` and a new `ledgerProposals` setting | D28, §9 | Enable flags must gate cross-module reads; a disabled Ledger must add no tokens. |
| Planner block uses the calendar/ambient pattern, not `AUTHOR_CONTEXT_BUDGETS` | D23, §8 | That constant is the private-NPC-context dropdown; an entry there adds a fourth preset and hides the block behind a reviewed-request opt-in. |
| Measure-first Phase 6 with counters and an exit gate | D29, §6.4, §11 | The likely regression is the World State document failing more often on small models. |
| Existing-item picker on new-item proposals; snapshot capped; player-only report scope | §3.2, §9 | Name mismatches would otherwise create duplicates; a large inventory would grow every refresh prompt; NPC-to-NPC payments aren't the player's ledger. |
| Same-message duplicate payments documented as a known limit | §3.3 | The dedupe key can't tell two identical payments in one message apart. |
| Open-questions 1 and 6 resolved and wired: D30 (debts line in the injection, capped at three, D11 honesty phrasing) and Q6 (default stays off; SETUP_GUIDE paragraph; D29's "flips after counters" softened to "informs a later flip") | D29, D30, §10, §11, §12 | The recorded answers had no decision number, no injection.js entry in §10, and no phase test; D29's wording promised a default flip the Q6 answer rules out. |
| Ledger snapshot captured once pre-flight, like `formatChangeNote` | §6.3 | It was read inside `buildUserMessage`, so a retry after a mid-call ledger edit would see a different snapshot — a frozen-evidence gap. |
| Review verified rev 2's code claims: `normaliseOutput`'s first-fenced-block capture (`core/api.js`), `quote_match.js`'s exports and ILS refusal, the `core/` planner-builder pattern, `world_state`'s clean import line, and D19's sign walk | — | One nuance: with the hyphenated tag, `innerFence` matches nothing and the fence stays in the text (validation rejects it) — so the cut is mandatory for *both* wrong-tag and right-tag blocks. |
