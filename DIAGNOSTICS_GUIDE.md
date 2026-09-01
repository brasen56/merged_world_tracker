# 🩺 MWT Diagnostics — Beginner's Guide

> Something in MWT acting weird? This guide shows you how to look inside MWT
> and share what you find in a bug report — **no technical background
> needed**. Everything here is read-only: you cannot break your chats, your
> data, or your settings by looking.
>
> This is the friendly front door. The full per-command manual is
> [`DIAGNOSTICS_CONSOLE_GUIDE.md`](DIAGNOSTICS_CONSOLE_GUIDE.md).

## What "diagnostics" is, in one breath

MWT keeps a private **flight recorder** — think airplane black box. While you
use it, it quietly notes what it did: every AI call it made, every snippet it
added to the narrator's prompt, every time it silently recovered from a
hiccup. None of it is saved anywhere permanent; it all lives in memory and
**vanishes the moment you reload the page**.

You look at that recording in one of two ways:

| Way | What it is | Best for |
|---|---|---|
| **🩺 The Diagnostics panel** | A tab inside the normal MWT window | Everyone. No tools, no code, works on mobile. |
| **The browser console** | Commands typed into your browser's developer panel | Power users who want the deepest view. Desktop only. |

**Start with the panel.** Only reach for the console if someone asks for it.

### The golden rule: break it first, *then* look

Because the recording is wiped on reload, the order is always:

1. Make the weird thing happen (send the message, click the button, trigger
   the bug).
2. **Without reloading the page**, open diagnostics and copy the report.

Capture too early and the interesting part may not be in the recording yet.

## The easy way: the 🩺 Diagnostics panel

### Opening it

Open MWT the way you always do — click one of the floating buttons
(🌍 📜 🧠 🗺️ 💭 ⚙️), or use the **MWT** entry in the wand (extensions) menu,
or the drawer in the Extensions panel — then click the **🩺 Diagnostics**
tab.

> **Don't see a 🩺 tab?** Update MWT to the latest version. The tab arrived
> in v1.7.2 and was completed in v1.7.9; this guide describes the finished
> panel.

### The seven sub-tabs — each answers one question

| Sub-tab | It answers… |
|---|---|
| ❤️ **Health** | "Is anything broken right now?" One row per module: is it on, may it inject, when did it last run, and did that run succeed? |
| 🌐 **Environment** | "Which SillyTavern am I on, and does it have everything MWT needs?" Matters most on customized ("fork") builds. |
| 🗂️ **Scope & storage** | "Which lorebooks is this chat using, and why?" The go-to for "my data is weird across chats". |
| 💉 **Injection** | "What is MWT putting in the narrator's prompt, where, and why?" |
| 📡 **Last request** | "What did the last AI call look like?" Duration, retries, status, token usage — never the prompt text itself. |
| 📋 **Log** | "What has MWT been doing this session?" A timeline, newest first. |
| 🛡️ **Integrity** | "Does my stored data reference things that actually exist?" Duplicates, dangling pointers, deleted things that came back. **Press ▶ Run** — it only checks when asked. |

Colored banners are shortcuts: **red** means something needs attention,
**amber** means "know about this", and no banner means fine.

### The content checkbox and 📋 Copy Report

At the bottom of the tab you'll find a checkbox and the **📋 Copy Report**
button:

- The checkbox controls whether the **text of your RP** (prompt bodies,
  injected payloads, notification text, full error text) is included in the
  report. It **starts unchecked every session**, on purpose.
- **📋 Copy Report** builds a text summary of everything diagnostics knows and
  puts it on your clipboard, ready to paste into a bug report. Secrets — API
  keys, custom header values, your API URL — are **always removed**, checkbox
  or no checkbox.
- Only tick the checkbox if asked: a maintainer may need the actual payload
  text to debug what the AI received. If you tick it, the report contains
  chat text, so paste it only where you're comfortable sharing that.

### Sharing the report safely

Even with content excluded, two kinds of personal text can still appear: your
**character and chat names** (part of how MWT stores data) and your
model/profile **names**. Skim once before pasting somewhere public; for a
private report to the developer, paste as-is.

## "My problem is…" — where to look

