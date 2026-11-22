# Growth evidence archive: keep a handful of sources in full

**Status:** draft for co-author opinion, 2026-11-15. Nothing here is implemented.

## The ask

On a long chat the growth evidence store is the largest thing MWT keeps in the
chat file. Almost all of it is `archivedRaw`: the raw observations a
consolidated claim was distilled from, kept whole forever.

The proposal: for each consolidated claim, keep in full only the few archived
sources the code actually reads text from, and reduce the rest to a small stub.

We would like your opinion on three things:

1. Is the "what to keep in full" rule (section 4) right, or does anything else
   read archived text that we missed?
2. Is a new tier the right home for stubs, given the schema and downgrade
   behaviour (section 6)?
3. Should slimming existing data be automatic, or a Maintenance action the
   user runs (section 7)?
4. Is the measured saving (section 3: about 37% of the store, less than we
   hoped) worth a new tier and permanently deleted text, or would you rather
   go to one of the alternatives in section 9?

## 1. What was measured

One real chat, months old, several million tokens of history. Chat-metadata
sizes in characters, from Diagnostics → Scope & storage and a console check:

| Store | Size |
| --- | --- |
| Knowledge evidence (all NPCs) | 5,301,752 |
| `mwt_interiority` | 3,407,872 (fixed separately, see CHANGELOG Unreleased) |

Per NPC:

| NPC | Evidence file | Archived records | Archive chars | Quote chars in archive | Archived records no claim cites |
| --- | --- | --- | --- | --- | --- |
| Derek Sandhorn | 1,890,977 | 4,265 | 1,499,326 | 461,453 | 0 |
| Ezra Blackwell | 2,015,617 | 4,707 | 1,676,535 | 529,593 | 0 |
| Ranger | 1,218,033 | 2,940 | 981,573 | 279,898 | 0 |
| four other NPCs | 26K–71K each | 0 | – | – | – |

What this says:

- Three NPCs hold 97% of the store, and about 80% of each file is archive.
- An archived record averages about 350 characters. About 110 of that is the
  quote; the rest is the claim text and fixed fields.
- Every archived record is still cited by a claim. There is nothing orphaned
  to delete.
- The counts are real history, not duplicate noise. This chat has thousands of
  messages, and these are its three main characters.

This data is not subject to the browser's 5M storage limit. The cost is weight:
it is rewritten on every chat save and copied into every chat backup and
branch.

## 2. Why "just drop the quotes" is not enough

Quotes are about 1.27M of the 4.16M archive, so dropping all of them saves
about 24% of the store. It also still has to solve the validator and dedup
problems in section 5. The claim text and fixed fields are the larger share,
so the lever has to be the whole record.

## 3. Sources per claim (measured)

"Keep a handful per claim" only saves anything if claims cite many more
sources than a handful. Measured on the same chat with the snippet below
(`KEEP = 4`):

| NPC | Claims | Archived | Median sources per claim | Largest claim | Kept in full | Archive now | Archive after | After ÷ now |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Derek Sandhorn | 409 | 4,265 | 7 | 379 | 2,174 | 1,499,326 | 910,078 | 61% |
| Ezra Blackwell | 431 | 4,707 | 10 | 896 | 2,190 | 1,676,535 | 966,901 | 58% |
| Ranger | 64 | 2,940 | 53 | 1,730 | 430 | 981,573 | 327,953 | 33% |
| **Total** | 904 | 11,912 | | | 4,794 (40%) | 4,157,434 | 2,204,932 | 53% |

What this says:

- **The saving is about 1.95M characters: 47% of the archive, 37% of the
  whole evidence store** (5.30M to about 3.35M).
- **It misses the "under half" rule below for two of the three NPCs.** Derek
  and Ezra have many small claims (median 7 and 10 sources), and a claim that
  small keeps nearly all of its sources under the section 4 rule. Ranger has
  few, large claims and does well.
- **Stubs themselves are small:** about 70 characters against about 350, from
  these figures. The limit is how many records stay full, not the stub size.
- **If every archived record were a stub** the archive would be about 0.86M.
  That is the floor; the keep rule decides where between 0.86M and 4.16M the
  result lands.
- **A few claims are very large:** one of Ranger's cites 1,730 of the 2,940
  observations, and one of Ezra's cites 896. The profile sees each of those
  as a single claim with four sample lines. That is a consolidation-quality
  question separate from storage, but worth knowing.

