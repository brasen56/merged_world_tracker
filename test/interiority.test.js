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

import { describe, test, expect, beforeEach } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import {
    getLedger, setLedger, restoreLedgerSnapshot,
    getInnerState, getInnerStates, setInnerState,
    getInnerStatesSnapshot, restoreInnerStatesSnapshot,
} from '../interiority/data.js';

beforeEach(() => resetCoreStubs());

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
