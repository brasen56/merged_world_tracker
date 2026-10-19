# Dossier field refresh with VectFox history (Phase 1)

Open an NPC's **Fields** picker, choose fields, and optionally enable **Include
VectFox history**. The option is off by default. VectFox must expose its version 1
public API with both history retrieval and source resolution available.

1. Leave scope at **Current chat**, or explicitly select enabled collections that
   belong to the same story continuity. Archives are never combined automatically.
2. Click **Preview history selection**. The preview reports the actual scope,
   selected event count, retrieval/selection limits and unverified source count.
3. Click **Refresh selected**. History is added to the existing refresh generation
   request; preview and source checks make no generation calls. Existing invalid-JSON
   retry behavior is unchanged.
4. Review the normal field diff and expandable **VectFox supporting history**
   section, then **Accept & Write** or dismiss. References are proposal metadata,
   not text added to lorebook fields.

## Selection and interpretation

- Requests use one subject containing the NPC's canonical name and user-approved
  aliases. Ambiguity/backend failures remain visible errors, not empty history.
- At most 500 candidate events are retrieved using VectFox's representative history
  selection: slots are shared across source chats and spread from early to late
  evidence within each source, rather than taking the first 500 archive matches.
  This requires a VectFox build supporting `history_selection: 'representative'`;
  older v1 builds may still return a prefix. Scan limits still apply and sampling
  and truncation remain disclosed. A separate budget selects at most
  30 events and 24,000 serialized event-data characters. Source references are
  capped at 500. Coverage reports retrieval limits separately from selection.
- Background reserves early and late evidence; event types are ranking hints,
  never hard exclusions. Other fields prefer later source-order evidence.
  Source order does not imply shared chronology across chats. Stored `DateTime`
  and `scene_time` strings are retained (at most 150 characters each) in generation
  evidence and supporting-history review; missing dates do not imply an order.
- Role requires enduring responsibilities; Where to Find requires an established
  base/routine rather than travel. Read on PC requires the user persona among the
  event's characters. Current Agenda receives only events with continuity-view
  remaining threads, preserving closure indices and resolution references.
- Secrets, Appearance, Voice, Image Tags, Personality and Canon Lock receive no
  historical input. Their existing refresh paths and ownership locks are unchanged.
- Summaries are untrusted evidence, not instructions or behavioral quote receipts.
  Explicit canon/protections retain authority; supported history can correct stale
  generated text, and recent direct evidence can establish subsequent change.

## Safety and limitations

Chat/lorebook scope, NPC identity/aliases, source validity, API scope token and the
original entry content are rechecked through refresh and Accept. Writes use the
existing final-loaded-book guard and refuse pending host-cache conflicts. A changed
entry or invalidated scope requires a fresh preview/refresh rather than overwriting
newer data. Closing/changing the history picker discards in-flight history results.

Changed or missing historical sources block a history-assisted request. Unresolved
legacy/cross-chat references are visibly unverified stored-summary evidence, never
represented as verified originals. Cross-chat original messages are not loaded.
Proposal references are session-scoped, so stale staged proposals must be refreshed.

The generation model still interprets evidence: selection, prompt rules, field
validation and human review do not prove semantic support for every generated claim.
No Growth capture, Knowledge Ledger import, new scanner, or direct VectFox lorebook
writes are introduced by this phase.