The snippet's keep rule is simplified and slightly generous. The real rule
picks one observation per source message, so several observations from one
message collapse to one kept record, and it could use today's `sampleK` of 2
without headroom. Both would lower "kept in full"; we have not measured by
how much.

The snippet reads only; it prints NPC names, counts and sizes. Change `KEEP`
to try a tighter rule.

```js
(() => {
  const m = SillyTavern.getContext().chatMetadata, len = v => JSON.stringify(v).length;
  const ek = Object.keys(m).find(k => /evidence/i.test(k)), KEEP = 4, rows = {};
  for (const [npc, f] of Object.entries(m[ek] || {})) {
    const arch = new Map((f.archivedRaw || []).map(o => [o.id, o]));
    if (!arch.size) continue;
    const keep = new Set(), counts = [];
    for (const c of f.consolidated || []) {
      const src = (c.sources || []).map(id => arch.get(id)).filter(Boolean);
      counts.push(src.length);
      const byTime = [...src].sort((a, b) => a.ts - b.ts);
      const byId = [...src].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      [src[0], ...byTime.slice(0, KEEP), ...byTime.slice(-KEEP), ...byId.slice(0, KEEP), byId.at(-1)]
        .filter(Boolean).forEach(o => keep.add(o.id));
    }
    counts.sort((a, b) => a - b);
    const stub = o => ({ id: o.id, ts: o.ts, tsSource: o.tsSource, verified: o.verified,
      msgKey: o.msgKey, k: 'xxxxxxxxxxxx' });
    let after = 0;
    for (const o of arch.values()) after += len(keep.has(o.id) ? o : stub(o)) + 1;
    rows[npc] = { claims: counts.length, archived: arch.size,
      medianSources: counts[counts.length >> 1] ?? 0, maxSources: counts.at(-1) ?? 0,
      keptInFull: keep.size, archiveNow: len(f.archivedRaw), archiveAfter: after };
  }
  console.table(rows);
})();
```

The keep rule in the snippet is a simplified, slightly generous version of
section 4, so `archiveAfter` is a cautious estimate.

**Decision rule we set beforehand:** continue if `archiveAfter` is under half
of `archiveNow` for the three large NPCs; otherwise look at section 9. The
result is borderline: one NPC passes clearly, two miss, and the total is 53%.

## 4. What must stay in full

A claim's source list is fixed when the claim is created
(`applyConsolidation` appends claims and never adds sources to an old one), so
the choice can be made once per claim.

Readers of archived **text** (claim or quote), and what each needs:

| Reader | Where | Needs |
| --- | --- | --- |
| Profile timeline, earliest and latest quote | `knowledge/growth_timeline.js` `buildProfileEvidenceView` | quote of the first and last dated source message |
| Profile timeline, "source quote" lines | same | quote of the first and last entry of the same-position or undated set |
| Profile timeline, sample claims | same, `pickSamples` | claim text of the first 2 and last 2 dated source messages, plus the first 2 undated by id (`sampleK: 2`) |
| Representative receipt | `knowledge/evidence.js` `getEvidenceForProfile` | quote and `msgIdx` of `sources[0]` |
| Dossier review list and evidence link | `knowledge/render.js:541`, `:624`, `growth_dossier.js:40` | id, category, claim, ts; quote is already optional in the display |

Two details matter for the rule:

- The timeline picks **one observation per source message**, the lowest id.
  The kept set has to be chosen the same way.
- Whether the timeline treats order as known is a property of the whole file
  and can flip as the chat grows. When order is unknown, every source counts
  as undated and the samples are the first by id. So both sets have to be
  kept: the dated ends and the first by id.

Proposed rule, per claim: keep `sources[0]`, the representatives of the first
4 and last 4 dated source messages, and the first 4 and last 1 undated by id.
Four is twice today's `sampleK`, so the setting can rise without the data
having been thrown away. That is at most about 14 full records per claim.

The rule must be **one function that the timeline also uses** to choose its
samples. Two copies would drift, and the timeline would then quietly show
fewer samples.

## 5. What a stub must still carry

Readers of archived records that need **no text**:

| Reader | Where | Needs |
| --- | --- | --- |
| Timeline positions, message counts, early/middle/late spread, ties | `growth_timeline.js` `timelineDomain` | `id`, `ts`, `tsSource`, `verified`, `msgKey` for every cited source |
| Capture dedup | `evidence.js:706` | the normalized claim + quote key |
| Edit collision check | `evidence.js:787` | the same key |
| Observation id numbering | `evidence.js:631` | `id` |

