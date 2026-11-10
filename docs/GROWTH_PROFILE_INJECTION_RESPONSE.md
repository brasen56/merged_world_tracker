# Growth profiles in the dossier: reply to the feature request

**Status:** First reply sent 2026-11-08. The tester answered on 2026-11-09, our plan went out the same day, and they answered it on 2026-11-10 (all recorded below). Nothing built. The plan and implementation notes below are developed into a buildable scope in [GROWTH_PROFILE_INJECTION_SCOPE.md](./GROWTH_PROFILE_INJECTION_SCOPE.md); this file remains the correspondence record.
**Request received:** 2026-11-08. A tester asked for a per-NPC option to use the latest approved Growth profile as the dossier's personality and voice, plus a change tracker for reviewing each update.

The tester's answer settled the shape. Growth rewrites the Personality and Voice text itself, you approve it in Staging, and regular scans keep updating every other field. Where they differ, the [plan](#our-plan-sent-2026-11-09) replaces "What we'd build" below.

An earlier draft of this follow-up put Growth notes in a separate section instead. We dropped it before sending, because the frozen Personality line would have stayed in the prompt right next to notes saying the character had changed.

---

Thanks for writing this up. The problem is real, and the request is worth building. It won't work exactly as written, though, so here's why, what we'd build instead, and a few questions.

## Why you're copying by hand today

