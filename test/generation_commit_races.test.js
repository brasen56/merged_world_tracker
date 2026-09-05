/**
 * test/generation_commit_races.test.js — TODO §6 "Generation commit races
 * beyond the scope-guard cases".
 *
 * The chat-switch (scope-guard) halves are pinned elsewhere — the full
 * refresh in test/tier5_regression_net.test.js, the delta refresh AND its
 * same-chat edit race in test/world_state_delta.test.js, chronicle +
 * interiority in tier5. This file pins the commit races those files leave
 * open, on the three generation paths that carry a revision guard:
 *
 *   1. World State FULL refresh — a same-chat document edit during the API
 *      call discards the generated document (WORLD-STATE-02). Tier5 covers
 *      the chat-switch half of this path only.
 *   2. World State SECTION regen — the scope guard, the target-section edit
 *      guard, and the edit-during-grounding-RETRY guard
 *      (WORLD-STATE-01/02) — none of which had any coverage.
 *   3. Story Planner generatePlan — the scope guard AND the
 *      rebase-against-current behavior that keeps user edits (pins) made
 *      during the call (STORY-PLANNER-01/02).
 *
 * Harness conventions mirror test/world_state_delta.test.js: resetCoreStubs +
 * a seeded SillyTavern chat id (core/scope.js reads it directly) + setFakeApi
 * for the LLM. The fake-API callback is the race itself — it performs the
 * "user did something while the call was in flight" action before answering.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat, setFakeApi } from './stubs/core.js';
import { _resetEpoch, bumpEpoch } from '../core/scope.js';
import { _resetPausedStores } from '../core/schema_status.js';
import { buildRefreshStatusDelta } from '../world_state/delta.js';

// ─── 1c harness: hold the alias consultation open ────────────────────────────
//
// The grounding gate's registry-alias consultation is an await inside both
// refresh paths. Collected inside the gate block it sat AFTER the
// post-generation scope assert, re-opening the cross-chat gap that assert had
// just closed: a chat switch while the dynamic import resolved sailed through
// (the later revision check is not a cross-chat guard when the two chats'
// documents happen to match) and the old chat's result was written into the
// new chat. The fix collects the groups pre-flight, above every guard, so the
// switch is caught by the existing post-generation assert. These tests hold
// the alias collection open across the switch — the mock IS the race. The
// passthrough default keeps every other provenance export real for the rest
// of this file.
vi.mock('../world_state/provenance.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        collectRegistryAliasGroups: vi.fn((...args) => orig.collectRegistryAliasGroups(...args)),
    };
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BASELINE = [
    '## Current Scene',
    'Date: March 3, 2026',
    'Time: 14:00',
    'Location: The harbour office',
    'Present: Alex, Derek',
    'Situation: Waiting for the ferry manifest.',
    '',
    '## Recent Changes',
    '- The manifest arrived torn.',
    '',
    '## Pending',
    '- Alex owes Derek a report by Friday.',
    '',
    '## Key Character States',
    '- **Alex**:',
    '  - Mood: focused',
    '  - Worn / Significant Items: none',
].join('\n');

// A full-document output that passes the refresh validators (starts with
// "## Current Scene" and contains the expected sections).
const FULL_DOC = [
    '## Current Scene',
    'Date: March 4, 2026',
    'Time: 09:30',
    'Location: The harbour office',
    'Present: Alex, Derek',
    'Situation: The manifest is gone.',
    '',
    '## Recent Changes',
    '- The manifest went missing overnight.',
    '',
    '## Key Character States',
    '- **Alex**:',
    '  - Mood: alarmed',
    '  - Worn / Significant Items: none',
].join('\n');

function makeChat(n = 6) {
    return Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        name: i % 2 ? 'Mara' : 'User',
        is_user: i % 2 === 0,
        mes: `Message number ${i} of the scene.`,
    }));
}

/** The user's mid-flight edit: an annotation saved into the document. */
const USER_ANNOTATION = '\n(user annotation)';

