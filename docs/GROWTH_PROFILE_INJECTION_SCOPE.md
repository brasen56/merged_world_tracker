# Growth-derived dossier text — scope and implementation plan

**Status:** Revision 3. Phases 1–2 implemented and automated checks passing;
Phases 3–5 not started. Not release-ready until Phase 5.
The plan this scope develops went to the requester on 2026-11-09, and they
answered on 2026-11-10 with three refinements. Revision 2 added the results of
a code review done before implementation. Revision 3 adds the requester's
refinements (§13).
**Date:** 2026-11-10 (first drafted 2026-11-09)
**Source:** [GROWTH_PROFILE_INJECTION_RESPONSE.md](./GROWTH_PROFILE_INJECTION_RESPONSE.md) —
the request, our first reply, the requester's answer (verbatim), and the draft
plan with internal implementation notes. That file remains the correspondence
record; this doc is the buildable version of its "Our plan" section.
**Area:** the Growth × Knowledge seam — dossier field ownership
(`knowledge/field_ownership.js`), staging review (`knowledge/staging.js`,
`knowledge/render.js`), the `[MWT:store]` registry (`knowledge/store.js`,
`knowledge/registry.js`), and evidence timestamps (`knowledge/evidence.js`).
**Purpose:** fix the behavior contract, safety boundaries, and delivery phases
before implementation, so work can start the moment the requester approves.

## 1. Problem

