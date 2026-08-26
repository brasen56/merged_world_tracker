# 🛡️ Data Safety Guide

**What MWT 2.0's data work is, and what it means for you — explained without the jargon.**

> **Status:** This guide describes the data-safety work planned for **MWT 2.0**.
> The version you're running today doesn't work this way yet, and nothing about
> your setup needs to change right now. This page exists so that when 2.0
> arrives, you already know what it does, why it exists, and what you'll
> (mostly not) see.
>
> No coding knowledge is needed for any of this. If a word here is new to you,
> jump to the [glossary](#glossary-plain-words) at the bottom.

---

## The short version

MWT saves a lot for you — world state documents, chronicle entries, NPC
knowledge evidence, story plans, interiority ledgers. Today it *trusts* that
this saved data is in exactly the shape it expects. MWT 2.0 adds a safety layer
underneath all of it: saved data gets **checked** before it's used, old chats
**upgrade themselves automatically** the first time you open them, and a record
MWT can't safely understand gets **set aside for recovery** instead of being
skipped, mangled, or fed to the AI.

You don't have to do anything. Old chats keep working. Your writing is never
touched. Nothing is ever thrown away silently.

---

## Why build this at all?

MWT has grown a lot, and the *shape* of what it saves has changed along the
way — a chronicle entry saved a year ago doesn't look quite like one saved
today. A few quiet cleanups for this already happen today, scattered around
the extension, the first time old data is opened.

That works fine — right up until something goes wrong. Saved data can arrive
damaged: an import that went sideways, a save that was interrupted, a bug, an
accidental hand-edit, or a chat that was touched by a different MWT version.
When that happens, the extension today has no consistent way to notice. It
might ignore a bad record, behave oddly, or seem to "forget" something — and
by the time anyone notices, the real cause is very hard to trace.

2.0 replaces *trust* with *checking*: data is examined at the door, old data is
brought up to date by one documented, tested procedure, and anything unusable
is kept where you can see it and get it back. It's also the foundation that
lets every future MWT version upgrade your data safely — instead of ever
asking you to start over.

---

## The four ideas

### 1. A version label on everything MWT saves

Each kind of data MWT stores gets a small label recording which *format
version* it's in — like a "last revised" stamp on a document. Old chats simply
have older stamps. That's not a problem; it's information.

### 2. Checking data at the door

Before MWT *uses* saved data — when a chat opens, when you import something,
when you restore a backup — that data is checked against a description of what
it should look like: every expected field present, every date a real date,
every ID unique. Think of a doorman checking that forms were filled in
properly before letting them into the building. Good data passes through
untouched.

### 3. Old data upgrades itself

The first time you open a chat after updating to 2.0, any part of its data
still in an older format is converted to the current format — automatically,
once, by a tested procedure rather than scattered patch-up code. If a chat
never used a module, nothing is created for it; chats you never open are never
touched at all.

It's also built to be interrupted safely: switch chats or close the page
mid-upgrade, and the upgrade simply re-runs cleanly the next time you open
that chat. It can't leave data half-converted.

### 4. A lost-and-found drawer for problem records

If a single record can't be safely understood — one damaged chronicle entry
among a hundred good ones, say — it is **not** deleted, and **not** silently
skipped the way older versions sometimes did. It goes into a holding area
called **quarantine**, where:

- it's kept whole, exactly as it was found;
- it's counted and listed for you, with the reason it was set aside;
- it is never sent to the AI's prompt;
- it's included in MWT backups, and can be exported any time with a
  **"Download recovery data"** button, so it can be repaired outside MWT and
  imported back through the normal, checked path.

The other ninety-nine entries keep working normally.

---

## What happens to my old chats when I update?

1. You update MWT. No setup, no buttons, no conversion tool.
2. You open a chat. MWT reads the little version labels in that chat's data.
3. **Data already current** → nothing happens. You notice nothing.
4. **Data in an older format** → it's upgraded on the spot. This is normally
   instant; if a particular upgrade would ever take meaningfully longer, that
   one module shows a brief, visible "preparing…" state instead of freezing
   anything or working half-upgraded.
5. **A record with a problem** → that record is quarantined and reported; the
   rest of the module works normally.
6. **Data MWT genuinely cannot read safely** (rare) → that one module pauses
   with a clear banner (see below), and your data is left **exactly** as it
   was.

Each chat is handled separately, the first time you open it. Chats you never
open are never touched.

---

## Will I lose anything?

No — and the design makes *silent* loss impossible. Concretely:

- Records that fail checking are **preserved** in quarantine, whole, with the
  reason they were rejected — not dropped on the floor.
- Quarantined records are **included in backups** and exportable at any time.
- A quarantined record won't be used by its module until you restore or
  re-import it — but you'll always know it's there, and you can always get it
  back. You will never discover a missing entry by accident, weeks later.

The honest trade-off: a quarantined record is *inactive* until recovered. The
point of the system is that "inactive and recoverable" replaces the old
possible outcomes — "silently skipped," "behaves weirdly," or "corrupts
something nearby."

---

## What's the worst that can happen?

If MWT finds saved data it can't safely upgrade *or* safely set aside — for
example, your browser's storage is completely full, so there's no room to keep
a recovery copy — it pauses **that one module**. Never all of MWT.

A paused module:

- stops writing or injecting anything for that chat — it declines its own work
  rather than risk using data it can't trust;
- leaves the **other modules running normally**;
- shows a prominent banner in **its own tab**, with the same reason listed
  under 🗂️ Scope & storage and ❤️ Health in Diagnostics;
- notifies you **once** per chat — not a toast on every message;
- keeps your original data **untouched**, and offers **Retry** and a recovery
  export right there in its tab.

The banner looks like this:

> Knowledge is paused for this chat because MWT found invalid saved data but
> could not safely store a recovery copy. Your original data was not changed.
> Free some storage or export a backup, then retry.

Pausing is loud on purpose. A module that quietly stopped working looks
exactly like a module with nothing to do — and "the AI forgot everything" is a
much worse mystery than a banner that says what happened and what to do about
it.

---

## Will it make anything slower?

No. The everyday check is just reading a few version labels — far too fast to
notice, with measured speed budgets behind it. The thorough,
record-by-record check only runs when you ask for it, from the Diagnostics
panel. Nothing scans your whole history in the background on every message.

## What about my writing and my lorebooks?

Not touched. This system checks **MWT's own bookkeeping structures** — the
machinery that organizes entries, IDs, counts, and settings. Your prose, your
lorebook dossier text, your state entries, your chronicle text are *content*,
not structure, and they are never judged or rewritten. Data owned by other
extensions is never rewritten by MWT either.

The one lorebook piece involved is the `[MWT:store]` bookkeeping entry (see
the README) — it gets the same versioning and checking, and each book carries
its own recovery drawer, so shared and global books are protected too.

## What if the data is newer than my MWT?

From 2.0 onward, if MWT opens a chat or imports a backup that was saved by a
**newer** MWT than the one you're running, you'll get a clear refusal — and
the data is left exactly as it was. MWT never guesses, never half-reads, and
never "downgrades" data it doesn't fully understand.

## Do I need to do anything?

No. Everything above is automatic. The one good habit worth keeping: **export
a full MWT backup before updating** (and before rolling back to an older
version, if you ever do). That has always been good practice, and it makes any
update — this one included — fully recoverable from your side.

---

## Quick answers

| Question | Answer |
|---|---|
| Will updating delete my data? | No. Records that fail checking are quarantined — preserved, counted, exportable — never silently deleted. |
| Do I have to convert my chats myself? | No. Each chat upgrades itself, automatically, the first time you open it. |
| Can quarantined data reach the AI's prompt? | Never. |
| Can one broken module break the others? | No. A problem pauses only its own module, visibly, with a banner and a Retry. |
| Will I notice any of this running? | Almost never. At most a one-time banner, or a brief "preparing…" note in one module. |
| Is my writing checked or changed? | No. Only MWT's own saved structures — never your prose or lorebook content. |
| What if I roll back to an older MWT? | Keep the backup you made before updating. Versions older than 2.0 predate this system, so rolling back isn't a guaranteed path for chats that were already upgraded. |

---

## Glossary (plain words)

| Term | Plain meaning |
|---|---|
| **Schema** | A written-down description of what a piece of saved data should look like — which fields exist and what type each is. |
| **Validation** | Checking saved data against that description before MWT uses it. |
| **Version label** | A small number stored alongside data, recording which format it's in. |
| **Migration** | An automatic, one-time, tested procedure that converts older-format data to the current format. |
| **Quarantine** | The lost-and-found drawer: records that failed checking are kept whole, counted, listed with a reason, never injected, and exportable. |
| **Paused (blocked) store** | The safety state where one module visibly stops itself rather than use data it can't trust. Other modules are unaffected. |
| **Recovery export** | A "Download recovery data" file containing quarantined records, so they can be repaired and re-imported through the normal checked path. |
| **Diagnostics** | MWT's built-in, read-only panel where versions, module states, and quarantine counts are shown. |

---

## Want the full technical version?

The complete engineering plan — contracts, performance budgets, test matrix,
and delivery order — lives in
[`upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md`](upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md).