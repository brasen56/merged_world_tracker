# 🛡️ Data Safety Guide

**What MWT 2.0's data work is, and what it means for you — explained without the jargon.**

> **Status:** This guide describes the data-safety work that **ships in
> MWT 2.0.0**. If you're on 2.0 or newer, everything here is already at
> work underneath your chats — nothing about your setup needs to change.
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
  **"Download recovery data"** button, which also records *where* the record
  belongs — so it can be repaired outside MWT and put back through the
  normal, checked path (see
  [Recovering a quarantined record](#recovering-a-quarantined-record)).

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
- A quarantined record won't be used by its module until you put it back
  ([here's how](#recovering-a-quarantined-record)) — but you'll always know
  it's there, and you can always get it back. You will never discover a
  missing entry by accident, weeks later.

The honest trade-off: a quarantined record is *inactive* until recovered. The
point of the system is that "inactive and recoverable" replaces the old
possible outcomes — "silently skipped," "behaves weirdly," or "corrupts
something nearby."

---

## Recovering a quarantined record

Recovering a record is a deliberate, manual edit — MWT will never guess at a
repair on your behalf. It takes five steps, and you need a text editor.

**One thing to know first:** the "Download recovery data" file is **evidence,
not a restore file.** Handing it straight to Restore is rejected
(*"Unrecognized backup type"*) — it doesn't describe a chat, it describes the
records that were set aside. What it gives you is each record *plus the
address it came from*.

**1. See what's quarantined.** Diagnostics → 🗂️ Scope & storage shows the
per-store counts, and each record carries the reason it was set aside.

**2. Download the recovery data.** Backup → 🧯 **Download recovery data**
(or `MWT.recovery.export()` in the browser console). Each entry under `items`
carries:

| Field | What it tells you |
|---|---|
| `store` | which module's data it belongs to (e.g. `worldState`) |
| `path` | where inside that store it sat |
| `raw` | the record itself, exactly as it was found |
| `message` | why it was rejected — this is your repair instruction |
| `detectedAt`, `sourceVersion`, `fingerprint` | when it was set aside, and from which format |

**3. Repair the record.** Edit `raw` until it matches what `message` says was
wrong — a missing field, a number stored as text, a date that isn't one.

**4. Put it back through a backup.** Export a fresh backup (Backup →
⬇ Export Backup) and open it in your text editor. Each entry under `sections`
is a small **wrapper** around the real data — the records do not sit directly
on the section:

```json
"sections": {
  "chronicle":      { "schemaVersion": 1, "data": { "… that store's records …": {} } },
  "knowledgeStore": { "storeVersion": 1, "data": { "…": {} } }
}
```

Place the repaired record **inside the `data`** of the entry named by its
`store`, at the position named by its `path` — a record with
`store: "chronicle"` and `path: ["snapshots", 3]` belongs at
`sections.chronicle.data.snapshots[3]`. (The `knowledgeStore` wrapper is the
one naming exception: it says `storeVersion` where the others say
`schemaVersion`.) Placing the record anywhere else — for example as a sibling
*next to* `data` on the section entry — will be silently ignored by the
restore: only what sits beneath `data` is read. Restore that backup. This is
the "normal, checked path": your repair is validated on the way in exactly
like every other record, so a fix that's still wrong gets caught rather than
trusted.

> Pasting the record into the backup's own `quarantine` field instead will
> **not** bring it back. That field is bookkeeping — a restore deliberately
> merges it back into quarantine, so records rejected in one chat aren't lost
> when you restore another.

**5. Clear the old copy.** The original stays quarantined until you remove it.
In the browser console:

```js
MWT.recovery.status()                                          // check what's there (both homes — see below)
MWT.recovery.clear({ confirm: 'CLEAR' })                       // clear this chat/session
MWT.recovery.clear({ confirm: 'CLEAR', store: 'worldState' })  // …or just one store
```

**Two homes, one option worth knowing about.** By default, the clear commands
above empty only the **chat-local quarantine container** — this chat's
records. Knowledge records are *also* embedded in each lorebook's own
recovery container (shared and global books carry their own), and those stay
exactly where they are unless you explicitly ask:

```js
MWT.recovery.clear({ confirm: 'CLEAR', includeKnowledgeStore: true })
```

That empties the embedded container of **every lorebook MWT currently has
loaded** — including records that other chats placed in those same books —
so run `MWT.recovery.status()` first (it lists both homes, with per-book
counts) and keep the export from step 2. Lorebooks that aren't currently
loaded keep their records; they'll show up in `status()` again the next time
they're opened.

Clearing **deletes MWT's only copy** of those records, so keep the file from
step 2. The typed `'CLEAR'` is the confirmation — a dialog can be dismissed by
accident, a typed argument can't.

### Or: do nothing

This is a perfectly good option. A quarantined record is *inactive*, not lost.
It stays in the drawer, it keeps riding along in every backup you make, and
you can come back to it whenever — or never. Nothing degrades while it sits
there.

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

## What about settings and other browser-stored bits?

The same idea covers the smaller things MWT saves outside your chats: your
settings (global and per-module), floating-button positions, Knowledge
edit-history lists, and the invisible per-message ID stamps Interiority uses
to keep thoughts attached to the right messages. From 2.0 these are checked
too — with one deliberate difference: they are **config, not story data**, so
they fail *open*. A damaged settings record quietly falls back to its
defaults (and says so in the 📋 Log), a damaged position or history record is
filtered from the view until the next save rewrites it, and nothing ever
pauses a module or deletes what's stored. Settings saved by a newer MWT are
read as-is rather than rewritten.

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
| **Recovery export** | A "Download recovery data" file containing quarantined records *and the address each one came from*. It is evidence, not a restore file — you repair a record and put it back via a backup. |
| **Diagnostics** | MWT's built-in, read-only panel where versions, module states, and quarantine counts are shown. |

---

## Want the full technical version?

The complete engineering plan — contracts, performance budgets, test matrix,
and delivery order — lives in
[`upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md`](upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md).