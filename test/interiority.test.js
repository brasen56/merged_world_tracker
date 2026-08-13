/**
 * test/interiority.test.js — Rollback must not destroy user-authored state.
 *
 * On swipe/edit/delete, interiority rolls engine-generated state back to the
 * snapshot taken before that message's generation. Two stores get rolled back:
 * the intentions ledger and the per-NPC inner-state lines.
 *
 * The property worth protecting is the same for both: a snapshot is a record of
 * what the ENGINE produced, so restoring it must not silently revert work the
 * USER did. The ledger already gets this right; these tests pin the behaviour
 * for both so the two paths can't drift apart again.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    resetCoreStubs, setFakeContextExtras, getFakeMeta, setFakeChat,
    WORLD_STATE_METADATA_KEY,
} from './stubs/core.js';
import { REGISTRY_KEY } from '../knowledge/state.js';
import {
    getLedger, setLedger, restoreLedgerSnapshot,
    addLedgerEntry, updateLedgerEntry, hasDuplicateIntention,
    removeLedgerEntries, isIntentionDeleted, clearDeletedIntentions,
    getInnerState, getInnerStates, setInnerState,
    getInnerStatesSnapshot, restoreInnerStatesSnapshot,
} from '../interiority/data.js';
import { assembleNpcBlocks, buildSceneRoster, resolveUserNames } from '../interiority/generation.js';
import { purgeUserLedgerEntries } from '../interiority/data.js';
import { _setCacheForTests, _clearCacheForTests } from '../knowledge/store.js';
import { saveSettings as saveKnowledgeSettings } from '../knowledge/settings.js';
import { buildUserContent, buildSystemPrompt } from '../interiority/prompts.js';

beforeEach(() => resetCoreStubs());

describe('a deleted intention stays deleted', () => {

    // THE BUG (reported from live use): scheduled intentions came back after
    // being deleted. Two independent routes brought them back, and both had to
    // be closed:
    //
    //   1. hasDuplicateIntention only consulted the LIVE ledger, so once the
    //      entry was gone the next generation re-proposed it from unchanged
    //      story context and it landed as brand new.
    //   2. restoreLedgerSnapshot restored the snapshot verbatim, so a swipe
    //      whose snapshot predated the deletion resurrected it instantly.

    test('a re-proposal after deletion is rejected as a duplicate', () => {
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
            status: 'dormant',
        }, 'day 1', 3);

        expect(hasDuplicateIntention('Ezra', 'call Dorothy', 'Monday morning')).toBe(true);
        removeLedgerEntries([entry.id], { tombstone: true });
        expect(getLedger()).toHaveLength(0);

        // The model proposes it again from story context that has not changed.
        expect(hasDuplicateIntention('Ezra', 'call Dorothy', 'Monday morning')).toBe(true);
    });

    test('a re-proposal that rewords only the trigger is still rejected', () => {
        // The trigger is free-form "when/why" prose. The engine keeps the same
        // NPC + action (the parts the story context drives) but rewords the
        // trigger when re-proposing, so the tombstone must key on NPC + action
        // alone — not NPC + action + trigger. This is the regression for the bug
        // that had deleted intentions keep coming back.
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
        }, 'day 1', 3);
        removeLedgerEntries([entry.id], { tombstone: true });

        // Same NPC + action, different trigger wording — still a duplicate.
        expect(hasDuplicateIntention('Ezra', 'call Dorothy', 'next week')).toBe(true);
        // And a direct tombstone hit ignores the trigger entirely.
        expect(isIntentionDeleted('Ezra', 'call Dorothy')).toBe(true);
    });

    test('a rollback does not resurrect it', () => {
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
        }, 'day 1', 3);
        // Snapshot taken while the entry was still live — a swipe restores this.
        const snapshot = JSON.parse(JSON.stringify(getLedger()));

        removeLedgerEntries([entry.id], { tombstone: true });
        restoreLedgerSnapshot(snapshot);

        expect(getLedger()).toHaveLength(0);
    });

    test('a deleted-then-re-proposed clone with a fresh id is still blocked on rollback', () => {
        // The tombstone matches on text as well as id, so a re-proposal that
        // slipped in before this fix cannot ride back in on an old snapshot.
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
        }, 'day 1', 3);
        removeLedgerEntries([entry.id], { tombstone: true });

        restoreLedgerSnapshot([{
            id: 'i-different', npc: 'Ezra',
            action: 'call Dorothy', trigger: 'Monday morning',
        }]);

        expect(getLedger()).toHaveLength(0);
    });

    test('the engine executing an intention does NOT tombstone it', () => {
        // An executed intention is a lifecycle event, not a refusal. Ezra may
        // decide to call Dorothy again next week; tombstoning that would make
        // the intention unrepeatable for the rest of the chat.
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
        }, 'day 1', 3);
        removeLedgerEntries([entry.id]); // engine path — no tombstone

        expect(isIntentionDeleted('Ezra', 'call Dorothy')).toBe(false);
        expect(hasDuplicateIntention('Ezra', 'call Dorothy', 'Monday morning')).toBe(false);
    });

    test('deleting an edited entry blocks both the correction and the original', () => {
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorthy', trigger: 'Monday morning',
        }, 'day 1', 3);
        updateLedgerEntry(entry.id, { action: 'call Dorothy' });
        removeLedgerEntries([entry.id], { tombstone: true });

        expect(hasDuplicateIntention('Ezra', 'call Dorothy', 'Monday morning')).toBe(true);
        expect(hasDuplicateIntention('Ezra', 'call Dorthy', 'Monday morning')).toBe(true);
    });

    test('a genuinely different intention is not suppressed', () => {
        // The tombstone must not become "this NPC may never plan anything again".
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
        }, 'day 1', 3);
        removeLedgerEntries([entry.id], { tombstone: true });

        expect(hasDuplicateIntention('Ezra', 'leave town', 'at dawn')).toBe(false);
        // Another NPC is unaffected.
        expect(hasDuplicateIntention('Alex', 'call Dorothy', 'Monday morning')).toBe(false);
    });

    test('clearing tombstones lets a deleted intention be proposed again', () => {
        const entry = addLedgerEntry({
            npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning',
        }, 'day 1', 3);
        removeLedgerEntries([entry.id], { tombstone: true });

        expect(clearDeletedIntentions()).toBe(1);
        expect(hasDuplicateIntention('Ezra', 'call Dorothy', 'Monday morning')).toBe(false);
    });
});

describe('the player character never reaches the roster', () => {

    // THE BUG (reported from live use): the main character appeared in the
    // intentions ledger, so the injection started demanding the narrator act
    // for the player. The narrator model broke character to ask if that was a
    // mistake.
    //
    // buildSceneRoster canonicalized each candidate through the knowledge
    // registry BEFORE testing it against {{user}}. The registry is keyed on
    // whatever the knowledge tracker first recorded, often a fuller name — so
    // with {{user}} = "Alex" and a registry entry "Alex Blackwell",
    // canonicalize("Alex") returned "Alex Blackwell", which matched nothing in
    // the exclusion set. The PC walked onto the roster under their own
    // canonical name.

    beforeEach(() => {
        _clearCacheForTests();
        saveKnowledgeSettings({ scope: 'global' });
        // The knowledge tracker has recorded the player under a fuller name.
        _setCacheForTests('Knowledge Tracker', {
            registry: {
                'Alex Blackwell': { uid: 0 },
                'Ezra Blackwell': { uid: 1 },
            },
        });
        setFakeContextExtras({ name1: 'Alex', name2: 'Ezra Blackwell' });
        // The scene names the player, which is how they became a candidate.
        getFakeMeta()[WORLD_STATE_METADATA_KEY] = {
            text: 'Present: Alex, Ezra Blackwell',
        };
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('the user is excluded even when the registry knows them by a fuller name', async () => {
        const roster = await buildSceneRoster();
        expect(roster).not.toContain('Alex Blackwell');
        expect(roster).not.toContain('Alex');
    });

    test('resolveUserNames covers both the persona name and the registry name', async () => {
        const names = await resolveUserNames();
        expect(names.has('alex')).toBe(true);
        expect(names.has('alex blackwell')).toBe(true);
    });

    test('a leaked ledger entry does not re-admit the PC to the roster', async () => {
        // The self-sustaining half of the bug: getActiveLedger() seeds the
        // roster from the ledger, so one leaked entry keeps the PC on the
        // roster for the rest of the chat.
        addLedgerEntry({ npc: 'Alex Blackwell', action: 'confess', trigger: 'at dinner' }, 'day 1', 1);

        expect(await buildSceneRoster()).not.toContain('Alex Blackwell');
        // ...and the cleanup path removes it, given the widened name set.
        expect(purgeUserLedgerEntries(await resolveUserNames())).toBe(true);
        expect(getLedger()).toHaveLength(0);
    });

    test('a real NPC sharing the scene is still rostered', async () => {
        // The filter must not become "exclude anyone named like the user".
        const roster = await buildSceneRoster();
        expect(roster).toContain('Ezra Blackwell');
    });
});

describe('the roster unions registry NPCs missing from Present:', () => {

    // THE BUG (reported from live use): a scene with two card NPCs gave
    // thoughts/intentions to only the first — "the first one named in the
    // card". The world-state tracker wrote a `Present:` line naming only the
    // primary NPC, and the knowledge-registry fallback was gated behind
    // `if (sceneNames.length === 0)`. A non-empty but INCOMPLETE Present line
    // therefore stranded every other in-scene NPC: they had a knowledge record
    // but never joined the roster, so they never got interiority. The fix
    // unions registry names found in recent messages WITH the Present line
    // instead of using them only as an all-or-nothing fallback.

    beforeEach(() => {
        _clearCacheForTests();
        saveKnowledgeSettings({ scope: 'global' });
        // Both NPCs are known to the knowledge tracker (canonicalizer source).
        _setCacheForTests('Knowledge Tracker', {
            registry: { 'Ezra Blackwell': { uid: 1 }, 'Mara': { uid: 2 } },
        });
        // The chat-metadata registry — what buildSceneRoster's union reads.
        getFakeMeta()[REGISTRY_KEY] = {
            'Ezra Blackwell': { uid: 1 }, 'Mara': { uid: 2 },
        };
        setFakeContextExtras({ name1: 'Alex', name2: 'Ezra Blackwell' });
        // The world-state tracker named ONLY the first NPC — the incomplete
        // line that reproduces the bug.
        getFakeMeta()[WORLD_STATE_METADATA_KEY] = { text: 'Present: Ezra Blackwell' };
        // ...but both NPCs actually appear in recent messages.
        setFakeChat([
            { mes: 'Ezra leaned against the doorframe.', name: 'Ezra Blackwell', is_user: false },
            { mes: 'Mara looked up from her book and frowned.', name: 'Mara', is_user: false },
        ]);
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('an NPC omitted from Present: is rescued via the registry union', async () => {
        const roster = await buildSceneRoster();
        expect(roster).toContain('Ezra Blackwell'); // from Present:
        expect(roster).toContain('Mara');           // rescued by the union
    });

    test('the player character is still excluded from the union', async () => {
        // The union must not become a back door for the PC: even when the
        // user's name is in the registry and recent messages, they stay out.
        getFakeMeta()[REGISTRY_KEY]['Alex'] = { uid: 3 };
        setFakeChat([
            { mes: 'Alex crossed the room toward Mara.', name: 'Alex', is_user: true },
            { mes: 'Mara looked up.', name: 'Mara', is_user: false },
        ]);
        const roster = await buildSceneRoster();
        expect(roster).not.toContain('Alex');
        expect(roster).toContain('Mara');
    });
});

describe('the intentions call can see scheduled intentions', () => {

    // THE ROOT CAUSE of the duplicate-scheduled-intention reports: dormant
    // entries were dropped from the intentions call entirely. That call both
    // evaluates existing intentions AND proposes new ones — correct for the
    // first job, wrong for the second. The model could not see that Ezra
    // already planned to call Dorothy, so it re-proposed the plan every turn,
    // and only word-for-word repeats were caught by exact-string dedup.

    test('scheduled entries are separated from the evaluation list', async () => {
        addLedgerEntry({ npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning', status: 'dormant', wakeHint: 'Monday' }, 'day 1', 1);
        addLedgerEntry({ npc: 'Ezra', action: 'watch Alex', trigger: 'when alone' }, 'day 1', 1);

        const [block] = await assembleNpcBlocks(['Ezra']);

        // §20 intact: dormant entries are still not evaluable.
        expect(block.openIntentions.map(e => e.action)).toEqual(['watch Alex']);
        expect(block.scheduledIntentions.map(e => e.action)).toEqual(['call Dorothy']);
    });

    test('the prompt shows scheduled plans but gives them no ids', async () => {
        addLedgerEntry({ npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning', status: 'dormant', wakeHint: 'Monday' }, 'day 1', 1);
        const npcBlocks = await assembleNpcBlocks(['Ezra']);

        const content = buildUserContent({ npcBlocks, recentMessages: '...' });

        expect(content).toContain('<already_scheduled>');
        expect(content).toContain('call Dorothy');
        expect(content).toContain('watching for: Monday');
        // No id on the line — the model must not be able to mark it
        // executed/dropped, which is what dormancy means.
        const line = content.split('\n').find(l => l.includes('call Dorothy'));
        expect(line).not.toMatch(/\[i-/);
    });

    test('the system prompt tells the model not to restate them', () => {
        expect(buildSystemPrompt({ intentions: true })).toContain('<already_scheduled>');
        // Thoughts-only calls never propose intentions, so the rule is omitted.
        expect(buildSystemPrompt({ thoughts: true, intentions: false }))
            .not.toContain('<already_scheduled>');
    });
});

describe('dedup survives a user edit', () => {

    // THE BUG (reported from live use): an auto-generated scheduled intention
    // named the wrong character. The user corrected the name. The original then
    // reappeared alongside the corrected one, repeatedly, near-verbatim.
    //
    // hasDuplicateIntention matches action+trigger as exact strings, so
    // correcting the text is precisely what stops the engine recognising its own
    // intention: the next generation re-proposes it from unchanged story context,
    // the strings no longer match, and it lands as a brand-new entry.

    test('a re-proposal of the ORIGINAL text is still caught after an edit', () => {
        const entry = addLedgerEntry({
            npc: 'Mara',
            action: 'confront Jaimie about the letter',
            trigger: 'when they are alone',
            status: 'dormant',
        }, 'day 1', 3);

        // User fixes the wrong name. Same entry, corrected text.
        updateLedgerEntry(entry.id, { action: 'confront James about the letter' });

        // The model re-proposes it next turn, still with the name the story
        // context drives it toward.
        expect(hasDuplicateIntention(
            'Mara', 'confront Jaimie about the letter', 'when they are alone',
        )).toBe(true);
    });

    test('the corrected text is still caught as a duplicate too', () => {
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'confront Jaimie', trigger: 'when alone',
        }, 'day 1', 3);
        updateLedgerEntry(entry.id, { action: 'confront James' });

        expect(hasDuplicateIntention('Mara', 'confront James', 'when alone')).toBe(true);
    });

    test('a genuinely different intention is NOT suppressed', () => {
        // The guard must not become "never add anything for this NPC again".
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'confront Jaimie', trigger: 'when alone',
        }, 'day 1', 3);
        updateLedgerEntry(entry.id, { action: 'confront James' });

        expect(hasDuplicateIntention('Mara', 'leave the city', 'at dawn')).toBe(false);
        // Same action, different trigger is a different intention.
        expect(hasDuplicateIntention('Mara', 'confront James', 'in public')).toBe(false);
        // Same text, different NPC.
        expect(hasDuplicateIntention('Rowan', 'confront James', 'when alone')).toBe(false);
    });

    test('editing twice still matches the ENGINE original', () => {
        // The engine only ever re-proposes what IT wrote, so the first recorded
        // original is the one that matters — a later edit must not overwrite it
        // with the user's own intermediate wording.
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'confront Jaimie', trigger: 'when alone',
        }, 'day 1', 3);
        updateLedgerEntry(entry.id, { action: 'confront James' });
        updateLedgerEntry(entry.id, { action: 'confront James privately' });

        expect(hasDuplicateIntention('Mara', 'confront Jaimie', 'when alone')).toBe(true);
        expect(hasDuplicateIntention('Mara', 'confront James privately', 'when alone')).toBe(true);
    });

    test('an edited trigger is matched on its original too', () => {
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'confront James', trigger: 'when they are alonr',
        }, 'day 1', 3);
        updateLedgerEntry(entry.id, { trigger: 'when they are alone' });

        expect(hasDuplicateIntention('Mara', 'confront James', 'when they are alonr')).toBe(true);
    });
});

describe('restoreLedgerSnapshot (existing behaviour — the reference)', () => {

    test('a manual entry added after the snapshot survives rollback', () => {
        setLedger([{ id: 'e1', npc: 'Mara', action: 'engine intent' }]);
        const snapshot = structuredClone(getLedger());

        // User adds an intention by hand, later than the snapshot.
        setLedger([...getLedger(), { id: 'm1', npc: 'Mara', action: 'user intent', manual: true }]);

        restoreLedgerSnapshot(snapshot);

        expect(getLedger().map(e => e.id).sort()).toEqual(['e1', 'm1']);
    });

    test('an engine entry added after the snapshot is rolled back', () => {
        setLedger([{ id: 'e1', npc: 'Mara', action: 'engine intent' }]);
        const snapshot = structuredClone(getLedger());
        setLedger([...getLedger(), { id: 'e2', npc: 'Mara', action: 'from the abandoned timeline' }]);

        restoreLedgerSnapshot(snapshot);

        expect(getLedger().map(e => e.id)).toEqual(['e1']);
    });

    test('an edit to an entry the snapshot contains is not reverted', () => {
        // Editing keeps the entry's id, so the entry IS in the snapshot — and
        // the snapshot holds the pre-edit text. Restoring it wholesale silently
        // undid the user's correction. The doc comment always claimed the manual
        // version wins here; now the code does too.
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'confront Jaimie', trigger: 'when alone',
        }, 'day 1', 3);
        const snapshot = structuredClone(getLedger());

        updateLedgerEntry(entry.id, { action: 'confront James' });
        restoreLedgerSnapshot(snapshot);

        expect(getLedger()).toHaveLength(1);
        expect(getLedger()[0].action).toBe('confront James');
    });

    test('rollback still reverts engine-owned lifecycle fields on an edited entry', () => {
        // The user owns the TEXT they edited; the engine still owns status,
        // wakeHint and age. A dormancy change made in the timeline being thrown
        // away must not survive just because the entry was once hand-edited.
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'confront Jaimie', trigger: 'when alone',
            status: 'dormant', wakeHint: 'after the festival',
        }, 'day 1', 3);
        const snapshot = structuredClone(getLedger());

        updateLedgerEntry(entry.id, { action: 'confront James' });
        // Engine wakes it in the turn that is about to be swiped away.
        setLedger(getLedger().map(e => ({ ...e, status: 'active', turnsOpen: 9 })));

        restoreLedgerSnapshot(snapshot);

        const [restored] = getLedger();
        expect(restored.action).toBe('confront James');   // user's text kept
        expect(restored.status).toBe('dormant');          // engine state rolled back
        expect(restored.turnsOpen).toBe(0);
    });
});

describe('restoreInnerStatesSnapshot', () => {

    test('a manual inner state set after the snapshot survives rollback', () => {
        // THE BUG. Scenario: engine sets Mara's mood at message 10, a snapshot
        // is taken there, the user hand-edits Rowan's mood at message 20, then
        // swipes message 10. Rollback full-replaced the whole map, so the user's
        // edit — made ten messages after the snapshot and nothing to do with the
        // abandoned timeline — vanished with no undo.
        setInnerState('Mara', 'wary; tired');
        const snapshot = getInnerStatesSnapshot();

        setInnerState('Rowan', 'furious, hiding it', { manual: true });

        restoreInnerStatesSnapshot(snapshot);

        expect(getInnerState('Mara')).toBe('wary; tired');
        expect(getInnerState('Rowan')).toBe('furious, hiding it');
    });

    test('an engine inner state set after the snapshot is rolled back', () => {
        // The other half: rollback must still do its job. A mood the engine
        // invented in the timeline being abandoned has to go.
        setInnerState('Mara', 'wary; tired');
        const snapshot = getInnerStatesSnapshot();

        setInnerState('Rowan', 'from the abandoned timeline');

        restoreInnerStatesSnapshot(snapshot);

        expect(getInnerState('Mara')).toBe('wary; tired');
        expect(getInnerState('Rowan')).toBeNull();
    });

    test('the snapshot wins for an NPC it already contains', () => {
        // Mirrors restoreLedgerSnapshot, which only rescues manual entries the
        // snapshot does NOT have. An NPC in the snapshot is engine state the
        // rollback is explicitly there to restore.
        setInnerState('Mara', 'calm');
        const snapshot = getInnerStatesSnapshot();

        setInnerState('Mara', 'panicking', { manual: true });
        restoreInnerStatesSnapshot(snapshot);

        expect(getInnerState('Mara')).toBe('calm');
    });

    test('a later engine write clears the manual flag', () => {
        // Once the engine legitimately moves an NPC's mood on, that line is
        // engine state again and must not be rescued from future rollbacks
        // forever. Otherwise one hand-edit pins that NPC permanently.
        setInnerState('Rowan', 'user set this', { manual: true });
        setInnerState('Rowan', 'engine moved on');

        const snapshot = getInnerStatesSnapshot();
        setInnerState('Kes', 'later engine line');
        restoreInnerStatesSnapshot(snapshot);

        expect(getInnerState('Rowan')).toBe('engine moved on');
        expect(getInnerStates().Rowan.manual).toBeFalsy();
    });

    test('clearing a manual state still deletes it', () => {
        setInnerState('Rowan', 'something', { manual: true });
        setInnerState('Rowan', '');
        expect(getInnerState('Rowan')).toBeNull();
    });

    test('a null or non-object snapshot is a no-op', () => {
        setInnerState('Mara', 'wary');
        restoreInnerStatesSnapshot(null);
        restoreInnerStatesSnapshot('nonsense');
        expect(getInnerState('Mara')).toBe('wary');
    });
});
