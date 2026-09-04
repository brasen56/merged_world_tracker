# Tests for Merged World Tracker

This folder contains automated tests for the extension. Tests are small programs that call your code with known inputs and check that the output is what you expect. Their main job: **if someone changes a function and accidentally breaks it, a test turns red and tells them exactly what broke.**

You do **not** need to test everything. The tests here focus on the modules where bugs are most likely and most costly — pure utilities (`core/diff.js`, `core/strip.js`) and the data-integrity code in `knowledge/evidence.js`.

---

## Running the tests

You only need to do the install step once (or whenever `package.json` changes).

```bash
npm install      # one-time: install Vitest
npm test         # run all tests once
npm run test:watch   # re-run tests automatically when files change
```

`npm test` exits with a non-zero code if any test fails, so it can be used in CI / git hooks later if you want.

---

## Linting

The project lints with ESLint for **correctness only** — deliberately no style/formatting rules, so the check stays small and reviewable. Configuration lives in `eslint.config.mjs` and enables exactly: undefined variables (`no-undef`), unused vars/imports (`no-unused-vars`), duplicate object keys (`no-dupe-keys`), unreachable code (`no-unreachable`), switch fall-through (`no-fallthrough`), and importing a name a module doesn't actually export (`import/named`).

```bash
npm run lint      # check the whole project
npm run lint:fix  # auto-fix where possible (rare for these rules)
```

Both `npm run lint` and `npm test` run automatically on every push and pull request via the GitHub Actions workflow in `.github/workflows/ci.yml` (matrix: Node 20 and 22). A change is only green when both pass.

> Tip: the codebase is currently lint-clean. If `npm run lint` reports anything, it's flagging a real issue (a typo'd variable, a leftover import after a refactor, an import of an export that was renamed/removed) — not a style nit.

---

## What's here

| Path | Tests for | Why it's a good first read |
|---|---|---|
| `diff.test.js` | `core/diff.js` (HTML escaping, LCS diff) | **Start here.** Pure functions, no SillyTavern dependency. The comments walk through the "arrange / act / assert" pattern. |
| `strip.test.js` | `core/strip.js` (message stripping) | Also pure functions. Shows `.toMatch()` for regex assertions and `beforeEach` for setup. |
| `evidence.test.js` | `knowledge/evidence.js` (NPC growth evidence store) | The "step up": this module depends on SillyTavern, so it demonstrates the stub-core pattern. Several tests pin specific bug fixes from `REVIEW_TODO.md`. |
| `stubs/core.js` | Fake SillyTavern runtime | Not a test — it's the in-memory replacement that lets the above tests run outside SillyTavern. |

---

## How the tests work (the short version)

Each `*.test.js` file imports functions from your real source code and checks them with `expect(...).toBe(...)` style assertions. The test runner (Vitest) collects every `*.test.js` file and reports which assertions pass/fail.

A single test looks like this:

```js
test('adds two numbers correctly', () => {
    // ARRANGE — set up the inputs
    const a = 2, b = 3;
    // ACT — call the function under test
    const result = add(a, b);
    // ASSERT — check the result
    expect(result).toBe(5);
});
```

Group related tests with `describe('group name', () => { ... })`. It's just for organization and output readability.

---

## The "stub core" pattern (read this before editing `evidence.test.js`)

Several modules (`knowledge/evidence.js`, `world_state/data.js`, etc.) read and write SillyTavern's chat metadata via the helpers in `core/index.js`. Those helpers don't exist outside SillyTavern's browser environment, so the tests can't use the real ones.

`test/stubs/core.js` is a lightweight in-memory replacement. `vitest.config.js` redirects every `import ... from '../core/index.js'` to that stub, so the code-under-test gets a fake runtime instead of crashing.

In a test you:

1. Call `resetCoreStubs()` in `beforeEach` to start each test with a clean slate.
2. Optionally seed state with `setFakeChat([...])` or by mutating `getFakeMeta()`.
3. Call the function under test.
4. Assert on the return value and/or the fake metadata via `getFakeMeta()`.

If a future test needs a `core/index.js` helper that the stub doesn't implement yet, it will throw a clear "not implemented" error telling you which function to add to `test/stubs/core.js`.

---

## How to add a new test

1. **Pick a function with little or no SillyTavern coupling.** Pure utilities (`core/diff.js`, `core/strip.js`) are the easiest. Data-model functions (`knowledge/evidence.js`) are the most valuable because they enforce invariants.

2. **Create `test/<name>.test.js`** next to the existing ones. Copy the header and import style from an existing file.

3. **Write tests one at a time.** A good first test is the "happy path" — call the function with normal inputs and check the normal output. Then add edge cases (empty input, null, huge input, duplicate input).

4. **Run `npm test`** after each test. Watching a new test go from red to green is the fastest way to learn.

### A checklist for a good test

- [ ] Does it test **one** behavior? (If the description has "and", consider splitting.)
- [ ] Could a reader tell what's being tested without reading the source file?
- [ ] Does it still pass if you refactor the implementation (as long as behavior is unchanged)?
- [ ] Does it fail if you introduce the bug it's guarding against?

---

## What NOT to test (and what used to be on this list but no longer is)

An earlier version of this section listed `render.js` files, `injection.js` files, "anything that calls `fetch`", and "the lorebook APIs" as intentionally untested. **That is no longer true** — each of those boundaries now has coverage behind a seam, and the seams are the pattern to copy when a new feature lands on one of them:

- **Modal / DOM-adjacent rendering** — `modal_interactions.test.js` drives the shared `core/modal.js` lifecycle (Escape rule, × / backdrop pointers, onClose veto, handler cleanup) against a minimal parsed-DOM fake; `backup_ui.test.js` pins the backup presenters. *Still out:* the hand-rolled modals inside each module's `render.js` (the Knowledge modals bypass `createModal` — see the scope note in `modal_interactions.test.js`) and anything visual/CSS.
- **Injection** — `injection_diagnostics.test.js` pins the injection diagnostics seam. *Still out:* end-to-end "did text reach the prompt" checks, which need a live SillyTavern.
- **`fetch` / the API layer** — `api_diagnostics.test.js` and `api_failure_families.test.js` cover BOTH transport paths (custom endpoint + Connection-Manager profile) with local doubles (`fetch()` and the `test/stubs/shared.js` host-module seam), including retry/fatal classification and the diagnostics ring.
- **Lorebook (world-info) APIs** — `knowledge_store_hydration.test.js`, `lorebook_hydration_retry.test.js`, and `import_export_roundtrip.test.js` run against a fake world-info script whose `books` map is the disk. `chronicle`/`knowledge` export → import round trips are pinned there too.

What remains deliberately untested, because it needs a live SillyTavern or gives low return for the effort:

- **Real host-runtime integration** — the event wiring and slash commands in the top-level `index.js` files, the actual `shared.js` / `world-info.js` host modules (aliased to stubs in `vitest.config.js`), and browser-only behavior. Manual testing in SillyTavern remains the practical check.
- **Whole-UI flows.** A seam test proves a handler's contract; it does not prove the button is wired to that handler or that the screen looks right. If a new feature matters, pin its data invariants and its riskiest handler contracts — then click through it once for real.

If a boundary you need is missing a seam, `test/stubs/` (`core.js`, `shared.js`, `world-info.js`, `chat_switch.js`) is the place to extend.