/**
 * The user's mid-flight edit FOR SECTION TESTS: a line saved into the
 * "## Recent Changes" section itself. The section revision guard deliberately
 * protects only the TARGET section, so an edit elsewhere in the document is
 * (by design) not a discard trigger — the fixture has to hit the section.
 */
const EDITED_RECENT = BASELINE.replace(
    '- The manifest arrived torn.',
    '- The manifest arrived torn.\n- (user annotation)',
);

// ─── 1. World State full refresh — same-chat edit race ───────────────────────

describe('World State full refresh — same-chat edit race (WORLD-STATE-02)', () => {
    let state, getWorldStateData, getWorldStateText, setWorldStateData, saveSettings;
    let requests;
    let CURRENT;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-race' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat());
        ({ state, getWorldStateData, getWorldStateText, setWorldStateData } = await import('../world_state/data.js'));
        ({ saveSettings } = await import('../world_state/settings.js'));
        state.wstIsRefreshing = false;
        state.modal = null;
        state.autoRefreshQueued = false;
        state.autoRefreshDeferTimer = null;
        requests = [];
        CURRENT = '';
        setFakeApi(async (req) => {
            requests.push(req);
            return typeof CURRENT === 'string' ? CURRENT : CURRENT(req, requests.length);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        // Defensive: a leaked busy flag would fail every later test.
        state.wstIsRefreshing = false;
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    test('control: an uninterrupted refresh commits the generated document', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        // Seed a baseline: a blank outgoing document skips the history
        // snapshot by design, so the control must start from a real doc.
        setWorldStateData({ text: BASELINE });
        CURRENT = FULL_DOC;

        const text = await refreshWorldState();

        expect(text).toBe(FULL_DOC);
        expect(getWorldStateText()).toBe(FULL_DOC);
        expect(getWorldStateData().autoSaveHistory).toHaveLength(1);
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('a document edit during the API call discards the generated document', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setWorldStateData({ text: BASELINE });
        CURRENT = () => {
            // The user saves an edit while the call is in flight…
            setWorldStateData({ text: BASELINE + USER_ANNOTATION });
            // …and the model's answer (valid as it is) must not clobber it.
            return FULL_DOC;
        };

        const text = await refreshWorldState();

        expect(text).toBeNull(); // declined, not applied
        expect(getWorldStateText()).toBe(BASELINE + USER_ANNOTATION);
        expect(getWorldStateText()).not.toContain('The manifest is gone');
        // Nothing committed: no history snapshot for a discarded result.
        expect(getWorldStateData().autoSaveHistory).toHaveLength(0);
        expect(state.wstIsRefreshing).toBe(false);
    });
});


// ─── 2. World State section regen — scope / edit / grounding-retry races ──────

describe('World State section regen — commit races (WORLD-STATE-01/02)', () => {
    let state, getWorldStateText, setWorldStateData, saveSettings;
    let requests;
    let CURRENT;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-section' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat());
        ({ state, getWorldStateText, setWorldStateData } = await import('../world_state/data.js'));
        ({ saveSettings } = await import('../world_state/settings.js'));
        state.wstIsRefreshing = false;
        state.modal = null;
        requests = [];
        CURRENT = '';
        setFakeApi(async (req) => {
            requests.push(req);
            return typeof CURRENT === 'string' ? CURRENT : CURRENT(req, requests.length);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        state.wstIsRefreshing = false;
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    test('control: an uninterrupted regen replaces only the target section', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', groundingEnabled: false });
        setWorldStateData({ text: BASELINE });
        CURRENT = '## Recent Changes\n- The manifest went missing overnight.';

        const updated = await regenerateSection('Recent Changes');

        expect(updated).toContain('The manifest went missing overnight.');
        expect(getWorldStateText()).toContain('The manifest went missing overnight.');
        // The other sections are untouched.
        expect(getWorldStateText()).toContain('## Current Scene');
        expect(getWorldStateText()).toContain('Alex owes Derek a report');
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('a same-chat edit to the target section during the call discards the result', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', groundingEnabled: false });
        setWorldStateData({ text: BASELINE });
        CURRENT = () => {
            // The user saves a manual edit to THIS section mid-flight.
            setWorldStateData({ text: EDITED_RECENT });
            return '## Recent Changes\n- Generated replacement text.';
        };

        const updated = await regenerateSection('Recent Changes');

        expect(updated).toBeNull();
        expect(getWorldStateText()).toBe(EDITED_RECENT);
        expect(getWorldStateText()).not.toContain('Generated replacement text');
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('a chat switch during the call discards the result (no cross-chat write)', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', groundingEnabled: false });
        setWorldStateData({ text: BASELINE });
        CURRENT = () => {
            bumpEpoch(); // the chat changed while the call was in flight
            return '## Recent Changes\n- Generated replacement text.';
        };

        const updated = await regenerateSection('Recent Changes');

        expect(updated).toBeNull();
        expect(getWorldStateText()).toBe(BASELINE); // document untouched
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('an edit during the GROUNDING RETRY await discards the result', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        // Strict grounding: a bold name absent from the scan window and the
        // prior document is a phantom → first attempt is rejected → one
        // grounded retry. The user edits the section during THAT await.
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test-model',
            groundingEnabled: true, groundingMode: 'strict',
        });
        setWorldStateData({ text: BASELINE });
        CURRENT = (_req, n) => {
            if (n === 1) return '## Recent Changes\n- **Zyx** demands the manifest.'; // ungrounded
            // During the retry: the user saves a manual edit to the section.
            setWorldStateData({ text: EDITED_RECENT });
            return '## Recent Changes\n- The manifest arrived torn again.'; // grounded
        };

        const updated = await regenerateSection('Recent Changes');

        expect(requests).toHaveLength(2); // the grounding retry really happened
        expect(updated).toBeNull();
        expect(getWorldStateText()).toBe(EDITED_RECENT);
        expect(getWorldStateText()).not.toContain('torn again');
        expect(state.wstIsRefreshing).toBe(false);
    });
});


// ─── 1b. World State busy flag — concurrent start refusal ─────────────────────

describe('World State busy flag — a concurrent start is refused at the gate', () => {
    // Every race test above asserts wstIsRefreshing is FALSE afterwards; none
    // asserts the guards that make it mean anything (refresh.js's two entry
    // points, sections.js's regen). Delete any `if (state.wstIsRefreshing)`
    // guard and the whole file still passed — while two refreshes raced to
    // commit. These tests hold the first refresh's API call open (the real
    // in-flight window, not a hand-set flag) and demand every other entry
    // point refuse to start.

    let state, getWorldStateText, setWorldStateData, saveSettings;
    let requests;
    let resolvePending;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-race' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat());
        ({ state, getWorldStateText, setWorldStateData } = await import('../world_state/data.js'));
        ({ saveSettings } = await import('../world_state/settings.js'));
        state.wstIsRefreshing = false;
        state.modal = null;
        state.autoRefreshQueued = false;
        state.autoRefreshDeferTimer = null;
        requests = [];
        // The outbound call resolves only when the test releases it — the
        // first refresh stays genuinely in flight.
        setFakeApi(async (req) => {
            requests.push(req);
            return new Promise(resolve => { resolvePending = () => resolve(FULL_DOC); });
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        // Defensive: a leaked busy flag or defer timer would fail every later test.
        state.wstIsRefreshing = false;
        if (state.autoRefreshDeferTimer) { clearTimeout(state.autoRefreshDeferTimer); state.autoRefreshDeferTimer = null; }
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    test('full, delta, and section regen throw while a refresh is in flight; auto declines quietly', async () => {
        const { refreshWorldState, refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { regenerateSection } = await import('../world_state/sections.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setWorldStateData({ text: BASELINE });

        const first = refreshWorldState();
        // Same synchronous window: the flag went up before the first await
        // inside refreshWorldState, and the held API call keeps it up.
        await expect(refreshWorldState()).rejects.toThrow('World State is already refreshing.');
        await expect(refreshWorldStateDelta()).rejects.toThrow('World State is already refreshing.');
        await expect(regenerateSection('Recent Changes')).rejects.toThrow('World State is already refreshing.');
        // The auto entry point declines QUIETLY (the router re-arms it)…
        await expect(refreshWorldState(true)).resolves.toBe(null);
        // …and no second API call ever left: exactly one request for the one
        // refresh that was allowed to start.
        expect(requests).toHaveLength(1);

        // Drop the deferred auto follow-up the quiet decline scheduled, then
        // let the one legitimate refresh finish and commit.
        state.autoRefreshQueued = false;
        if (state.autoRefreshDeferTimer) { clearTimeout(state.autoRefreshDeferTimer); state.autoRefreshDeferTimer = null; }
        resolvePending();

        const text = await first;
        expect(text).toBe(FULL_DOC);
        expect(getWorldStateText()).toBe(FULL_DOC);
        expect(state.wstIsRefreshing).toBe(false);
        expect(requests).toHaveLength(1); // still one — the refusals never fired a call
    });
});


// ─── 1c. Alias consultation — chat switch while the alias groups load ────────

describe('World State refresh — chat switch while the alias groups load', () => {
    let state, getWorldStateData, getWorldStateText, setWorldStateData, saveSettings;
    let requests;
    let CURRENT;
    let prov;
    let chatId;

    // A minimal delta patch that parses and applies cleanly.
    const DELTA_PATCH = [
        '### UPDATE: recent changes',
        '## Recent Changes',
        '- The manifest went missing overnight.',
    ].join('\n');

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        chatId = 'chat-alias';
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => chatId }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat());
        ({ state, getWorldStateData, getWorldStateText, setWorldStateData } = await import('../world_state/data.js'));
        ({ saveSettings } = await import('../world_state/settings.js'));
        prov = await import('../world_state/provenance.js');
        state.wstIsRefreshing = false;
        state.modal = null;
        state.autoRefreshQueued = false;
        state.autoRefreshDeferTimer = null;
        requests = [];
        CURRENT = '';
        setFakeApi(async (req) => {
            requests.push(req);
            return typeof CURRENT === 'string' ? CURRENT : CURRENT(req, requests.length);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        state.wstIsRefreshing = false;
        if (state.autoRefreshDeferTimer) { clearTimeout(state.autoRefreshDeferTimer); state.autoRefreshDeferTimer = null; }
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    /**
     * Start `fn` (a refresh entry point) with the alias consultation held
     * open, switch chats while it is pending, then release it. Returns the
     * refresh promise.
     */
    function startUnderAliasLoadAndSwitch(fn) {
        let releaseAliases;
        let markStarted;
        const started = new Promise(resolve => { markStarted = resolve; });
        const gate = new Promise(resolve => { releaseAliases = resolve; });
        prov.collectRegistryAliasGroups.mockImplementationOnce(() => {
            markStarted();
            return gate;
        });
        const pending = fn();
        return started
            .then(() => {
                // The user switches chats while the aliases are still loading.
                chatId = 'chat-other';
                bumpEpoch();
                releaseAliases([]);
                return pending;
            });
    }

    test('full path: the generated document is discarded, nothing is written', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test-model',
            groundingEnabled: true, groundingMode: 'soft',
        });
        setWorldStateData({ text: BASELINE });
        CURRENT = FULL_DOC;

        const text = await startUnderAliasLoadAndSwitch(() => refreshWorldState());

        expect(text).toBeNull(); // declined, not applied
        expect(prov.collectRegistryAliasGroups).toHaveBeenCalledTimes(1);
        expect(getWorldStateText()).toBe(BASELINE); // document untouched
        expect(getWorldStateData().autoSaveHistory).toHaveLength(0);
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('delta path: the patch is discarded, nothing is written', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test-model',
            groundingEnabled: true, groundingMode: 'soft',
        });
        // Delta preconditions: a baseline document whose digest matches the
        // refresh status committed for it (the seedReconciledDoc recipe from
        // world_state_delta.test.js).
        const status = buildRefreshStatusDelta('full', BASELINE, { deltasSinceFull: 0 }, makeChat().length);
        setWorldStateData({ text: BASELINE, deltaStatus: status });
        CURRENT = DELTA_PATCH;

        const text = await startUnderAliasLoadAndSwitch(() => refreshWorldStateDelta());

        expect(text).toBeNull(); // declined, not applied
        expect(prov.collectRegistryAliasGroups).toHaveBeenCalledTimes(1);
        expect(getWorldStateText()).toBe(BASELINE); // patch never landed
        expect(getWorldStateData().autoSaveHistory).toHaveLength(0);
        expect(state.wstIsRefreshing).toBe(false);
    });
});


// ─── 3. Story Planner generatePlan — scope + rebase-on-edit races ─────────────

describe('Story Planner generatePlan — commit races (STORY-PLANNER-01/02)', () => {
    // A valid plan document: "## " heading + ≥3 bulleted arcs.
    const PLAN = [
        '## Active',
        '- The harbour strike reaches the docks',
        '- Mara hunts the missing manifest',
        '- Derek hides a debt from the office',
    ].join('\n');

    let state, getArcs, setArcs, makeArc, saveSettings;
    let requests;
    let CURRENT;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-plan' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat(8));
        ({ state, getArcs, setArcs, makeArc } = await import('../story_planner/data.js'));
        ({ saveSettings } = await import('../story_planner/settings.js'));
        state.isGenerating = false;
        requests = [];
        CURRENT = PLAN;
        setFakeApi(async (req) => {
            requests.push(req);
            return typeof CURRENT === 'string' ? CURRENT : CURRENT(req, requests.length);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        state.isGenerating = false;
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    test('control: an uninterrupted generation commits the parsed arcs', async () => {
        const { generatePlan } = await import('../story_planner/generation.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        const arcs = await generatePlan();

        expect(arcs).toHaveLength(3);
        expect(getArcs()).toHaveLength(3);
        expect(state.isGenerating).toBe(false);
    });

    test('a chat switch during the call discards the result without writing', async () => {
        const { generatePlan } = await import('../story_planner/generation.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const seeded = [makeArc({ title: 'Existing thread' })];
        setArcs(seeded);
        CURRENT = () => {
            bumpEpoch(); // the chat changed while the call was in flight
            return PLAN;
        };

        const arcs = await generatePlan();

        expect(arcs).toBeNull();
        expect(requests).toHaveLength(1); // the call was made — and its result dropped
        // The stored plan is EXACTLY the pre-call plan: no partial merge.
        expect(getArcs().map(a => a.id)).toEqual(seeded.map(a => a.id));
        expect(state.isGenerating).toBe(false);
    });

    test('a user PIN made during the call survives via the rebase-against-current merge', async () => {
        const { generatePlan } = await import('../story_planner/generation.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const seeded = makeArc({ title: 'Harbour pact' });
        setArcs([seeded]);
        CURRENT = () => {
            // The user pins the arc while the generation is in flight (the
            // model's plan does not mention it at all). CLONE before editing:
            // getArcs() hands back the LIVE stored array, so mutating it in
            // place would also mutate the arc objects generatePlan captured
            // in its pre-call snapshot — the stale snapshot would carry the
            // pin too, and a broken rebase (merging against that snapshot
            // instead of current state) would pass this test unnoticed.
            const cur = getArcs().map(a => ({ ...a }));
            cur[0].pinned = true;
            setArcs(cur);
            return PLAN;
        };

        const arcs = await generatePlan();

        // Rebased against CURRENT arcs: the pinned arc is carried forward
        // alongside the three freshly generated ones — not clobbered.
        expect(arcs).toHaveLength(4);
        const pact = arcs.find(a => a.title === 'Harbour pact');
        expect(pact).toBeTruthy();
        expect(pact.pinned).toBe(true);
        expect(pact.id).toBe(seeded.id); // same identity, not a duplicate
        expect(getArcs().find(a => a.title === 'Harbour pact').pinned).toBe(true);
        expect(state.isGenerating).toBe(false);
    });
});