- **The dossier's `Personality:` line freezes.** Once an NPC has Growth evidence, Knowledge scans stop updating that line, so the Growth system and the scan never rewrite each other's work. The line stays at whatever it said when tracking began. (The Growth window says this happens "once an NPC has a growth profile". It actually happens at the first evidence capture. We'll fix that text.)
- **The profile never reaches the RP prompt.** It's saved to the "NPC Profiles" lorebook with no keywords, so SillyTavern never triggers it. Its only reader is Interiority's thoughts call. This was on purpose: the profile was meant as a mirror for you to read, not something that steers the story.

Together, these mean the growth you approve never reaches the roleplay unless you paste it into the dossier yourself. With six main characters and around 30 NPCs, that's a fair complaint.

## Why we won't inject the profile text as it is

1. **It quotes past scenes.** The profile is written to back each trait with the character's actual words. In the RP prompt, those quotes turn into catchphrases: the model starts repeating old lines instead of writing new ones.
2. **It's too long for the slot.** A profile is 2–4 paragraphs. Dossier fields are one line each (`Personality: …`, `Voice: …`), which is the format the scan and the entry editor read. Pasting a few paragraphs per NPC would add hundreds of tokens for every NPC active in a scene.
3. **It can feed on itself.** Once the profile is in the prompt, the model plays the NPC that way, evidence capture records that behavior, and the next profile confirms it. Each round makes the character a little more of a type. Your approval step is the right brake, and the tracker below is built to support it.

## What we'd build

1. **A per-NPC switch, "Use approved profile in dossier".** Off by default. It sits in the Growth window and on the NPC's card.
2. **Dossier lines made from the profile.** After you generate a profile, a "Prepare dossier lines" button turns it into one `Personality:` line and one `Voice:` line. The lines contain no quotes, no scene references and no type labels, and their length is capped. Each trait records which observations it's based on. This is one model call.
3. **Review in the existing diff view.** The proposed lines go to the staging tab, the same Current / Changes (diff) / Proposed / Accept & Write view that dossier updates and field refreshes already use. Accept & Write is the approval. Only the Personality and Voice lines change. Canon Lock, the Knowledge Ledger and every other field are kept exactly as they are.
4. **The approved version stays live while you review.** Nothing in the dossier changes until you accept. Dismiss leaves everything as it was.
5. **A change tracker next to the diff.** It lists traits that were added, removed or reworded since the last approved version. Each trait links to the observations behind it in the Growth window, or says "no longer on file" if that evidence was deleted.
6. **An echo warning.** A trait gets flagged when all of its supporting evidence was captured *after* that trait was first approved into the dossier. That evidence may just be the model following its own dossier rather than the character actually changing. This is the "accidental drift" you said you wanted to catch.
7. **Voice moves over with Personality.** With the switch on, scans stop updating `Voice:` for that NPC, the same way they already leave `Personality:` alone. Without this, the next scan would overwrite your approved voice. With the switch off, scans update Voice as they do today.
8. **A short approval history per NPC.** It keeps the last few approved versions with dates, so you can roll back an approval you regret.

**What stays the same:** evidence capture still reads only the RP transcript and never reads the profile or the dossier lines. The full profile prose and Psychoanalyze work as they do now and are still never injected.

## Questions for you

1. **The change tracker.** By "the existing character-change tracker", did you mean the diff view shown when a dossier update is waiting for review? That's what we plan to reuse.
2. **Voice.** With the switch on, new speech habits would only reach the dossier when you approve them, not through regular scans. Is that what you want?
3. **Switching off.** If you turn the option off for an NPC, should the dossier keep the last approved lines, or go back to the lines it had before you turned it on?
4. **One chat or several?** Growth evidence is stored per chat, and the approval history would be too. If your campaign spans several chats, the history would start over in each one. Is that a problem for you?

---

## Follow-up: the tester's answer and our plan

### Their answer (received 2026-11-09, recorded verbatim)

> Thanks! I like the idea of generating a compact dossier update from the Growth profile and sending it to Staging. I'd like to keep the current dossier and regular scans, with approved Growth notes adding detail to the fields they apply to.
>
> 1. Change tracker — Yes, I meant the existing Staging diff. It would be helpful to see which Growth notes are being added, edited, or replaced before I approve them. A per-NPC history of approved changes would also be nice so I can look back at how the character evolved.
>
> 2. Regular scans — While the option is on, I'd like regular scans to keep updating the base dossier fields. Growth notes would go through Staging, and scans would preserve them once approved. When the dossier activates, the approved notes should be included in the RP prompt alongside the relevant fields.
>
> 3. Turning the option off — Keep the current approved Growth changes in the dossier when I turn it off. Starting with the next regular scan, the scanner can update those fields in its usual format, just as it did before I enabled the Growth option.
>
> 4. Chat or character scope — Could the approved notes and their change history follow the existing Knowledge → Lorebook Scope setting? With Chat scope, they'd stay in that chat. With Character scope, they'd carry over when I start another chapter with the same card. The raw evidence can stay in the chat where it was captured.
>
> 5. How much detail — The Staging workflow is the level of control I want. I'd like room for two or three short lines per affected field. Personality could capture what changed and when the NPC still falls back on an old habit. Voice could capture their usual speech patterns and how those shift under pressure. This could apply to any dossier field where Growth has something meaningful to add. If the existing fields need to stay single-line for the scanner and editor, a small Growth section under each affected field would work for me. The original quotes can stay in the evidence view.

### Our plan (sent 2026-11-09)

Thanks, that settles it. Here's the plan.

**How it works**

1. **A per-NPC option, "Use Growth in dossier".** It's off by default and sits in the Growth window and on the NPC's card.
2. **Growth proposes new Personality and Voice text.** After you generate a profile for that NPC, MWT drafts updated Personality and Voice text from it and sends it to Staging. You see the current and proposed text in the usual diff, with the observations behind each change listed underneath. Accept & Write approves it. Dismiss leaves the dossier as it is. The current approved text stays in use until you accept a new version.
3. **Scans keep the rest of the dossier.** While the option is on, regular scans keep updating every other field and the Knowledge Ledger as usual. They leave Personality and Voice alone, so they never overwrite what you approved. New speech habits reach Voice through Growth updates rather than scans. If you'd rather scans kept updating Voice too, let us know. That was the one part of your answer we weren't sure about.
4. **A history per NPC.** Each approval is saved with its date and the before-and-after text, so you can look back at how the character changed.

**What the text looks like**

Each field has to stay on a single line, because the scanner and editor read one line per field. The line can still hold two or three short sentences. There's already room: Personality can hold 900 characters and Voice 600. We'll aim well under that, about 450 for Personality and 350 for Voice, so the dossier doesn't get heavier with every update.

To fit "what changed" and "old habits" into that without the line growing:

- **It describes the NPC as they are now, not their history.** The model needs to know how the NPC behaves today, not the story of how they got there. What changed and when is recorded in the Staging diff and the history, where you can read it.
- **An old habit is written as a condition.** "Still goes quiet and over-polite when an officer raises their voice" says both that the habit is still there and when it comes back, in one clause. It's only included when the evidence shows the habit coming back after the change.
- **Updates edit the text rather than add to it.** A change rewrites the sentence it affects. Anything the new evidence doesn't address stays word for word. If something new has to go in and the line is already at its length target, the sentence with the weakest support gets merged or dropped, and the diff shows you exactly that.
- **No quotes.** The text describes patterns instead of repeating the character's words, so the model doesn't turn them into catchphrases. The quotes stay in the evidence view.

For example:

```
Personality: Owns mistakes in front of the crew now and asks for help with the ledgers. Still goes quiet and over-polite when an officer raises their voice. Slow to trust, but keeps every promise made.
Voice: Plain, short sentences; drops formal titles with friends. Under pressure, slips back into clipped parade-ground orders.
```

**Turning the option off.** The approved text stays where it is, and nothing reverts. From the next regular scan, Voice is updated in the scanner's usual style again. Personality stays as Growth left it, because scans already leave Personality alone for any NPC with Growth evidence. That's how it works today, with or without this option.

**Scope.** The option and the history are stored with the NPC registry in the Knowledge lorebook, and the approved text is part of the dossier itself. So all of it follows your Lorebook Scope setting. With Character scope, a new chapter brings the approved text, the option and the history along. Evidence stays in the chat where it was captured, so the first Growth update in a new chapter only sees that chapter's evidence. It won't treat missing evidence as a change: anything the new evidence doesn't address stays as it is.

**Echo warning.** This carries over from our first reply. A sentence gets flagged when all the evidence behind it was captured after that sentence was first approved. That can mean the model is copying the dossier rather than the character actually changing.

### Their answer to the plan (received 2026-11-10, recorded verbatim)

> 1. Turning the switch off — I'd keep the last approved Personality and Voice text in the dossier and let regular scans update both fields in their usual format from the next scan onward. Capturing Growth evidence by itself doesn't update the dossier. If having evidence is enough to keep Personality locked with the switch off, that field can go stale even while Growth keeps collecting observations. Could the lock depend on the switch, so I can keep the evidence and let regular scans update Personality again?
>
> 2. Echo warning — Could it use the timestamp of the original RP message? I'm backfilling older scenes, so evidence captured after an approval can still come from a message written before it. A warning in Staging that leaves the approval decision to me would work well.
>
> 3. Separate length settings in the UI — Could I set the character limits for Personality and Voice independently for each NPC? The 450/350 defaults sound good. For the main cast, I'd like the option to go beyond 900/600 if the dossier can support it, perhaps up to 1,500/1,000. I want enough room to keep the details Growth picked up about how a character acts and speaks in different situations, especially when a new development would otherwise push out an established detail.

All three are folded into the scope doc as revision 3. See its §2 (requirements 6–8) and §13.

### Implementation notes (internal, not for the tester)

*Superseded by [GROWTH_PROFILE_INJECTION_SCOPE.md](./GROWTH_PROFILE_INJECTION_SCOPE.md), which corrects several of these notes (history storage, ownership, echo timing). They're kept as the record of what was written on 2026-11-09.*

- **Ownership.** Growth owns Personality when `hasEvidenceFile(name)` is true, or when the option is on or approved Growth text exists. It owns Voice only while the option is on. Store the flag in the NPC's registry record in `[MWT:store]` (`knowledge/store.js`), not in chat metadata. `hasEvidenceFile` (`knowledge/evidence.js:276`) reads chat metadata, so in a new Character-scope chat the freeze would lift and scans would start rewriting Personality. Most paths go through `applyFieldOwnership` (`knowledge/field_ownership.js`), called from `knowledge/staging.js:170`, `:243`, `:256`, `:270`, `:280` and `knowledge/lorebook.js:966`, `:989`, `:1650`. Three sites check `hasEvidenceFile` directly: `knowledge/lorebook.js:1549` (single-NPC update), `:1696` (field-refresh sanitizer) and `knowledge/render.js:2140` (field-refresh picker).
- **Proposal step.** One model call. Inputs: the new profile, the current Personality and Voice lines, Canon Lock, canon observations, and observation ids with timestamps. Output: the two lines plus a per-sentence change list (`keep | edit | add | remove`, with evidence ids). `keep` is the default, and `edit` and `remove` need new evidence. Validate through the field contract (single line, 900/600 caps) and then the length targets. Stage it the way a 🎯 Fields refresh is staged: `buildUpdatedDossierContent(current, { personality, voice })` leaves every other line as it is. Never feed its output back into capture or profile generation (the leaf rule).
- **Stale accepts.** Accept & Write refuses a proposal whose entry changed after the proposal was built (`knowledge/render.js:110-139`). For an untouched scan item, the guard re-merges the fields onto the fresh entry, and ownership keeps Personality and Voice out, so the Growth text survives. A reviewer-edited or field-refresh item keeps its own full text instead (`:113-115`), so its second Accept would write the pre-Growth Personality and Voice back. Fix: re-apply the current Growth-owned lines at accept, the same way the relationship block is re-applied at `:146`.
- **History.** Store it per NPC in `[MWT:store]` with a cap, for example the last 20 approvals (date, before, after, change list). Never store it in localStorage (that's the `kt_history` quota problem).
- **Echo flag.** For each sentence, compare the `ts` of every supporting observation with the time the sentence was first approved, taken from the history.
- **Standalone fix.** Correct the Growth window's explanation (`knowledge/render.js:1379`): Personality freezes at the first evidence capture, not when a profile is saved.
