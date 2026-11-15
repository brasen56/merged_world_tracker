# Ledger module design (v1)

**Status:** Draft for co-author review. Nothing implemented.
**Written:** 2026-11-14, from the co-author's "deterministic ledgers" proposal and Brasen's v1 scope call.
**Naming:** working name **Ledger**, one module with two tabs: **Finances** and **Inventory**.

## 1. Goal

Models track money and possessions badly in RP. They forget purchases, invent balances, and lose a character's important gear between scenes. Users try to work around this with lore entries, but they forget to update them after a summary. Testers also tried World State's Worn / Significant Items, and their gear vanished after a few refreshes. That is World State working as designed: its item rule lists an item only while the story is using it (`world_state/prompts.js:166`), and Standard detail caps the section at 3 items (`world_state/prompts.js:187`). World State answers "what is in play this scene", not "what does the character own".

The Ledger holds what the player character owns and how much money they have. **The user enters it; code does the arithmetic; the narrator only reads it.** It's the Ambient principle (code decides, the model renders), with one difference that shapes this whole design: Ambient keeps no state (weather is recomputed from the clock and a seed), while a ledger is state that builds up over time. So v1 lets only the user change it.

## 2. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Manual entry only in v1. No model calls, and the model never writes to the ledger.** | Code can't see "she pays him 30 gold" in prose. Every automatic path needs a model to turn prose into numbers, and that brings in double-counting and swipe handling (§7). Manual entry has none of that. |
| D2 | **Own panel, not just slash commands.** A new 💰 Ledger tab in the MWT modal, plus a floating button. Slash commands are an optional extra (Phase 3). | Users need to see and fix the list, not just append to it. |
| D3 | **Finances is a transaction list; the balance is computed, never stored.** Each entry: signed amount, currency, note, optional in-story date. The balance is the sum per currency. | Gives history ("where did my 200 gold go?"), lets users fix a mistake by editing one entry, and is the shape later versions add proposals to. A stored total can drift from its history; a computed one can't. |
| D4 | **Amounts are integers in the currency's smallest unit.** Each currency has a `decimals` setting (0 for gold, 2 for dollars). | "Code does the arithmetic" has to mean exact arithmetic. Floating-point sums drift (0.1 + 0.2). |
| D5 | **Several user-defined currencies, no conversion.** One currency is marked as the badge currency. | Exchange rates differ in every setting. Gold/silver/copper or credits/scrip stay as separate totals. |
| D6 | **Inventory items:** name, quantity, note, and **Carried** or **Stored**. Only Carried items are injected. Quantities are ≥ 1; zero is a confirmed delete, never a silent row removal. No change log for items in v1; edits are direct. | Keeps the injection small when someone tracks a big stash. Money needs a history; items rarely do. |
| D7 | **Player character only.** No NPC wallets or inventories. | Tracking what NPCs own is scope creep, and it would pull the Ledger toward Knowledge. |
| D8 | **Stored per chat in `chat_metadata` (`mwt_ledger`), registered as a schema store.** | Per-story data. Branches inherit it through ST's metadata copy, the way Ambient's seed does (Ambient D2). Registering it gives backup, validation and Diagnostics coverage (§5). |
| D9 | **Cap the transaction log.** Past a limit (200; see §9 — re-tune when §7.1's automatic entries arrive), the oldest entries fold into one "Carried forward" entry per currency. The balance doesn't change. | Keeps the chat file small over a long campaign. |
| D10 | **One injection, set again on every ledger edit and on chat change.** No `generate_interceptor`. Nothing is injected when the module is off or the ledger is empty. | Unlike Ambient, nothing depends on the clock, so the text only changes when the user changes the ledger. |
| D11 | **The money total is authoritative; the item list is not complete.** The injection says listed items are definitely carried, and says nothing about unlisted ones. | Users won't list every possession. An "if it's not listed, you don't have it" rule would make the narrator take away the character's boots. |
| D12 | **World State is unchanged.** The item rule stays as it is, and the Ledger doesn't feed World State in v1. | Loosening the item rule would undo World State's token savings. The two answer different questions (§1). |

## 3. Data model

```js
// chat_metadata.mwt_ledger
{
  version: 1,
  currencies: [
    { id: 'c1', name: 'gold', decimals: 0, badge: true },
    { id: 'c2', name: 'silver', decimals: 0, badge: false },
  ],
  transactions: [
    // amount is a signed integer in minor units; balance = sum per currency
    { id: 't1', currency: 'c1', amount: 500, note: 'Starting purse', date: null, kind: 'entry' },
    { id: 't2', currency: 'c1', amount: -30, note: 'Paid the smith', date: '14 March 1203', kind: 'entry' },
    // D9 fold-forward: kind 'carried' replaces the oldest entries, same sum
  ],
  items: [
    // qty is an integer >= 1; zero rows never exist — reaching 0 is a confirmed delete (§4.2)
    { id: 'i1', name: 'Grandfather\'s sword', qty: 1, note: 'Notched blade', carried: true },
    { id: 'i2', name: 'Rope (50 ft)', qty: 2, note: '', carried: false },
  ],
}
```

- Ids are short strings that are never reused. Knowledge's reused-uid problem (`knowledge/lorebook.js` history) is the cautionary tale.
- `date` is free text, prefilled from the story clock when one is readable (`core/calendar_state.js`). It's display-only and nothing parses it back.
- Deleting a currency that still has transactions is refused, with a message saying why.

## 4. User surface

### 4.1 Floating button and badge
- New entry in `FLOAT_BUTTONS` (`core/ui.js:508`): 💰, `showFloatLedger`, `enableLedger`. It reuses the existing factory, so it gets dragging, position reset, the collapsed hub and the mobile positioning behaviour for free. No separate overlay.
- The corner badge slot (the one the countdowns use, updated every 5 s by `updateFloatTokenCounts`) shows **the badge currency's balance only**, in compact form: `500`, `1.2k`, `12k`, `−40`. Items never go on the badge.
- Classic button style shows `💰 500 gold`. The tooltip lists every currency's total and the number of carried items.
- Click opens the Ledger tab.

### 4.2 Ledger tab
- **Finances:** balance per currency at the top. An add row: + or −, amount, currency, note, date (prefilled). Below it the transactions, newest first, each with edit and delete (delete asks first). "Carried forward" entries are marked: amount and note are editable (the balance is computed, D3, so an edit is just a corrected opening balance and can't desync anything), the currency is locked and there's no date field (an aggregate spanning hundreds of entries has no one date), and delete asks first, naming the amount it would remove.
- **Inventory:** rows with name, quantity stepper, note, and a Carried/Stored toggle. Quantities are integers ≥ 1: the stepper bottoms out at 1, and stepping or typing 0 prompts "Remove item?" — the same confirmed delete as Finances — so an item never disappears silently and zero-quantity rows never exist. Carried items list first. An add row at the top.
- **Settings strip:** enable, show button, inject on/off, and the currency list (add, rename, decimals, badge currency).

### 4.3 Overview
- One row on 🏠 Overview: the badge currency's balance and the number of carried items. Read-only, linking to the tab.

### 4.4 Slash commands (optional, Phase 3)
- `/wt-ledger-add <amount> [currency] [note]` with a signed amount, and `/wt-item <name> [qty]`. The panel stays the primary surface.

## 5. Storage and integration

- **Where it lives:** `chat_metadata`, which ST saves inside the chat file on the server. It does **not** count against the browser's ~5M-character localStorage limit. The quota problem Knowledge hit was `kt_history` (Restore snapshots in localStorage), which is a different place. What chat metadata does cost: ST rewrites the whole chat file on every save, so a bloated store slows saves. D9's cap keeps the Ledger to tens of KB at worst.
- **Schema store:** a module-owned `ledger/schema.js`, registered in `schema/registry.js`. Backup, runtime preparation and Diagnostics enumerate stores from there.
- **Backup:** add `ledger: 'mwt_ledger'` to `METADATA_KEYS` in `backup/data.js`. `test/schema_engine.test.js:546` fails if the registry and the backup key list disagree, so the two can't drift. Hand-typed data is the worst thing to lose, so this is not optional.
- **Budget:** one entry in `core/budget.js`'s injection list, next to Ambient's (`core/budget.js:74`).
- **Injection:** `applyExtensionPromptInjection` from `core/injection.js`, the same helper Ambient uses, with its own key and `<mwt_ledger>` wrapper tag.
- **Module boundaries:** the Ledger imports only `core/`. No feature-module imports in v1.

### 5.1 Injection text (draft)

```
Stage direction, not narration. Player character's ledger (authoritative, kept by the user):
Money: 470 gold, 12 silver.
Carried: Grandfather's sword; rope ×2; healing salve ×3.
Never state a different amount. If the character spends or receives money, narrate it; the user updates the ledger. Carried items are definitely on hand; items not listed may still exist.
```

Expected size is about 40–80 tokens for a typical ledger. That's an estimate to measure once it's built.

## 6. Code layout

New top-level `ledger/` directory, shaped like `ambient/`:

| File | Job |
|------|-----|
| `ledger/data.js` | Pure: balances, compact formatting, fold-forward, validation helpers. No host imports. |
| `ledger/schema.js` | Store schema descriptor (version 1). |
| `ledger/injection.js` | Builds and applies the injection body. |
| `ledger/render.js` | Tab markup and wiring. |
| `ledger/settings.js` | Module settings and defaults. |
| `ledger/index.js` | Module entry: chat-change hook, re-apply injection. |
| `ledger/style.css` | Tab styles. |

Shared files touched: `core/ui.js` (button entry plus classic/modern labels), `index.js` (`TABS`), `schema/registry.js`, `backup/data.js`, `core/budget.js`, `dashboard/` (Overview row), and settings defaults. Rough size: Ambient-sized, about 600–900 lines plus tests. That's an estimate.

## 7. Later versions (not v1)

### 7.1 Proposals from World State refresh
The fix for "users still forget to update it". During its normal refresh, World State also reports money and item changes it saw in the messages it read ("paid 30 gold to the smith"). They arrive as **proposals** in the Ledger tab, and the user accepts or rejects each one with one click. Code still does the arithmetic.

- **No extra API call:** it piggybacks on the refresh, at the cost of some output tokens. The refresh prompt receives the current carried list so it doesn't propose items already listed.
- **Proposals, not automatic changes:** refresh windows can overlap, so the same payment could be reported twice. Each proposal carries the message it came from. A repeat from the same message is dropped, and a proposal whose source message was swiped away or deleted expires.
- **Precedent:** Knowledge already stages proposals for review (`knowledge/staging.js`).
- **Landmine:** this needs a stable per-message key. Index-based keys broke Chronicle after ILS condensing, and `send_date` keys can collide at minute resolution. Settle this before building §7.1.

### 7.2 Other candidates
- Debts by counterparty (who owes whom), built from an optional counterparty field on transactions.
- A change log for items.
- Showing Stored items to the narrator on demand.

## 8. Delivery plan

**Phase 1: pure core (solo, startable now).** `ledger/data.js` and `ledger/schema.js`: balances in minor units, compact badge formatting, fold-forward that keeps every balance unchanged, and validation. Unit tests, including fold-forward balance checks and the decimals edge cases.

**Phase 2: store and plumbing.** Registry, backup key, budget entry, injection, and chat-change handling. Tests: schema engine, a backup round trip that includes `mwt_ledger`, and injection text snapshots.

**Phase 3: user surface.** Ledger tab, floating button and badge, Overview row, settings. Optional slash commands.

**Phase 4: host QA in ST.** Desktop and mobile; a branch inherits the ledger; backup and restore round trip; badge in both button styles; injection visible in the prompt and in the budget panel.

## 9. Open questions for the co-author

1. **Debts:** add an optional counterparty field to transactions in v1 so §7.2 has data later, or leave it out completely?
 - Leave out until v2
2. **Item history:** is "no item log in v1" right, or do users want to see when the sword was sold?
 - No item log until v2
3. **Badge when there's nothing to show:** hide the number when no currency exists, or show `0`?
 - Prefer hiding when no currency exists, allow negative numbers (debt)
4. **The log cap:** is 500 transactions before folding forward reasonable for long campaigns?
 - Drop to 200 transactions, doubtful anyone would need more than that for an audit. Can change once automatic entries are in
5. **Name:** "Ledger", or something friendlier in the UI like "Purse & Pack"?
 - Keep "Ledger", its more setting agnostic

Additional questions:

6. **Cap on Carried Items**: Nothing currently bounds carried items, so a user could select 60-80 items and blow past the token estimate. Cap the carried list?
 - I suggest yes. Cap at 10-15 (injectable). A cap that truncates should say so in the injection text (e.g., the list ends with "…and 5 more items"), which keeps D11's honesty contract intact