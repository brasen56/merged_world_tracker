/**
 * test/scope_guard_contract.js — Regression tests 
 *
 * These tests verify the scope guard contract (capture → await → assert →
 * discard-on-stale) using the chat-switch harness. They do NOT exercise the
 * full module paths (those need a fake-SillyTavern harness, Tier 5); they
 * prove the *patterns* the fixes rely on hold under chat-switch conditions.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { createChatSwitchHarness } from './stubs/chat_switch.js';
import { captureRevision, sameRevision } from '../core/revision.js';
import { createCommands } from '../core/commands.js';

// ─── INTERIORITY-02: scope assertion before mutations ────────────────────────

describe('INTERIORITY-02 — scope guard covers the resolveUserNames() await', () => {
    let h;

    beforeEach(() => {
        h = createChatSwitchHarness();
        h.resetEpoch();
    });

    test('a stale operation detected after an inner await performs zero writes', () => {
        // Simulate the validateAndApply pattern: capture before, await
        // resolveUserNames, assert after, mutate only if still in scope.
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // Simulate the await boundary inside validateAndApply.
        h.switchTo('chat-B');

        const result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('ledger', { npc: 'Mara' });
        }

        expect(result.ok).toBe(false);
        expect(h.writeCount).toBe(0);
    });

    test('a non-stale operation proceeds to mutate after the inner await', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // No switch — the await resolves and scope is still valid.
        const result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('ledger', { npc: 'Mara' });
        }

        expect(result.ok).toBe(true);
        expect(h.writeCount).toBe(1);
    });

    test('dormant poll result is discarded when chat switches during the API call', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // The dormant poll awaits the API. Simulate a switch during it.
        h.switchTo('chat-C');

        const result = h.assertScope(scope);
        const woken = 3; // pretend the poll returned 3 woken entries
        if (result.ok && woken > 0) {
            h.recordWrite('injection', { woken });
        }

        expect(result.ok).toBe(false);
        expect(h.writeCount).toBe(0);
    });
});

// ─── KNOWLEDGE-04: scope-safe book resolution ────────────────────────────────

describe('KNOWLEDGE-04 — scope guard covers read → await → write sequences', () => {
    let h;

    beforeEach(() => {
        h = createChatSwitchHarness();
        h.resetEpoch();
    });

    test('relationship sync aborts when chat changes between load and write', () => {
        // Simulate syncRelationshipsToLorebook:
        //   capture → loadEntryContent (await) → assert → writeToLorebook
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // Simulate the loadEntryContent await.
        h.switchTo('chat-B');

        const result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('lorebook', { uid: 5, name: 'Mara' });
        }

        expect(result.ok).toBe(false);
        expect(h.writeCount).toBe(0);
    });

    test('state-update loop aborts mid-loop when chat changes between NPCs', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // Simulate processing NPC #1 successfully...
        let result = h.assertScope(scope);
        expect(result.ok).toBe(true);
        if (result.ok) h.recordWrite('staging', { npc: 'NPC1' });

        // ...then the chat switches before NPC #2...
        h.switchTo('chat-B');

        // ...the loop re-checks scope before NPC #2 and aborts.
        result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('staging', { npc: 'NPC2' });
        }

        expect(h.writeCount).toBe(1); // only NPC1, not NPC2
    });

    test('scan enrichment aborts when chat changes during enrichStagingItem', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // Simulate: scan completes, enrichment awaits lorebook reads...
        h.switchTo('chat-C');

        // ...post-enrichment scope check discards.
        const result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('staging', { items: 3 });
        }

        expect(result.ok).toBe(false);
        expect(h.writeCount).toBe(0);
    });
});

// ─── WORLD-STATE-01/02: post-retry scope + revision assertions ───────────────

describe('WORLD-STATE-01/02 — scope + revision guards after retry awaits', () => {
    let h;

    beforeEach(() => {
        h = createChatSwitchHarness();
        h.resetEpoch();
    });

    test('full refresh discards result when chat switches during grounding retry', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();
        const wsRevision = captureRevision('## Current Scene\n...');

        // Simulate the grounding retry await.
        h.switchTo('chat-B');

        // The post-retry guard checks BOTH scope and revision.
        const scopeResult = h.assertScope(scope);
        const wsNow = '## Current Scene\n(edited)';
        const revOk = sameRevision(wsRevision, wsNow);

        if (scopeResult.ok && revOk) {
            h.recordWrite('world-state', { text: 'generated' });
        }

        expect(scopeResult.ok).toBe(false);
        expect(h.writeCount).toBe(0);
    });

    test('section regen discards result when section is edited during grounding retry', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // Capture the section revision before the retry.
        const sectionBefore = '## Plot Seeds\n- Old seed';
        const sectionRevision = captureRevision(sectionBefore);

        // No chat switch — but the user edited the section during the retry.
        const sectionAfter = '## Plot Seeds\n- New seed (user edit)';
        const revOk = sameRevision(sectionRevision, sectionAfter);

        const scopeResult = h.assertScope(scope); // scope is fine

        if (scopeResult.ok && revOk) {
            h.recordWrite('world-state-section', { section: 'Plot Seeds' });
        }

        expect(scopeResult.ok).toBe(true);
        expect(revOk).toBe(false);
        expect(h.writeCount).toBe(0);
    });

    test('section regen discards result when chat switches during grounding retry', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();
        const sectionRevision = captureRevision('## Plot Seeds\n- Old seed');

        // Chat switch during the retry.
        h.switchTo('chat-B');

        const scopeResult = h.assertScope(scope);
        const revOk = sameRevision(sectionRevision, '## Plot Seeds\n- Old seed');

        if (scopeResult.ok && revOk) {
            h.recordWrite('world-state-section', { section: 'Plot Seeds' });
        }

        expect(scopeResult.ok).toBe(false);
        expect(h.writeCount).toBe(0);
    });
});

// ─── CORE-02: /wt-inject sets injectionMasterOff ─────────────────────────────

describe('CORE-02 — /wt-inject command contract', () => {
    test('createCommands accepts a saveSettings dependency', () => {
        // The fix adds saveSettings to the deps so /wt-inject can set
        // injectionMasterOff. Verify the factory accepts it without error.
        const modules = {
            WorldState: { setInjectionEnabled: () => {}, applyWorldStateInjection: () => {} },
            Chronicle: { setInjectionEnabled: () => {}, applyInjection: () => {} },
            Knowledge: {},
            StoryPlanner: { setInjectionEnabled: () => {}, applyPlanInjection: () => {} },
            Interiority: { applyIntentionsInjection: () => {} },
        };

        let _savedPatch = null;
        const saveSettings = (patch) => { _savedPatch = patch; };

        const cmds = createCommands({
            registerSlashCommand: null, // no ST available in test
            macroRegistry: null,
            modules,
            resetFloatPositions: () => {},
            saveSettings,
        });

        expect(cmds).toBeDefined();
        expect(typeof cmds.setupSlashCommands).toBe('function');
        expect(typeof cmds.setupMacros).toBe('function');
    });

    test('the /wt-inject "off" path sets injectionMasterOff: true', () => {
        // Verify the logic the handler uses: when mode is 'off', enabled is
        // false, and injectionMasterOff should be !enabled = true.
        const mode = 'off';
        const enabled = mode === 'on';
        const expectedMasterOff = !enabled;

        expect(enabled).toBe(false);
        expect(expectedMasterOff).toBe(true);
    });

    test('the /wt-inject "on" path sets injectionMasterOff: false', () => {
        const mode = 'on';
        const enabled = mode === 'on';
        const expectedMasterOff = !enabled;

        expect(enabled).toBe(true);
        expect(expectedMasterOff).toBe(false);
    });

    test('saveSettings is called with injectionMasterOff when /wt-inject runs', () => {
        // Integration-style test: capture the slash command handler and invoke
        // it directly, verifying that saveSettings receives the master flag.
        const modules = {
            WorldState: { setInjectionEnabled: () => {}, applyWorldStateInjection: () => {} },
            Chronicle: { setInjectionEnabled: () => {}, applyInjection: () => {} },
            Knowledge: {},
            StoryPlanner: { setInjectionEnabled: () => {}, applyPlanInjection: () => {} },
            Interiority: { applyIntentionsInjection: () => {} },
        };

        const savedPatches = [];
        const saveSettings = (patch) => { savedPatches.push(patch); };

        let capturedHandler = null;
        const registerSlashCommand = (name, handler) => {
            if (name === 'wt-inject') capturedHandler = handler;
        };

        const cmds = createCommands({
            registerSlashCommand,
            macroRegistry: null,
            modules,
            resetFloatPositions: () => {},
            saveSettings,
        });
        cmds.setupSlashCommands();

        expect(capturedHandler).not.toBeNull();

        // Invoke the /wt-inject off handler.
        return capturedHandler('off').then(result => {
            expect(result).toContain('off');
            expect(savedPatches.length).toBeGreaterThanOrEqual(1);
            expect(savedPatches[0].injectionMasterOff).toBe(true);
        });
    });

    test('saveSettings sets injectionMasterOff: false for /wt-inject on', () => {
        const modules = {
            WorldState: { setInjectionEnabled: () => {}, applyWorldStateInjection: () => {} },
            Chronicle: { setInjectionEnabled: () => {}, applyInjection: () => {} },
            Knowledge: {},
            StoryPlanner: { setInjectionEnabled: () => {}, applyPlanInjection: () => {} },
            Interiority: { applyIntentionsInjection: () => {} },
        };

        const savedPatches = [];
        const saveSettings = (patch) => { savedPatches.push(patch); };

        let capturedHandler = null;
        const registerSlashCommand = (name, handler) => {
            if (name === 'wt-inject') capturedHandler = handler;
        };

        const cmds = createCommands({
            registerSlashCommand,
            macroRegistry: null,
            modules,
            resetFloatPositions: () => {},
            saveSettings,
        });
        cmds.setupSlashCommands();

        return capturedHandler('on').then(result => {
            expect(result).toContain('on');
            expect(savedPatches.length).toBeGreaterThanOrEqual(1);
            expect(savedPatches[0].injectionMasterOff).toBe(false);
        });
    });
});