Once an NPC has Growth evidence, Knowledge scans stop updating that NPC's
`Personality:` line — the Growth system and the scan never rewrite each other's
work. The approved Growth profile itself never reaches the RP prompt either:
it is saved to the "NPC Profiles" lorebook with no keywords, so SillyTavern
never triggers it (its only reader is Interiority's thoughts call, by design).
Together this means approved growth reaches the roleplay only if the user
pastes it into the dossier by hand — a fair complaint with six main characters
and ~30 NPCs.

The requester asked for a per-NPC option to use the latest approved Growth
profile as the dossier's personality and voice, reviewed through a change
tracker. Their follow-up answer (2026-11-09, recorded verbatim in the source
doc) settled the shape: Growth **rewrites the Personality and Voice text
itself**, the user approves it in Staging, and regular scans keep updating
everything else. Their second answer (2026-11-10) refined three points:
the lock follows the switch, the echo warning uses message time, and each NPC
gets its own length limits (§2, requirements 6–8).

Related standalone defect: the Growth window's explainer says the dossier
updater stops touching `Personality:` "once an NPC has a growth profile". It
actually happens at the first evidence capture (`hasEvidenceFile` is true once
observations exist, before any profile is saved). The text gets corrected with
this work regardless of the option.

## 2. Settled requirements

From the requester's answer of 2026-11-09:

1. **Staging is the control surface.** Compact dossier updates generated from
   the Growth profile, sent to Staging; the existing diff shows which Growth
   notes are added, edited, or replaced before approval. A per-NPC history of
   approved changes for looking back at how the character evolved.
2. **Scans keep the rest.** While the option is on, regular scans keep
   updating the base dossier fields and the Knowledge Ledger, and preserve
   approved Growth text rather than overwriting it. When the dossier
   activates, approved text reaches the RP prompt alongside the other fields.
3. **Turning the option off keeps approved text.** Nothing reverts. From the
   next regular scan, the scanner updates those fields in its usual format,
   "just as it did before I enabled the Growth option."
4. **Scope follows Lorebook scope.** Approved text, the option, and the change
   history follow the existing Knowledge → Lorebook Scope setting (global /
   character / chat). Raw evidence stays in the chat where it was captured.
5. **Detail level: two or three short lines' worth per field.** Personality
   captures what changed and when the NPC still falls back on an old habit;
   Voice captures usual speech patterns and how they shift under pressure.
   If fields must stay single-line for the scanner and editor, that detail
   fits inside the line. Original quotes stay in the evidence view.

From the requester's second answer of 2026-11-10:

6. **The lock follows the switch.** With the switch off, keep the last
   approved Personality and Voice text, and let regular scans update **both**
   fields in their usual format from the next scan on. Collecting evidence
   alone must not keep Personality locked. Otherwise the line goes stale while
   Growth keeps collecting observations (§5.5, §5.6).
7. **The echo warning uses the RP message's time.** They are backfilling older
   scenes, so evidence captured after an approval can come from a message
   written before it. The warning stays in Staging and leaves the decision to
   them (§5.9).
8. **Per-NPC length limits.** Personality and Voice get limits set separately
   for each NPC. The defaults are 450/350, and the main cast can go beyond
   900/600, up to 1,500/1,000. The point is to have room to keep established
   details when a new development would otherwise push one out (§5.4).

The plan interprets requirement 2's "preserve them once approved" as: while
the switch is on, scans leave `Personality:` **and** `Voice:` alone for that
NPC, because scans replace whole fields and would otherwise overwrite approved
Voice text. New speech habits reach Voice through Growth proposals instead.
This reading was flagged to the requester in the plan ("if you'd rather scans
kept updating Voice too, let us know"), and their 2026-11-10 answer didn't
object, so it stands (§8).

Because approved text **is** the field text, requirement 2's "included in the
RP prompt when the dossier activates" holds by construction — no separate
injection path is built.

## 3. Why the profile is not injected as-is

Three constraints from the first reply carry forward into this design:

1. **The profile quotes past scenes.** In the RP prompt, those quotes become
   catchphrases — the model repeats old lines instead of writing new ones.
2. **It is too long for the slot.** A profile is 2–4 paragraphs; dossier
   fields are one line each, and a few paragraphs per NPC would add hundreds
   of tokens for every active NPC.
3. **It can feed on itself.** Once profile-derived text steers the model,
   evidence capture records that behavior and the next profile confirms it.
   The approval step is the brake; the echo warning (§5.9) is the detector.

So the profile is never injected, and neither is its prose pasted in. Growth
**drafts new one-line field text** from the profile, and only the approved
lines enter the dossier.

## 4. Proposed behavior at a glance

| Workstream | Proposed behavior | Consent boundary |
| --- | --- | --- |
| The option | Per-NPC "Use Growth in dossier" switch in the Growth window and on the NPC card. Stored as never set, on or off; every NPC starts as never set | Nothing changes for any NPC until the user sets its switch |
| Drafting | One explicit, disclosed model call turns the generated profile into proposed `Personality:`/`Voice:` lines plus a per-sentence change list | Option must be on and a profile must exist; nothing is drafted or staged without the explicit action; one call, bounded retry |
| Review | The existing Staging diff (Current / Changes / Proposed) with the change list and evidence links underneath; Accept & Write approves, Dismiss writes nothing | The live entry never changes before Accept; Growth items are excluded from Accept All and never auto-approved |
| Ownership | The switch decides. On: Growth owns Personality and Voice. Off: scans own both. Never set: today's rule (evidence locks Personality). Scans always keep every other field and the Ledger | Canon Lock, the Knowledge Ledger, and all other fields are exactly as they are today; an NPC whose switch was never set behaves exactly as today |
| Length limits | Per-NPC Personality and Voice limits in the Growth window: default 450/350, up to 1,500/1,000, with an estimated token cost shown | Over the NPC's limit warns; only the Growth ceiling (1,500/1,000) rejects; scans keep 900/600 for every NPC |
| Capture context | Evidence capture no longer receives the dossier's identity lines (Personality, Voice, Tone, Perceived as) | Applies to every NPC whether or not the option is on; capture keeps the role, background and canon context |
| Turning off | Approved text stays; from the next scan, scans update both Personality and Voice in their usual format | Nothing reverts on disable; a pending Growth item can't be accepted while the switch is off |
| Scope | Option flag in the registry record, history in its own disabled `[MWT:growth-history]` entry, approved text in the dossier entry — all in the Knowledge book, so all follow Lorebook Scope | Evidence stays per-chat; a new chapter never treats missing evidence as a change |
| History | Last 10 approvals per NPC (date, approved text, change list; the pre-Growth text only on the first record) in a dedicated disabled `[MWT:growth-history]` entry | Capped, never localStorage, never sent to the model, viewable per NPC |
| Echo warning | Advisory flag on a sentence whose supporting evidence all comes from RP messages written after that sentence was first approved (message time, not capture time) | Advisory only; never blocks acceptance; backfilling older scenes never triggers it |
| Standalone fix | Growth window explainer corrected: Personality freezes at first evidence capture, not at profile save | Text-only; shippable independently of the option |

Cost: one model call per drafted proposal (reusing the Knowledge/Growth model
configuration via `ktFetchFromApi`, `retries: 1`, like every other Growth
call). No new model setting.

## 5. Design

### 5.1 The option

A per-NPC switch, "Use Growth in dossier". It appears in the Growth window and
on the NPC's card. The UI shows on or off. The record also distinguishes
"never set", which every NPC starts as and which keeps today's behavior (§5.5).
It is stored in the NPC's registry record in `[MWT:store]`
(`knowledge/registry.js`), never in chat metadata, so it follows the Lorebook
Scope setting (§5.7).

Proposed record shape:
`growthDossier: { enabled?: boolean, limits?: { personality: number, voice: number } }`.

- An absent `enabled` means never set.
- `limits` holds the per-NPC length limits (§5.4). When absent, the defaults
  450/350 apply.
- An earlier draft had a `hasApprovedLines` flag. It was dropped in revision 3:
  approving lines requires the switch on, so every NPC with approved lines
  already has an explicit setting.

- **Writing it.** Read the record, spread it, and set the field, the way
  `registerEntry` merges (`knowledge/registry.js:40`), so no sibling field is
  ever dropped. `saveRegistry` itself does not merge: it stores the map as given
  and only stamps the identity fields.
- **Validating it.** `checkRegistryRecord` (`knowledge/schema.js:341`) passes
  unknown record fields through unchecked, so the new field needs a shape
  check. Make it a repair, not a finding: a finding in `checkRegistryRecord`
  quarantines the whole NPC record. A malformed `growthDossier` should be
  stripped while the NPC stays live, the way `validateKnowledgeStoreData`
  handles a malformed `mergedFrom`. A limit outside its range (above
  1,500/1,000, or not a positive integer) is repaired by dropping that limit,
  so the default applies.

### 5.2 Drafting

When the option is on and a profile exists, an explicit action in the Growth
window ("Prepare dossier lines", presented with the generated profile) makes
one model call:

- **Inputs:** the new profile; the current `Personality:` and `Voice:` lines;
  Canon Lock; canon observations; and the evidence list as `id`, `category`,
  `claim` and `ts`. The model needs the claims to cite anything. Quotes are
  left out so they can't leak into the lines.
- **Output:** the two proposed lines plus a per-sentence change list. Every
  sentence of both lines is marked `keep | edit | add | remove`, and each
  carries the evidence ids behind it. `keep` is the default, and `edit` must
  cite evidence. A `remove` carries a reason:
  - **`evidence`:** the removal must cite evidence.
  - **`length`:** the sentence was dropped to fit the NPC's limit (§5.4). It
    is valid only when keeping the sentence would push the line over that
    limit, which is a deterministic check.
- **Validation:** the field contract runs first: a single line, and the Growth
  ceiling of Personality 1,500 / Voice 1,000 (§5.4). Then comes the NPC's own
  length limit, 450/350 unless changed. Going over the ceiling rejects the
  field whole with a reason, exactly like every other contract rejection. It
  never slices.
  Three things raise review warnings, not blocks: a line over the NPC's limit
  but under the ceiling, quote characters in the line, and typology
  vocabulary. The
  typology check runs in code against the MBTI, Enneagram, DISC and Big Five
  terms `GROWTH_PROFILE_PROMPT` bans. A sentence marked `keep` that is not
  verbatim in the current line is downgraded to `edit`. That check is
  deterministic, so sentence lineage never depends on the model's honesty.
- **Leaf rule:** the output is never fed back into evidence capture or profile
  generation. It goes to Staging or nowhere.

The prompt lives in `knowledge/prompts.js` beside `GROWTH_PROFILE_PROMPT`,
with the same "leaf, never a root" framing. Every sentence the model writes or
edits must come from the evidence. The current line is the text being edited,
never a source of new claims.

**Sentences with no approval behind them.** On an NPC's first draft, the
current Personality line is the frozen text from before tracking began. It has
never been checked against evidence, and it may carry typology labels. It is
also the one input `GROWTH_PROFILE_PROMPT` is built never to read. A hand edit
made between approvals is in the same position.

These sentences may still be kept. Dropping them on a first draft would erase
detail the evidence simply hasn't touched yet. Instead, each one is labelled in
the change list as "from the original line, no evidence" or "hand edit, no
evidence", and gets no evidence links until a later draft cites some. They're
identified deterministically: any sentence of the current line that isn't
verbatim in the last approved version counts, or every sentence when there is
no approved version yet.

Preparing a new draft replaces any pending Growth proposal for that NPC (one
pending Growth item per NPC). Dismiss always leaves the dossier as it is, and
the currently approved text stays in use until a new version is accepted.

### 5.3 Review and approval

The proposed lines stage exactly the way a 🎯 Fields refresh stages:
`buildUpdatedDossierContent(current, { personality, voice })`
(`knowledge/lorebook.js:1156`) leaves every other line as it is, and the
managed relationship block is re-attached at accept as for every proposal.
The Staging tab shows the usual Current / Changes (diff) / Proposed view, with
underneath it:

- the per-sentence change list: `kept`, `edited`, `added`, `removed`, and
  `dropped to fit length`. The last one is shown separately so a length-driven
  drop stands out. Each sentence links to the observations behind it in the
  evidence view, or is marked "no longer on file" when that evidence was
  deleted;
- any validation warnings: over the NPC's limit, quotes present, typology
  vocabulary, or unresolvable evidence ids.

Accept & Write is the approval: one write, one history entry. Only the two
lines change.

**Growth items are accepted one at a time.** Accept All skips them with a
note. This is a new rule: Accept All has no type-based skip today
(`knowledge/render.js:565-576`), and its confirmation count has to leave out
the items it skips. No auto-approval path consumes them either. `scanAndAccept`
(`knowledge/index.js`) is programmatic-only today and must stay unable to take
this item type.

**Growth items get their own accept branch.** Accept always writes
`buildUpdatedDossierContent(fresh, { personality, voice })`. `fresh` is the
entry as it is on disk at accept time. Personality and Voice come from the
Proposed text, so the reviewer's edits to those two lines count. Edits to any
other line of a Growth item's Proposed text are never written, and the editor
warns when they exist. If the entry changed after staging (an intervening
scan, manual edit or field refresh), the item is rebuilt that way and marked
stale for re-review.

Neither existing branch is safe for this item:

- **The reviewer-text branch** (`knowledge/render.js:113-115`, which
  `refreshFields` items take) keeps the whole stored entry. A second Accept
  would then revert the intervening scan's field changes and ledger lines.
- **The rebuild branch** calls `enrichStagingItem`, whose merge applies
  ownership again (`knowledge/lorebook.js:989`). That would null the item's
  own two fields.

So Growth items are staged without `refreshFields` and identified by their own
type.

### 5.4 Shape of the text

Each field stays on a single line, because the scanner and the entry editor
read one line per field. By default the line holds two or three short
sentences, and it must not get heavier with every update.

**Length limits, per NPC (requirement 8).** Each NPC has its own limit for
each field, set in the Growth window next to the switch. The default is 450
for Personality and 350 for Voice, adjustable up to 1,500 and 1,000.

- **How the limit is used.** The drafting prompt gets the limit as its target.
  Going over it raises a review warning, not a block, so the decision stays in
  Staging.
- **Where the ceiling comes from.** The dossier format itself has no length
  limit, and the manual editor doesn't check field length (its only size
  check is a 50,000-character paste guard). The 900/600 caps are MWT's own
  field contract (`knowledge/field_contract.js:67`, `:75`). It is applied to
  every model-written value, including inside the backstop in
  `buildUpdatedDossierContent` (`knowledge/lorebook.js:1161`), so a
  1,400-character Growth line would be rejected there today.
  The Growth path therefore passes its own ceiling, 1,500/1,000, into the
  contract for these two fields. Scans and every other writer keep 900/600
  for all NPCs.
- **The cost, shown next to the setting.** At about four characters per
  token, the two lines cost roughly 200 tokens at the defaults and about 625
  at the maximum. That cost applies each time the NPC's dossier activates.
  With several main characters in one scene, that's 1,000–2,000 extra tokens
  per turn. When SillyTavern's World Info budget fills up, it starts leaving
  other lorebook entries out. The Growth window shows the estimate
  (`estimateTokens`, `core/context.js`) beside the limits.
- **Dropped to fit length.** When new material has to fit and the line is at
  its limit, the sentence that gets merged or dropped is marked `dropped to fit
  length` (§5.2). That keeps it separate from an evidence-backed removal, so an
  established detail pushed out by length stands out in Staging. It can be put
  back in the Proposed text, or the limit can be raised, before accepting.

The drafting rules that keep the line within its limit:

- **Present tense, not history.** The line says how the NPC behaves today.
  What changed, and when, lives in the Staging diff and the history.
- **An old habit is written as a condition.** "Still goes quiet and
  over-polite when an officer raises their voice" states that the habit
  persists and when it resurfaces, in one clause. It is included only when
  evidence shows the habit returning after the change.
- **Updates edit, they don't append.** A change rewrites the sentence it
  affects; anything the new evidence doesn't address stays word for word. If
  something new must fit and the line is at its limit, the weakest-supported
  sentence is merged or dropped, and the change list marks it `dropped to fit
  length`.
- **No quotes.** Patterns, not the character's words, so the model can't turn
  them into catchphrases. Quotes stay in the evidence view.

```
Personality: Owns mistakes in front of the crew now and asks for help with the ledgers. Still goes quiet and over-polite when an officer raises their voice. Slow to trust, but keeps every promise made.
Voice: Plain, short sentences; drops formal titles with friends. Under pressure, slips back into clipped parade-ground orders.
```

### 5.5 Field ownership

One helper decides, and every ownership seam uses it. The capture gates that
also call `hasEvidenceFile` (`knowledge/growth.js:701` and `:1139`) are not
ownership checks and stay as they are.

The switch decides who owns the two fields:

| Switch | Personality | Voice |
| --- | --- | --- |
| Never set (every NPC until the user sets it) | Today's rule: Growth owns it while this chat has evidence for the NPC (`hasEvidenceFile`, `knowledge/evidence.js:276`) | Scans |
| On | Growth | Growth |
| Off | Scans | Scans |

- **Why the switch decides (requirement 6).** Evidence capture never writes the
  dossier. Locking Personality whenever evidence exists therefore only let the
  line go stale while Growth kept collecting observations. Now that Growth has
  a way to write the line, the switch states who owns it.
- **What turning it off costs.** The user is choosing scans again, and accepting
  that scans reword Personality from their own previous wording each time. That
  slow drift is the thing Growth was built to stop. The switch's tooltip says
  so in one line.
- **Why "never set" keeps today's rule.** If an untouched switch meant off,
  upgrading would let scans start rewriting every Personality line a user had
  copied in by hand, which is how this requester has been working. Nothing
  changes for an NPC until someone sets its switch.
- **The never-set state keeps today's new-chapter gap.** A fresh chat has no
  evidence, so the lock lifts there. That is existing behavior and is left
  unchanged.
- **An explicit setting carries into a new chapter.** It is stored in the
  registry and follows Lorebook Scope, so it decides ownership there whether
  or not that chat has evidence.

While owned, model-driven updates (scans, single-NPC update, Enrich, field
refresh) have the field nulled exactly as `applyFieldOwnership`
(`knowledge/field_ownership.js:11`) nulls Personality today; `buildUpdatedDossierContent`'s
null-skipping merge then keeps the existing line untouched. The Growth
proposal itself is the owner and bypasses the nulling by construction.

Seams to carry the new rule: `applyFieldOwnership` callers at
`knowledge/staging.js:170`, `:243`, `:256`, `:270`, `:280` and
`knowledge/lorebook.js:966`, `:989`, `:1650`; and the three sites that check
`hasEvidenceFile` directly — `knowledge/lorebook.js:1549` (single-NPC update
Personality skip), `knowledge/lorebook.js:1696` (field-refresh sanitizer), and
`knowledge/render.js:2140` (field-refresh picker).

Hand edits stay the user's authority. The manual editor can still change these
lines, and doing so does not unset ownership. The next Growth draft treats the
hand-edited line as the current text and labels its new sentences "hand edit,
no evidence" (§5.2).

### 5.6 Turning the option off

The approved text stays where it is, and nothing reverts. From the next
regular scan, scans update both Personality and Voice in their usual format
(requirement 6). Evidence capture carries on as before.

**Turning it back on.** The next draft starts from whatever the scans have
written by then. Scan-written sentences have no approval behind them, so they
are labelled "no evidence" (§5.2).

**A pending Growth item while the switch is off.** It stays in Staging, but its
Accept is disabled, with a note: "Turn Use Growth in dossier back on to
approve, or Dismiss." Accepting it while off would write text the next scan
then owns, which would surprise the user.

**Lines over the scan limit.** A Growth line longer than the scan limit of
900/600 (possible with raised limits, §5.4) stays until a scan actually
changes that field. Scans only output a field when something meaningfully
changed. A 🎯 field refresh is different: it echoes the current value back, so
it gets rejected by the 900/600 contract. The line is kept either way. The
refresh's message should say the line is over the scan limit, not just report
a bare rejection.

### 5.7 Scope and new chapters

The option lives in the NPC's registry record in `[MWT:store]`. The history
lives in the `[MWT:growth-history]` entry (§5.8), and the approved text is part
of the dossier entry itself. All three are in the Knowledge book. That book
resolves through the existing Lorebook Scope setting (`knowledge/scope.js`,
chosen at `knowledge/settings.js:131`), so all of it follows the user's choice.
With Character scope, a new chapter brings the approved text, the switch
setting, the length limits and the history along. Because an explicit switch
setting decides ownership (§5.5), a new chapter with no evidence yet keeps the
same owner for both fields.

Evidence stays in the chat where it was captured, so the first Growth update
in a new chapter sees only that chapter's evidence. Missing evidence is never
treated as a change: anything the new evidence doesn't address keeps its
current text (`keep` is the default; `remove` must cite evidence that exists).

### 5.8 Approval history

Each acceptance appends one record for the NPC: the date, the approved text,
and the change list with its per-sentence lineage. The text from before the
change is not stored again, because it is the previous record's approved text.
The exception is an NPC's first record, which also keeps the pre-Growth
original. The cap is the last 10 records per NPC.

**Where it lives.** The history gets its own sentinel entry in the Knowledge
book, `[MWT:growth-history]`, following the cleanup-recovery container's
pattern (`knowledge/cleanup_recovery.js`):

- **Never injected.** No keywords; disabled, non-constant, non-vectorized and
  recursion-excluded. Those flags are set again on every write, because
  `constant` and `vectorized` are the two flags that bypass keyword matching.
- **Stored shape.** JSON `{ version, records }`, keyed by the registry
  `entityId` rather than the name, so a rename or merge doesn't orphan an
  NPC's history. An identity merge needs a rule at implementation: concatenate
  both histories by date, then apply the cap again.
- **Future versions.** A container written by a newer MWT is refused untouched,
  the same rule the recovery container follows.
- **Skipped wherever the book is walked.** Every place that already skips the
  cleanup container must skip this one too: `backup/index.js:208`,
  `knowledge/lorebook.js:322`, `:459`, `:547`, `knowledge/manual_edit.js:43`,
  `knowledge/reconcile.js:16`, `knowledge/staging.js:404` and `:793`. Prefer
  one shared "is this an MWT internal entry" check so a future container
  doesn't need eight edits; `knowledge/reconcile.js:16` already combines two.
- **Backups.** Backup and restore carry it the way they carry the cleanup
  container (`backup/index.js:64`).

**Why not a store field.** The store is one JSON entry, serialized again and
validated on every registry or relationship save. Its validator also keeps
only the top-level keys it knows (`knowledge/schema.js:474-477`). A dedicated
entry is only serialized again when an approval happens. At the default limits,
a record is about 2 KB, so the cap holds an NPC's history to roughly 20 KB. It
still rides every whole-book save, so measure it with the schema perf harness
(`test/schema_perf_harness.test.js`). It never goes to localStorage, which is
the `kt_history` quota problem.

**Sentence lineage is stamped at acceptance.** A `keep` sentence inherits the
previous version's first-approved timestamp. An `edit` or `add` sentence gets
the acceptance time. A sentence with no approval behind it (§5.2) also gets the
acceptance time, and it keeps its "no evidence" label until a draft cites
evidence for it. The Growth window lists the history so the user can look back
at how the character developed.

### 5.9 Echo warning

A sentence is flagged when every piece of evidence supporting it comes from RP
messages **written** after that sentence was first approved. It is compared
against the per-sentence first-approved times from §5.8. That pattern can mean
the model played the NPC to match the dossier line and capture recorded the
echo, not a real change.

"Written" means the message's own time, never the capture time (requirement 7).
That way, backfilling older scenes after an approval never trips the warning.

- **Raw observations.** `ts` is the cited message's send time. The capture
  time is the separate `capturedAt` field (`knowledge/evidence.js:685-729`).
  Backfilled observations keep the original message's time, including ones
  restored from ILS summaries (`knowledge/growth.js:1363`).
- **Consolidated claims.** These have no `ts`. Use `firstSeen`, the earliest of
  their sources' message times (`knowledge/evidence.js:927-935`).
- **Evidence with no usable time.** It counts neither way. If none of a
  sentence's evidence has a usable time, the sentence isn't flagged, and the
  change list says the timing is unknown.
- **Canon observations.** These are user-authored, so they are never an echo.
  A sentence with any canon support isn't flagged.

Approval times and message send times are both wall-clock times, so they
compare directly. The flag is advisory: it shows in the change list during
review, leaves the decision to the user, and never blocks acceptance. A
sentence with no supporting evidence (§5.2) is never echo-flagged, because its
"no evidence" label already says more.

### 5.10 Capture context (the leaf-rule fix)

All three evidence-capture paths currently pass the NPC's whole dossier entry
to the model as `<existing_context>`:

- the manual capture, `knowledge/growth.js:245-262`;
- continuous capture, `:1010-1022`;
- backfill, `:1298-1310`.

That includes the Personality and Voice lines. The only guard is the evidence
prompt's instruction not to extract observations from that context. That is a
prompt-level partition, which the Growth blueprint rejected as fragile because
it depends on the model complying. Once Growth-owned lines are in the dossier,
they would loop straight back into capture. The model would be primed to see
the approved behavior in the messages, and the next profile would confirm it.

**Fix:** remove the identity lines (Tone, Perceived as, Voice, Personality)
from capture's context in code. Reuse `extractIdentityFields`
(`knowledge/lorebook.js:1282`), which already splits them out for Interiority.
The evidence prompt only uses that context for role, background and canon, so
nothing it relies on is lost. This applies to every NPC, with or without the
option. Today the frozen pre-tracking Personality line reaches capture the same
way.

## 6. Invariants

- **The leaf rule.** Neither evidence capture nor profile generation ever
  receives the Growth-owned lines or the proposal output.
  - **Capture breaks this today.** It gets the whole dossier as
    `<existing_context>`, and only a prompt instruction keeps the lines out of
    the observations. §5.10 removes them in code.
  - **Profile generation already complies.** It reads evidence plus canon
    (`extractCanonFromEntry`, never the Personality line).
  - **The prompts don't change.** `GROWTH_EVIDENCE_PROMPT` and
    `GROWTH_PROFILE_PROMPT` stay as they are. The new drafting prompt is the
    only new consumer of profile text, and its output never flows back
    upstream.
- **Nothing changes on upgrade.** An NPC whose switch was never set behaves
  exactly as it does today. Evidence still locks Personality, and scans still
  own Voice. Only an explicit on or off changes ownership (§5.5).
- **One approval, one authority.** Nothing enters the dossier without Accept
  & Write. Dismiss, cancel, model failure, malformed output, and validation
  failure leave the entry unchanged.
- **Stale accepts never undo anything, in either direction.** Accept & Write
  already refuses a proposal whose entry changed after it was built
  (`knowledge/render.js:110-139`).
  - **A scan item accepted after a Growth approval.** An untouched scan item
    re-merges its fields onto the fresh entry, and ownership keeps the two
    lines out, so the Growth text survives. A reviewer-edited or field-refresh
    item keeps its own full text instead (`knowledge/render.js:113-115`), so
    its second Accept would write the pre-Growth lines back.
    Fix: at accept, re-apply the current Growth-owned lines, the same way the
    relationship block is re-applied (`knowledge/render.js:146`). Only do it
    for lines the reviewer did not edit in that proposal, judged against the
    proposal's baseline. A reviewer's own edit to those lines wins.
  - **A Growth item accepted after a scan.** The Growth item must not write
    stale text over the scan's changes to other fields or its new ledger
    lines. Its own accept branch (§5.3) always rebuilds onto the fresh entry
    and only ever writes the two lines.
- **One new internal entry, no new storage medium.** The option is a registry
  field, the text is the dossier entry, and the history is one new sentinel
  entry built on the cleanup-recovery pattern (§5.8). Nothing goes to
  localStorage or chat metadata. Both new shapes need schema coverage: the
  store validator drops unknown top-level keys, and `checkRegistryRecord`
  passes unknown record fields through unchecked (§5.1).
- **Interiority's intentions call sees the approved lines, on purpose.** The
  intentions call gets the full dossier (`assembleNpcBlocks`,
  `interiority/generation.js:403`, via `loadNpcKnowledge` at `:343-364`), so
  Growth-owned Personality and Voice reach it. This deliberately relaxes the
  earlier "Growth feeds thoughts only" rule. The lines are user-approved
  dossier text, and intentions that follow the NPC's growth are a benefit. The
  thoughts call is unchanged: it already prefers the saved profile as
  `<character_core>` (`:506-516`).

## 7. Working decisions (ours, absent requester input)

1. **Drafting is an explicit action**, not automatic after profile
   generation. It is a paid model call; the module's convention is explicit,
   disclosed invocation. If the requester expects automatic drafting, adding
   it later is small.
2. **Fields: Personality and Voice only in v1.** The requester allowed "any
   dossier field where Growth has something meaningful to add"; the plan
   starts with the two fields the request named. Other fields, and the
   "small Growth section under each field" alternative, stay deferred (§9).
3. **One pending Growth proposal per NPC**; a new draft replaces the pending
   one.
4. **Accept All skips Growth items**, so each one is accepted on its own. This
   is a new rule, not an existing one being matched (§5.3).
5. **Content warnings are advisory.** They cover over-target length, quote
   characters, typology vocabulary and unresolvable evidence ids. Only
   structural contract failures block.
6. **Sentence lineage is stamped at acceptance**, not recovered by matching
   text across history versions.
7. **Interiority's intentions call may read the approved lines** (§6). Decided
   2026-11-09: intentions that follow the NPC's growth are wanted.
8. **History storage** (decided 2026-11-09): a cap of 10 records, a dedicated
   disabled entry, and the approved text only, with the pre-Growth text kept
   on the first record alone (§5.8).
9. **Sentences with no approval behind them are kept but labelled.** This
   covers the pre-Growth original and hand edits. Dropping them on a first
   draft would erase detail the evidence hasn't reached (§5.2).
10. **The capture-context fix applies to every NPC**, not only those with the
    option on (§5.10).
11. **Ownership follows the switch, and never set keeps today's rule**
    (2026-11-10). The requester asked for the switch to decide. Keeping
    today's rule for a switch that was never set is our safeguard for the
    upgrade (§5.5).
12. **A pending Growth item can't be accepted while the switch is off**
    (§5.6). It can still be dismissed, or the switch turned back on.
13. **Length limits are soft per NPC, with a hard Growth ceiling**
    (2026-11-10). Going over the NPC's limit warns. Going over 1,500/1,000
    rejects. Scans keep 900/600 for every NPC (§5.4).
14. **Echo timing uses message time** (2026-11-10). That means `ts` for raw
    observations and `firstSeen` for consolidated claims. Evidence with no
    usable time is neutral, and canon is never an echo (§5.9).

## 8. Open items awaiting the requester

1. **The plan: answered.** It was sent 2026-11-09. The requester's answer on
   2026-11-10 accepted it and asked for three refinements, which are folded in
   as revision 3 (requirements 6–8). Implementation can start.
2. **Voice under scans while the switch is on: settled by silence.** The plan
   asked about it, and the 2026-11-10 answer didn't object, so scans leave
   Voice alone while the switch is on. If the requester raises it later, only
   the "On" row of §5.5's table and the drafting prompt change.
3. **Fields beyond Personality and Voice: not raised.** Working decision 2
   stands. Revisit only if the requester asks.

## 9. Explicit exclusions

No injection of profile prose or Psychoanalyze output into any prompt; no
separate "Growth notes" section inside dossier entries; no changes to
evidence capture beyond removing the identity lines from its context
(§5.10); no changes to profile generation, consolidation, Canon Lock authority,
the Knowledge Ledger, secret tiers, relationships, promote/demote, the manual
editor, or auto-approval behavior; no per-field form UI beyond the existing
diff and the per-NPC length limits; no change to the 900/600 scan limits;
no automatic drafting; no new model setting; no cross-chat evidence
migration or history backfill.

## 10. Acceptance criteria

- An NPC whose switch was never set behaves exactly as today: evidence locks
  Personality, and scans own Voice. This includes NPCs that already have
  evidence at upgrade time. No NPC gains Growth-owned text without the switch
  on and an explicit Accept & Write.
- Ownership matches §5.5's table for all three switch states, across every
  ownership seam.
- With the option on and a profile generated, the draft action produces a
  staged item whose content differs from the live entry only in the
  `Personality:` and `Voice:` lines; every other line, the ledger, Canon
  Lock, and the managed relationship block are preserved.
- Proposed lines are single-line and quote-free (by prompt, and
  warning-checked in code). Over the Growth ceiling of 1,500/1,000 rejects the
  field whole with a reason. Over the NPC's own limit raises a warning. Scans
  stay bound to 900/600 for every NPC.
- A `remove (length)` is accepted only when keeping the sentence would push the
  line over the NPC's limit. It shows as `dropped to fit length`.
- The per-NPC limits default to 450/350, accept values up to 1,500/1,000,
  follow Lorebook Scope, and show an estimated token cost.
- The diff shows the per-sentence change list with evidence links, including
  "no longer on file" for deleted evidence.
- Sentences with no approval behind them (the pre-Growth original, hand
  edits) carry their "no evidence" label. Typology vocabulary in a proposed
  line raises a warning.
- While the option is on, scans/update/enrich/field-refresh never modify
  Personality or Voice for that NPC, and keep updating every other field and
  the Ledger.
- An intervening edit between staging and accept never writes pre-Growth
  Personality/Voice back on a later accept (the §6 re-apply), and never
  overwrites a reviewer's hand edit to those lines.
- A Growth item accepted after an intervening scan keeps that scan's
  other-field changes and new ledger lines. Lines outside Personality and Voice
  in a Growth item's Proposed text are never written.
- Turning the switch off keeps the approved text, and from the next scan, scans
  update both Personality and Voice. A pending Growth item can't be accepted
  while the switch is off.
- A 🎯 refresh of a line over 900/600 keeps the line, and its message says the
  line is over the scan limit.
- With Character scope, a new chat carries the switch setting, the limits, the
  approved text and the history. Ownership there matches the switch with no
  evidence in that chat, and the first draft proposes no removals for absent
  evidence.
- Each acceptance appends one history record, and the cap holds at 10. The
  history:
  - lives in the `[MWT:growth-history]` entry, with its never-inject flags set
    again on every write;
  - is skipped at every walk point that skips the cleanup container;
  - survives a reload and a backup round trip;
  - never touches localStorage;
  - is shown in the per-NPC history view.
- A malformed `growthDossier` registry field is stripped as a repair, and the
  NPC stays live.
- The echo flag fires only when all supporting evidence comes from messages
  written after the sentence's first approval, using acceptance-stamped
  lineage. Evidence backfilled after an approval from older messages never
  triggers it. Consolidated claims use `firstSeen`, evidence with no usable
  time is neutral, and canon support suppresses the flag.
- Evidence capture and profile generation prompts never receive the
  Growth-owned lines or the proposal output (the leaf rule, pinned by tests).
  None of the three capture paths' `<existing_context>` contains a Tone,
  Perceived as, Voice or Personality line, for any NPC.
- Growth proposals are excluded from Accept All and from every auto-approval
  path.
- The Growth window explainer states the freeze correctly (first evidence
  capture).
- Existing growth, ownership, staging, manual-edit, and cleanup suites keep
  passing; new suites cover the ownership matrix, the proposal contract,
  stale-accept interplay, scope carry-over, history, and the echo flag.

## 11. Implementation orientation (not a finalized design)

Paths relative to the repository root; line numbers verified 2026-11-10:

- `knowledge/field_ownership.js` — `applyFieldOwnership` (:11) follows §5.5's
  three-state table:
  - never set: today's `hasEvidenceFile` rule for Personality, and scans own
    Voice;
  - on: Growth owns both;
  - off: scans own both.

  Prefer one exported `growthOwnsField(name, key)` helper that every seam
  shares.
- `knowledge/evidence.js` — `hasEvidenceFile` (:276). The raw observation
  shape `{ id, category, claim, quote, msgIdx, ts, capturedAt, canon? }`
  supplies the ids. `ts` is the cited message's time and `capturedAt` is the
  capture time (:685-729). Consolidated claims carry `firstSeen`/`lastSeen`
  computed from their sources' `ts` (:927-935). The echo check uses `ts` and
  `firstSeen`.
- `knowledge/registry.js` — `registerEntry` (:40) is the merge pattern to
  copy. `saveRegistry` (:26) stores the map as given and only stamps identity
  fields. The new `growthDossier` field merges and never replaces.
- `knowledge/schema.js` — `checkRegistryRecord` (:341) needs the
  `growthDossier` shape handled as a repair, not a finding.
  `validateKnowledgeStoreData` (:492) keeps only the store fields it knows
  (:474-477). The history no longer lives in the store, so this is only
  context.
- `knowledge/cleanup_recovery.js` — the pattern for the
  `[MWT:growth-history]` entry: the sentinel prefix and the
  `isCleanupRecoveryEntry` predicate (:48-73), the flags set again on every
  write (:285-315), and `{ version, records }` with refusal of a newer
  version. The walk points that skip it are `backup/index.js:208`,
  `knowledge/lorebook.js:322`, `:459`, `:547`, `knowledge/manual_edit.js:43`,
  `knowledge/reconcile.js:16`, `knowledge/staging.js:404` and `:793`.
- `knowledge/staging.js` — ownership call sites :170, :243, :256, :270, :280.
  The new Growth item stages as its own type (never with `refreshFields`)
  and never enters Accept All.
- `knowledge/lorebook.js` — ownership call sites :966, :989, :1650; direct
  `hasEvidenceFile` sites :1549 and :1696; `buildUpdatedDossierContent`
  (:1156) for the stage merge; `ktFetchFromApi` for the drafting call.
- `knowledge/render.js` — in `handleAccept`:
  - the stale guard is :110-139, and the edited/`refreshFields` branch at
    :113-115 is the one a Growth item must not take;
  - the relationship re-apply at :146 is the pattern for re-applying Growth
    lines on scan items;
  - the Growth item gets its own branch (§5.3).

  Accept All's loop is at :556-582, and it needs the type skip and a
  corrected count. Also: the field-refresh picker (:2140), the Growth window
  explainer (:1379), and `wireGrowthProfileEvents` for the option switch, the
  draft action and the history view.
- `knowledge/prompts.js` — `GROWTH_PROFILE_PROMPT` (:354) and the leaf-rule
  framing (~:310); the new drafting prompt lives here.
- `knowledge/field_contract.js` — caps: Voice 600 (:67), Personality 900
  (:75). Reuse the whole-value rejection path. Add an optional per-call
  ceiling for these two fields, used only by the Growth path (1,500/1,000).
  `buildUpdatedDossierContent`'s own backstop (`knowledge/lorebook.js:1161`)
  must receive it too, or the Growth merge rejects long lines there. Every
  other caller keeps the 900/600 defaults.
- `core/context.js` — `estimateTokens` for the cost estimate shown beside the
  per-NPC limits.
- `knowledge/growth.js`:
  - Three capture paths load the whole entry as `<existing_context>`:
    manual capture (:245-262), continuous capture (:1010-1022) and backfill
    (:1298-1310). Each passes it through the identity split (§5.10).
  - Backfill threads the original message's `ts` through (:1363), which is
    why backfilled evidence never trips the echo flag.
  - Profile generation (:364) is unchanged.
  - The draft action hooks in beside profile save.
  - The `hasEvidenceFile` uses at :701 and :1139 are unaffected.
- `knowledge/lorebook.js` — `extractIdentityFields` (:1282) is the split the
  capture fix reuses.
- `interiority/generation.js` — no change. The intentions call reads the full
  dossier through `loadNpcKnowledge` (:343-364) and `assembleNpcBlocks`
  (:403), which is accepted (§6). The thoughts call's identity split is at
  :495-516.
- Proposed new module `knowledge/growth_dossier.js` — option state access,
  the proposal request, parsing and validation, the `[MWT:growth-history]`
  container (read, write, cap, flags), and the echo computation. Pure and
  host-independent, in the `manual_edit.js` / `ledger_cleanup.js` tradition.
  UI wiring follows in `render.js`, and styles go in `knowledge/style.css`.
- `test/` — new suites for ownership, proposal validation, accept interplay,
  history/echo, and scope behavior; `growth_capture_transition.test.js`,
  `growth_modal_scope.test.js`, and the field-contract/staging suites are the
  regression pins.

## 12. Implementation phases

**Planning record:** 2026-11-09, revised 2026-11-10 for revision 3. All
Phases 1–2 are complete (records below); Phases 3–5 are **not started**. Sections 1–11 are the behavior contract; this breakdown only
sequences the work and does not expand the scope. Each phase lands with its
own tests and a short completion record here. Do not expose the option in the
UI before Phase 3's guarded accept exists, and do not release before Phase 5.

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Ownership rules, persisted state, the capture-context fix, and the explainer fix | None |
| 2 | Proposal contract and drafting service | 1 |
| 3 | Staging review, guarded accept, and the option UI | 1, 2 |
| 4 | Approval history and the echo warning | 2, 3 |
| 5 | Cross-path regression, host QA, and release validation | 1–4 |

### Phase 1 — Ownership rules and persisted state

**Goal:** make "Growth owns these fields" correct in every chat, headless.

- Add `growthDossier: { enabled?, limits? }` to the registry record through
  the merge-safe path, with the shape and range repair in
  `checkRegistryRecord` (§5.1). An absent `enabled` means never set.
- Add the `[MWT:growth-history]` container (§5.8): the sentinel and
  predicate, the flags set again on every write, `{ version, records }` with
  refusal of a newer version, the skip at every walk point, and backup
  carry. The record writers land in Phase 4. The container lands now so later
  phases only add behavior.
- Implement the shared ownership helper (§5.5's three-state table), and route
  all eight `applyFieldOwnership` sites and the three direct `hasEvidenceFile`
  sites through it. Never set reproduces today's rule exactly, so nothing
  changes for an NPC until its switch is set.
- Remove the identity lines from capture's `<existing_context>` on all three
  capture paths (§5.10). This applies to every NPC and can ship on its own.
- Correct the Growth window explainer (`knowledge/render.js:1379`). This can
  also ship on its own.

**Exit gate:**
- Ownership-matrix tests: each switch state (never set, on, off) against
  evidence present or absent, per field.
- The new-chat case with no evidence, under both Chat and Character scope:
  an explicit switch decides ownership, and never set behaves as today.
- An upgrade regression: an NPC that already has evidence and a never-set
  switch keeps its Personality locked.
- The capture prompts contain no identity line on any of the three paths.
- The history container survives a reload and a backup round trip, keeps its
  flags, and is skipped at every walk point.
- A malformed `growthDossier` is repaired and the NPC stays live.
- The existing ownership and growth suites pass.

**Phase 1 completion — 2026-11-10:**
- Added merge-safe headless registry settings, defaults and per-limit repair.
  Validation remains in the pure schema layer; malformed settings are repairs,
  not NPC quarantines. No option UI is exposed.
- Routed the existing ownership seams through `growthOwnsField`: never set
  retains the evidence-only Personality lock and scan-owned Voice; explicit on
  owns both; explicit off owns neither. Capture-enrollment gates are unchanged.
- All three capture paths strip Tone, Perceived as, Personality and Voice from
  existing context while retaining factual/canon lines. Corrected the explainer
  to say first evidence capture, not profile save.
- Added the versioned `[MWT:growth-history]` container, persist-and-verify writes,
  scope guarding, cap of 10 per entity, reasserted never-inject flags, shared
  internal-entry exclusions, and backup collection/validation/restore carry.
  Imports are current-wins per entity. Approval record writers and identity-merge
  history concatenation remain Phase 4 work.
- Added `growth_dossier_ownership.test.js` and `growth_phase1_integration.test.js`
  (26 tests): ownership matrix, Chat/Character scoped settings, upgrade lock,
  direct-check regression pin, capture prompts, repairs, reload/backup round trip,
  flag repair, future-version refusal and failed persistence verification.
- Validation: all **181 test files / 4,491 tests passed**; targeted ESLint for
  every changed/new JavaScript file passed; `git diff --check` passed.
  SillyTavern host QA and release validation remain Phase 5 work.

### Phase 2 — Proposal contract and drafting service

**Goal:** define exactly what can be staged, before any staging exists.

- The drafting prompt goes in `knowledge/prompts.js`. Its inputs are claims,
  ids and timestamps, never quotes (§5.2).
- The request, parsing and validation service goes in
  `knowledge/growth_dossier.js`. It covers:
  - the two lines plus the change list;
  - the Growth ceiling first (1,500/1,000, through the new per-call contract
    ceiling), then the NPC's own limits, which are passed into the prompt as
    targets;
  - warnings for going over the limit, quotes, typology vocabulary and
    unresolvable ids;
  - the `keep`-verbatim downgrade;
  - the rule that `edit` and `remove (evidence)` must cite existing evidence,
    and the deterministic check that `remove (length)` is valid only when
    keeping the sentence would exceed the limit;
  - the deterministic "no evidence" label for sentences with no approval
    behind them.
- Strict parsing consistent with the cleanup convention — no lenient repair
  of truncated output; a failed parse is a failed draft, not a proposal.
- One `ktFetchFromApi` call, `retries: 1`; failures leave everything
  unchanged and explain.

**Exit gate:**
- Pure tests cover malformed and truncated output, the ceiling and limit
  boundaries (including a raised limit above 900/600), keep-verbatim
  downgrades, missing evidence ids, valid and invalid `remove (length)`, and
  the change list accounting for every sentence.
- Scan writes stay bound to 900/600 for an NPC with raised limits.
- The labels are correct on a first draft and after a hand edit.
- The typology warning fires.
- No model call is made unless the option is on and a profile exists.

**Phase 2 completion — 2026-11-10:**
- Added the headless `draftGrowthDossier` service and drafting prompt. It takes
  the generated profile displayed by the caller (or loads the saved profile),
  current lines, Canon Lock, and whitelisted evidence claims/ids/message times.
  Evidence receipts, archived raw evidence and approval history are not sent.
- Proposal shape: `{ personality, voice, changes }`, where each change has
  `{ field, action, before, after, evidenceIds, reason? }`. Every current
  sentence must be consumed once, and proposed sentences must reconstruct the
  output in order and match its split sentence boundaries one for one.
  Boundaries are deterministic: terminal punctuation followed
  by whitespace/end, plus any trailing fragment; semicolon clauses stay together.
- Strict complete JSON, optionally one whole JSON fence; no truncation repair,
  parse retry, staging, UI, dossier writes or history writes. The single API
  invocation uses `retries: 1`. Explicit on, profile availability, pause state,
  scope and NPC identity are guarded, including after asynchronous reads/calls.
- Shared field validation and the dossier merger accept explicit per-call
  ceilings. Growth uses 1,500/1,000; ordinary callers still use 900/600.
  Targets remain advisory. Typology, quotes and unresolved ids warn; edits,
  additions and evidence removals require at least one existing evidence id.
  A length removal must actually overflow the target if retained.
- Non-verbatim keeps become edits. Original/hand-edit labels are deterministic,
  using the latest history record's `approved: { personality, voice }` shape;
  unapproved kept sentences never acquire evidence links merely by being kept.
  Phase 4's writer must preserve that approved-text shape.
- Validation: `npm test` passed all **182 test files / 4,561 tests**, including
  **57 new Phase 2 tests**; `npm run lint` and `git diff --check` passed.
  Host QA remains Phase 5; Phase 3 must still supply guarded staging/accept and
  the first user-facing controls. No configured-model or SillyTavern host QA
  was performed in this phase.

**Phase 2 review fixes — 2026-11-10:**
- Drafting captures primitive dossier UID, entity ID and profile UID before the
  first await. Reads and the returned identity use those captured values; the
  live registry guard detects in-place UID/entity-ID mutations during I/O.
- Growth proposals cannot clear an existing non-empty Personality or Voice
  line: validation rejects the whole proposal with instructions to keep or
  replace at least one sentence. Already-empty lines may remain empty. This
  preserves ordinary scans' empty/null-as-no-change merger contract without
  accepting removals that cannot be applied. The drafting prompt states this
  restriction too.
- Ordered change-item outputs must equal the final line's split sentences,
  not just concatenate to its text. Appending after an unpunctuated fragment
  requires an evidence-backed edit that establishes a sentence boundary.
- Six added regression cases reproduced the defects before the fixes and pass
  afterward, covering both identity properties and both fields, including the
  validator-to-merger path and unchanged empty lines/fragments.
- Validation: `npm test` passed **182 files / 4,567 tests**; the focused drafting
  suite passed **63 tests**. `npm run lint` and `git diff --check` passed.
  No SillyTavern host or configured-model QA was performed.

### Phase 3 — Staging review and guarded accept

**Goal:** the complete approve/dismiss flow, safely.

- The draft action in the Growth window (option on + profile present; replaces
  any pending Growth item for that NPC); stage via
  `buildUpdatedDossierContent(current, { personality, voice })` with the
  change list and warnings attached.
- The diff gains the change-list panel, with evidence links and "no longer
  on file". Dismiss works as it does today.
- Accept & Write needs two changes:
  - **Growth items:** their own branch (§5.3). It always rebuilds onto the
    fresh entry and writes only the two lines.
  - **Scan items:** the §6 re-apply of Growth-owned lines on the edited and
    field-refresh branch, never over a reviewer's own edit of those lines.
- Accept All skips Growth items with a note, and its confirmation count
  excludes them. No auto-approval path consumes them.
- The switch, in the Growth window and on the NPC card, wired to the Phase 1
  state. It shows on or off. An NPC that was never set reads as off, with a
  note that Personality is still locked by evidence until a choice is made.
  The tooltip says what turning it off gives back to scans (§5.5).
- The per-NPC length limits beside the switch, with the token estimate
  (§5.4).
- Accept on a pending Growth item is disabled while the switch is off (§5.6).
- The 🎯 refresh message for a line over the scan limit (§5.6).
- This is the first point where any of this is user-visible.

**Exit gate:**
- jsdom workflow tests for draft, review, then accept or dismiss.
- Stale accepts in both directions, covering an intervening scan, a hand
  edit, and a field refresh. A Growth item accepted after a scan keeps the
  scan's fields and ledger lines.
- A pending Growth item can't be accepted while the switch is off, and can
  after it's turned back on.
- Edits outside the two lines in a Growth item are never written.
- Growth items are excluded from Accept All.
- Ownership follows the switch in the UI. On keeps scans off both lines. Off
  lets scans update both from the next scan.
- The limits round-trip and the token estimate updates.
- The manual-edit and accept-staleness suites pass unchanged.

### Phase 4 — Approval history and the echo warning

**Goal:** the look-back and the drift detector.

- Write one record per acceptance into `[MWT:growth-history]` (§5.8):
  - **Contents:** the date, the approved text and the change list. The
    pre-Growth text goes on the first record only.
  - **Key:** the registry `entityId`.
  - **Lineage:** stamped at acceptance. A `keep` sentence inherits its
    timestamp; an `edit`, `add` or no-evidence sentence is stamped at that
    acceptance.
  - **Cap:** 10 records, enforced on write.
  - **Merges:** handle an identity merge by concatenating by date and
    applying the cap again.
- Render the per-NPC history in the Growth window.
- Compute and display the echo flag in the change list. It fires when all
  supporting evidence is from messages written after the sentence's first
  approval: raw `ts`, consolidated `firstSeen`, no-time evidence neutral, and
  canon suppressing the flag (§5.9). It is advisory only.

**Exit gate:**
- The history round trip, cap enforcement at 10, and survival across a
  reload.
- A rename and a merge both keep the history.
- Lineage stays correct across a keep → edit chain.
- The echo flag fires and stays quiet correctly on the boundary cases, and
  never fires on no-evidence sentences.
- Evidence backfilled after an approval from messages written before it does
  not trigger the flag. Consolidated claims are judged by `firstSeen`. A
  sentence whose evidence has no usable time shows "timing unknown".
- No localStorage writes, pinned by test.
- The container's size at the cap is measured with the schema perf harness
  and recorded here.

### Phase 5 — Cross-path regression and release validation

**Goal:** prove the feature against everything that shares its seams.

- Full-matrix automated passes: scope modes × dossier on/off × switch
  never set/on/off × pending-proposal interplay. Then run `npm test`,
  `npm run lint` and `git diff --check`, and record the actual commands and
  outcomes.
- Host QA in SillyTavern:
  - The full flow with a configured model: profile → draft → diff → accept →
    scan → verify ownership → switch off → scan, confirming scans update
    both lines.
  - A Character-scope new chapter carrying the text, switch, limits and
    history.
  - A backfill after an approval that does not trip the echo flag, and a
    deliberately echoed trait that does.
  - A main-cast NPC at raised limits, checked against the World Info budget.
  - The explainer text.
  - Interiority's intentions picking up the approved lines (accepted in §6).
  - The history entry never appearing in the RP prompt.
- Update the documentation map, user-facing guidance, and CHANGELOG only with
  verified behavior; host QA is the release gate, not test counts.

**Exit gate:** every §10 criterion passes or is explicitly recorded as
pending, and both authors sign off before release.

## 13. Review record

**Revision 2, 2026-11-09.** A code review done before implementation checked
this scope against the working tree. The ownership seam list (§5.5) and its
line numbers were confirmed as accurate. Findings and where each is folded
in:

1. **The leaf rule was false today.** All three capture paths pass the whole
   dossier as `<existing_context>`, so approved lines would loop back into
   capture. Folded into: §5.10, §6, Phase 1. The first reply to the
   requester made the same wrong claim. After this fix it holds for the lines
   that matter.
2. **A stale Growth accept could undo an intervening scan.** The
   `refreshFields` branch keeps the whole stored entry, and the rebuild
   branch would null the item's own fields. Folded into: §5.3 (own accept
   branch), §6, Phase 3.
3. **The first draft had no approved baseline.** Keep-by-default would carry
   forward unchecked pre-tracking text, and §5.2 contradicted itself. Folded
   into: §5.2 (no-evidence labels, typology warning, resolved wording), §5.5,
   §5.8, §5.9.
4. **Interiority's intentions call reads the full dossier.** Decided:
   accepted. Folded into: §6, §7.7.
5. **History storage.** The store validator drops unknown top-level keys,
   and the store is serialized again on every registry or relationship save.
   Decided: 10 records, a dedicated `[MWT:growth-history]` entry, and the
   approved text only. Folded into: §4, §5.7, §5.8, §7.8, Phase 1, Phase 4.

Smaller corrections:

- Accept All's skip is a new rule; it didn't match an existing one.
- The drafting inputs need claims, not just ids.
- §5.5's helper replaces only the ownership seams.
- The `growthDossier` shape check must be a repair.
- `saveRegistry` does not merge.

**Revision 3, 2026-11-10.** The requester answered the plan with three
refinements (requirements 6–8). Each was checked against the code before
being folded in:

1. **The Personality lock follows the switch.** Accepted. We added one
   safeguard: a never-set switch keeps today's evidence-based lock, so
   upgrading doesn't let scans rewrite Personality lines users copied in by
   hand. `hasApprovedLines` is dropped, because an explicit switch setting
   now carries ownership across chapters. A pending Growth item can't be
   accepted while the switch is off. Folded into: §4, §5.1, §5.5, §5.6,
   §5.7, §6, §7.11–12, §10, Phases 1 and 3.
2. **The echo warning uses message time.** The mechanism already did this:
   `ts` is the cited message's send time, and backfill keeps the original's
   time. The wording ("captured after") was wrong, both here and in the first
   reply. Added: consolidated claims use `firstSeen`, evidence with no usable
   time is neutral, and canon is never an echo. Folded into: §4, §5.9, §7.14,
   §10, Phase 4.
3. **Per-NPC length limits.** Accepted, with defaults of 450/350 and a maximum
   of 1,500/1,000. The 900/600 caps are MWT's field contract, not a dossier
   limit, and the contract also runs inside `buildUpdatedDossierContent`. So
   the Growth path gets its own ceiling, and scans keep 900/600. Also added:
   a token estimate beside the limits, a `remove (length)` reason shown as
   `dropped to fit length`, and an explicit message when a 🎯 refresh meets a
   line over the scan limit. Folded into: §4, §5.1, §5.2, §5.3, §5.4, §5.6,
   §7.13, §9, §10, §11, Phases 2 and 3.

§8's open items are closed or settled by the requester's silence.