So a stub is `{ id, ts, tsSource, verified, msgKey, k }`, where `k` is a short
hash of the dedup key. Measured, that is about 70 characters against 350.

Points to check:

- **Legacy records without `tsSource`.** `isPositionUnknown` falls back to a
  `capturedAt - ts` heuristic for them. Either the stub keeps `capturedAt`, or
  stubbing writes the heuristic's answer into `tsSource` once.
- **Hash collisions.** A collision makes capture skip a new observation as a
  duplicate. The hash needs enough bits that this is not a practical concern
  across a few thousand records per NPC.
- **`msgIdx`.** Only the dated-order tie-break and `getEvidenceForProfile` use
  it, and both only on records that stay full.

## 6. Where stubs live

Recommendation: a new tier, `archivedStubs`, rather than quote-less records in
`archivedRaw`.

- `checkObservation` (`knowledge/schema.js:335`) rejects any observation with
  an empty claim or quote. Keeping `archivedRaw` strict keeps the "every
  observation has a receipt" rule intact for records that are meant to have
  one.
- Stubs get their own small check.

Every place that lists the tiers by name has to learn the new one:

- `knowledge/schema.js:440` and `:706` (validation, tier walk)
- `backup/restore.js:99` (backup merge by id)
- `knowledge/evidence.js:446` (NPC merge, which also rewrites ids; stub ids
  and the claims that cite them need the same rewrite)
- `knowledge/evidence.js:506` and `:540` (resets)
- `evidence.js` `getEvidenceSummary` and `diagnostics_panel/integrity.js:359`
  (counts)

**Downgrade.** An older MWT version does not know the tier. It would number
new observations without looking at stub ids, so it could reuse an id that a
claim already cites. We think this needs a store version bump so an older
version refuses to write. You know the schema framework's newer-version
behaviour better than we do; is that what a bump gives us?

## 7. When stubbing happens

- **New consolidations:** stub at the moment `applyConsolidation` archives the
  consumed observations. No extra pass, no new UI.
- **Existing archives:** this is the irreversible step for data people already
  have. Two options:
  - A Maintenance action ("Slim archived evidence") that shows the before and
    after size and asks first. This fits the earlier decision that storage is
    handled by visibility, not by MWT acting on its own.
  - Automatic on first load after updating. Everyone gets the saving, but
    text is removed without the user choosing it.

We lean to the Maintenance action for existing data and automatic for new
consolidations.

## 8. Behaviour that changes

- **The text of stubbed observations is gone for good.** A lorebook or chat
  backup taken before slimming is the only way back.
- **Expand** (`expandConsolidated`) moves a claim's sources back to raw so the
  user can redo a consolidation. With stubs it can only restore the sources
  kept in full. Proposal: allow it, say how many it restores ("12 of 340"),
  and keep the rest as stubs so dedup still works. The alternative is to
  disable Expand on claims that have stubs.
- **Deleting a claim** leaves its sources archived and uncited. Those can all
  become stubs, since only dedup and id numbering still need them.
- **The dossier review list** shows archived ids with their claim text. A
  stubbed id would show as on file but without text. Is that acceptable, or
  should those ids read "summarized"?
- **Re-capture over old messages** is still blocked by the hash, but only for
  exact repeats, as today.

## 9. Alternatives, given a borderline measurement

Per-claim stubbing saves about 37% of the store on this chat. If that is not
enough for the cost, the options are:

- **Tighten the keep rule** to exactly what is read today (`sampleK` of 2,
  one record per source message). Cheap to measure; unlikely to help the
  small claims much, since a 7-source claim keeps most of its sources at any
  setting.

- **Drop quotes only** on archived records that are not a claim's first or
  last source. About 24% at best, and it still needs the validator change.
- **Re-consolidate the claims themselves** so fewer, broader claims cite more
  sources, then stub. This changes profile behaviour and needs its own review.
- **Move the archive out of the chat file** into storage that is not rewritten
  on every chat save. This removes the weight without deleting anything, but
  it is an architectural change and the archive would no longer travel with
  the chat.

## 10. Out of scope

- Capture rate. The observation counts on this chat look legitimate.
- The raw and consolidated tiers. Both are small next to the archive.
- The browser-storage side (Knowledge Restore history), which is a separate
  store with a separate limit.
