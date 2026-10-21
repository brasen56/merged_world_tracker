# Phase 4b — reviewed VectFox ledger proposals

Implemented in MWT as a per-NPC **Import from VectFox** action for NPCs with an existing lorebook entry. Import performs bounded current-chat history/source reads, not generation or semantic search. It stages a proposal; it never writes automatically. Review, edit, Accept & Write, and Dismiss use the existing staging UI.

## Contract and safety

- Requires public API v1 with history, source resolution, and knowledge acquisition schema v1 capabilities.
- Only `knowledge_status: recorded` events with versioned acquisitions are eligible. Presence, event summaries, roster membership, and legacy events never grant knowledge.
- Only the NPC name and registered aliases qualify. Conflicting registry aliases are deferred.
- Each acquisition needs verified originals, source-index/reference agreement, and quotes found in the resolved message. This validates evidence structure and quotation, **not semantic entailment**; review remains required.
- Facts are labeled `[fact]`; rumors `[rumor]`. Belief records say `Claim heard; not established or necessarily believed`, avoiding an invented assertion that the NPC accepted a lie. Stated uncertainty remains in the fact text.
- Acquisition basis and source-reference citations survive in the ordinary text ledger. The review also exposes the full acquisition/quotes and source checks. No new persisted store/schema is required: existing lorebook backup/export/restore carries the text unchanged.
- Items exceeding the existing 800-character fact / 80-character source contract, or containing forbidden structure, are deferred whole. No clipping or model reconciliation is used.
- Deduplication is deterministic, normalized exact-meaning matching against the ledger, including prior imports. Plain accepted facts suppress equivalent unqualified fact imports. Rumors/beliefs/uncertainty are not collapsed into facts. Paraphrases need manual review.
- Imports use the existing history source revalidation and final guarded write seam. Chat/lorebook/NPC/alias changes, changed source checks, concurrent content revisions, and unsaved host edits refuse acceptance.

## Bounds and coverage

At most 500 representative events, 500 source references, and 30 new ledger items per proposal. Retrieval truncation/sampling/partial coverage and selection limits are visible. Changed, missing, unresolved, unsupported, and overlong acquisitions do not become accepted knowledge. Non-current-chat originals are not substituted with summaries. Repeated imports do not constitute full archive traversal: no coverage watermark is advanced.

## Evaluation and extraction-replacement gate

`test/vectfox_ledger.test.js` compares explicit acquisition imports against expected character knowledge:

| Fixture | Correct additions | Knowledge intentionally excluded |
| --- | --- | --- |
| Sealed letter | Delivery occurred | Sealed confession |
| Mention-only character | None | Scene information |
| Explicit off-screen report read | Reported bridge collapse | Unread/undisclosed information |
| Off-screen, no acquisition | None | Reader-only bridge collapse |
| Lie | Claim heard, with deception/acceptance uncertainty | Claim promoted to established fact |
| Rumor | Rumor with uncertainty | Established-fact assertion |
| Partial disclosure | Shipment arrival | Secret destination |

Additional fixtures record missed/deferred imports for unavailable originals, invalid references/quotes, and overlong items, and verify that legacy records cannot import. These are contract/safety fixtures, **not a representative real-chat comparison against MWT extraction**.

Before any extraction suppression is proposed, run both paths on representative long chats and record per-NPC correct additions, unsupported additions, missed supported knowledge (including acquisition-only characters omitted by history subject retrieval), duplicates, deferred items, archive coverage, and costs. Manual semantic adjudication is required. **No extraction suppression is enabled; NPC discovery and every existing scanner output remain unchanged.**

## Manual host check

1. With VectFox enabled and a current-chat event containing a supported acquisition, open the NPC card and choose Import from VectFox.
2. Inspect the staging diff, labels, uncertainty, citations, and supporting-history details. Dismiss and confirm no lorebook changes.
3. Import again and Accept & Write. Confirm the ledger retains the labels/citations and existing profile/relationships. Reimport unchanged content: no new items should be proposed.
4. Stage another proposal, then edit the lorebook, switch chat, or edit a source message. Acceptance must refuse rather than overwrite newer data.
5. Disable VectFox or remove the knowledge capability: import reports unavailable, while ordinary scanning remains usable.