| If your problem is… | Look at | Why |
|---|---|---|
| "Nothing is injecting / a module went silent" | ❤️ Health, then 💉 Injection | A **panic switch** left on explains most of these on its own — Health calls it out loudly. Injection then shows what is actually registered. |
| "The AI isn't responding / responds weirdly / times out" | 📡 Last request | The real outcome of the last call: status, retries, duration, tokens. Health's last-run column shows *when* each module last ran. |
| "My data is weird in one chat but fine in another" | 🗂️ Scope & storage | Shows which lorebooks this chat resolves to. The classic cause: scope fell back to the *global* books (there's a banner for exactly this). |
| "Duplicate NPC profiles / profiles regenerate oddly / deleted intentions reappear / a backup import refuses records" | 🛡️ Integrity → ▶ Run | Checks that stored data references things that exist. |
| "A notification flashed and vanished" or "what did MWT just do?" | 📋 Log | The session timeline. |
| "The setting is right but behaves wrong" | Copy Report → settings section | Shows where each setting *actually* comes from — often a different level than the one you edited. |
| "Token counts look wrong" | 🌐 Environment + ❤️ Health | Environment shows whether a real tokenizer answered; Health shows each module's estimated token load. |
| "I'm on a fork / custom SillyTavern build" | 🌐 Environment | States the compatibility verdict — include it in every report from that build. |
| "Knowledge won't create entries / writes fail" | 🗂️ Scope & storage, 🌐 Environment | Scope flags an unloaded store (its one red finding); Environment shows SillyTavern's world-info module state. |

**Overwhelmed? Just press 📋 Copy Report and paste it.** The report contains
all of these sections anyway.

## What a healthy MWT looks like

So you can tell "fine" from "found it":

- **❤️ Health** — every module you use is `on`, last runs say `ok`. A `never`
  right after a page reload is normal; the recorder starts empty.
- **📋 Log** — no `warn` or `error` rows. A quiet log is the goal. Recovery
  entries log as `warn` — one or two isn't a crisis, but they often explain
  "weird" data. (MWT 2.0 also logs its data-layer events here — one
  `schema_settings_invalid` / `schema_repaired` row means a settings record
  or browser-local record failed checking and was safely handled; the same
  row never repeats twice in a session.)
- **🗂️ Scope & storage** — mode is `global`, `saved-binding`, or
  `newly-derived`. The amber "Knowledge injects through lorebook entries"
  note is **always** shown; it's informational, not an error.
- **💉 Injection** — modules you use show a recent registration. `tokens`
  reading `est.` just means nothing has registered yet this session.
- **🛡️ Integrity** — every check count is 0.

## The deep way: the browser console (optional)

The panel is a window; the console (`MWT.diagnostics`) is the workshop. Same
data, more of it — and a couple of raw views the panel deliberately shows
only in cleaned-up form. **Desktop browsers only**: there is no console to
open on mobile, which is a big part of why the panel exists.

### Sixty-second console primer

1. Press **F12** (or right-click the page → *Inspect*). A developer panel
   opens — every desktop browser has one.
2. Click the **Console** tab.
3. Type or paste a command and press **Enter**. Try `MWT.diagnostics` first —
   it lists every available command, like a menu.
4. Commands print a tidy table **and** return the full data underneath it.
   Click the returned object to expand the nested detail the table hides.

Three quirks worth knowing before anything else:

- **`MWT.diagnostics` says `undefined`?** MWT isn't running in this tab or is
  an old version. Reload the page once (it was just installed/updated), make
  sure the extension is enabled and up to date, then try again.
- **Some commands are "slow"** — they wait on SillyTavern before answering:
  `environment()`, `integrity()`, and `report()`. Type **`await`** in front,
  e.g. `await MWT.diagnostics.environment()`, or you'll just see
  `Promise { <pending> }`, which is the browser saying "working on it".
- **`copy(...)` puts things on your clipboard.** It's a helper built into
  browser developer consoles: `copy(await MWT.diagnostics.report())` gives
  you exactly what the 📋 Copy Report button copies.

### The two commands worth knowing

```js
MWT.diagnostics.health()              // one table: "is anything broken right now?"
copy(await MWT.diagnostics.report())  // the full report, on your clipboard
```

Everything else is a per-topic deep dive, each documented column-by-column in
[`DIAGNOSTICS_CONSOLE_GUIDE.md`](DIAGNOSTICS_CONSOLE_GUIDE.md).

### A console-only caution

Two console commands show **unredacted** data. They exist so you can *read*
exactly what was registered — not so you can paste it blind:

- `MWT.diagnostics.events()` — the raw session log, including notification
  text and error bodies.
- `MWT.diagnostics.injection(key)` — the exact text of one injected payload.

Fine to read, fine to share privately once you've skimmed them; don't
blind-paste them somewhere public. Everything else on the console — including
the report — is redacted by default, exactly like the panel.

## Plain-words glossary

| Term | Plain meaning |
|---|---|
| **API call** | One request MWT sends to your AI. |
| **Console / devtools** | The developer panel built into desktop browsers (F12). |
| **Injection** | Text MWT adds to the prompt the narrator AI sees. |
| **In-memory** | Kept only until the page reloads — never written to your chat or settings. |
| **Lorebook (World Info)** | SillyTavern's keyword-activated background notes; where MWT stores some data. |
| **Module** | One of MWT's five trackers: World State, Chronicle, Knowledge, Story Planner, Interiority. |
| **Panic switch** | The master off-switch for all MWT injections. |
| **Provenance / "source"** | Which level a setting actually came from: per-chat, global, or built-in default. |
| **Redaction** | Automatically removing secrets (API keys, header values, API URL) before data is shown or copied. |
| **Fork** | A customized / modified copy of SillyTavern. |
| **Async / `await`** | "This takes a moment" — prefix the command with `await` or you get `Promise { <pending> }`. |
| **Registration vs placement** | MWT handing text to SillyTavern proves the handoff happened — not that a generation ran afterwards, and not where SillyTavern put it. |

## Going deeper

- [`DIAGNOSTICS_CONSOLE_GUIDE.md`](DIAGNOSTICS_CONSOLE_GUIDE.md) — the full
  per-command reference: every column of every table explained, plus the
  privacy model in detail.
- [`README.md`](README.md) — everything else about MWT.