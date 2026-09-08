/**
 * test/relationships.test.js — The managed relationship block.
 *
 * The properties worth protecting:
 *   1. The stance line keeps its exact label. Presets match on that prefix to
 *      decide how far an NPC may push {{user}}; reword it and the gate silently
 *      stops firing, which reads as "the extension does nothing".
 *   2. Stance and edges share one block, and either one alone still produces
 *      a block — an NPC can have a stance and no relationships.
 *   3. An NPC with neither produces no block, so sync strips it rather than
 *      leaving an empty husk in the lorebook entry.
 *   4. Renames carry the stance across, or it silently reverts to inferred.
 *   5. The block is a BOUNDED projection, not a copy of the graph: notes stay
 *      out, same-type targets collapse, and the edge/character caps hold. This
 *      is the property that regressed into a 900-token entry on a minor NPC,
 *      and nothing in the store's shape stops it happening again.
 *   6. Rendering is deterministic. The block sits high in the prompt and is
 *      re-synced on the auto-extract cadence, so an unstable render costs a
 *      prompt-cache miss on every following turn for no content change.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getLorebookName } from '../knowledge/scope.js';
import { USER_STANCES } from '../knowledge/state.js';
import {
    updateRelationship, removeRelationship, removeAllRelationshipsFor,
    getStance, setStance, getStances, rekeyRelationships,
    formatRelationshipBlock, injectRelationshipBlock, stripRelationshipBlock,
    getNpcRelationships, selectRelationshipEdges, renderRelationshipEdges,
    RELATIONSHIP_BLOCK_MAX_EDGES, RELATIONSHIP_BLOCK_MAX_CHARS,
    SOURCE_AUTO, SOURCE_MANUAL,
} from '../knowledge/relationships.js';

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    // Mark the knowledge book hydrated so writes are accepted without a
    // fake lorebook behind them; flushes then no-op with a warning.
    _setCacheForTests(getLorebookName(), {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ─── Stance ─────────────────────────────────────────────────────────────────

describe('stance toward {{user}}', () => {
    test('emits the exact label presets gate on', () => {
        setStance('Mara', 'wary');
        // If this string changes, the preset's YIELD rule stops matching.
        expect(formatRelationshipBlock('Mara')).toBe('Stance toward {{user}}: wary.');
    });

    test('stance and edges coexist, stance first', () => {
        setStance('Mara', 'caring');
        updateRelationship('Mara', 'Jonah', 'friend', 'met at work');
        // The note is stored, not rendered — see the notes-exclusion block.
        expect(formatRelationshipBlock('Mara')).toBe(
            'Stance toward {{user}}: caring.\n'
            + 'Relationships: friend of Jonah.',
        );
    });

    test('edges alone still produce a block', () => {
        updateRelationship('Mara', 'Jonah', 'rival', '');
        expect(formatRelationshipBlock('Mara')).toBe('Relationships: rival of Jonah.');
    });

    test('an NPC with neither produces no block', () => {
        // Falsy return is what makes syncRelationshipsToLorebook strip instead
        // of injecting an empty block.
        expect(formatRelationshipBlock('Nobody')).toBe('');
    });

    test('clearing a stance drops only that line', () => {
        setStance('Mara', 'hostile');
        updateRelationship('Mara', 'Jonah', 'enemy', '');
        setStance('Mara', '');
        expect(getStance('Mara')).toBe('');
        expect(getStances()).not.toHaveProperty('Mara');
        expect(formatRelationshipBlock('Mara')).toBe('Relationships: enemy of Jonah.');
    });

    test('removing every edge leaves the stance line standing', () => {
        setStance('Mara', 'friendly');
        updateRelationship('Mara', 'Jonah', 'friend', '');
        removeRelationship('Mara', 'Jonah');
        expect(formatRelationshipBlock('Mara')).toBe('Stance toward {{user}}: friendly.');
    });

    test('removeAllRelationshipsFor leaves stance alone', () => {
        // Stance is cleared explicitly at the NPC-delete site, not here — this
        // pins the narrower contract the function name promises.
        setStance('Mara', 'wary');
        updateRelationship('Mara', 'Jonah', 'friend', '');
        removeAllRelationshipsFor('Mara');
        expect(getStance('Mara')).toBe('wary');
    });

    test('every enum value round-trips', () => {
        for (const s of USER_STANCES) {
            setStance('Mara', s);
            expect(getStance('Mara')).toBe(s);
            expect(formatRelationshipBlock('Mara')).toBe(`Stance toward {{user}}: ${s}.`);
        }
    });
});

// ─── Rename ─────────────────────────────────────────────────────────────────

describe('rekeyRelationships', () => {
    test('carries the stance to the new name', () => {
        setStance('Mara', 'wary');
        updateRelationship('Mara', 'Jonah', 'friend', '');
        rekeyRelationships('Mara', 'Mara Vance');
        expect(getStance('Mara')).toBe('');
        expect(getStance('Mara Vance')).toBe('wary');
        expect(formatRelationshipBlock('Mara Vance')).toBe(
            'Stance toward {{user}}: wary.\nRelationships: friend of Jonah.',
        );
    });

    test('a rename to the same name is a no-op', () => {
        setStance('Mara', 'caring');
        rekeyRelationships('Mara', 'Mara');
        expect(getStance('Mara')).toBe('caring');
    });

    test('renaming an NPC with no stance does not invent one', () => {
        updateRelationship('Mara', 'Jonah', 'friend', '');
        rekeyRelationships('Mara', 'Mara Vance');
        expect(getStances()).not.toHaveProperty('Mara Vance');
    });
});

// ─── Managed block round-trip ───────────────────────────────────────────────

describe('inject/strip round-trip', () => {
    test('a stance block replaces cleanly on re-sync', () => {
        const entry = 'Mara is a locksmith.';
        setStance('Mara', 'caring');
        const once = injectRelationshipBlock(entry, formatRelationshipBlock('Mara'));
        expect(once).toContain('Stance toward {{user}}: caring.');

        // Second sync must replace, not append — otherwise stale stances stack
        // up in the entry and the model sees two contradictory lines.
        setStance('Mara', 'hostile');
        const twice = injectRelationshipBlock(once, formatRelationshipBlock('Mara'));
        expect(twice).toContain('Stance toward {{user}}: hostile.');
        expect(twice).not.toContain('caring');
        expect(stripRelationshipBlock(twice)).toBe(entry);
    });
});

// ─── Compaction ─────────────────────────────────────────────────────────────
//
// The regression these pin: formatRelationshipBlock used to render every
// outbound edge with its full `notes` inlined, so an NPC's prompt cost grew
// with their lifetime number of connections. A minor character measured over
// 900 tokens. The store keeps everything; the block is now a bounded view.

describe('notes are evidence, not prompt text', () => {
    test('a note is stored and rendered nowhere near the block', () => {
        updateRelationship('Pete', 'Derek Sandhorn', 'employee', 'APEX freight/receiving; starts Monday, reports to Derek for shop duties');
        expect(getNpcRelationships('Pete')[0].notes)
            .toBe('APEX freight/receiving; starts Monday, reports to Derek for shop duties');
        expect(formatRelationshipBlock('Pete')).toBe('Relationships: employee of Derek Sandhorn.');
    });

    test('the real-world block collapses to its structural claim', () => {
        // Verbatim from the reported entry, notes included.
        updateRelationship('Pete', 'Derek Sandhorn', 'employee', 'APEX freight/receiving; starts Monday, reports to Derek for shop duties');
        updateRelationship('Pete', 'Ezra Blackwell', 'employee', 'Pete works for APEX under the administrative oversight of Ezra.');
        updateRelationship('Pete', 'Gerald Hronec', 'subordinate', 'Pete courier for Hronec check handoff; day-before freight calls.');
        expect(formatRelationshipBlock('Pete')).toBe(
            'Relationships: employee of Derek Sandhorn, Ezra Blackwell; subordinate of Gerald Hronec.',
        );
    });

    test('no edge note can reintroduce a parenthetical', () => {
        updateRelationship('Mara', 'Jonah', 'friend', '(met at the docks)');
        expect(formatRelationshipBlock('Mara')).not.toContain('(');
    });
});

describe('selectRelationshipEdges', () => {
    const edge = (target, type, source = SOURCE_MANUAL) => ({ target, type, source });

    test('manual edges outrank automatic ones under the cap', () => {
        // Same type, so only provenance can separate them. The hand-entered
        // edge is the user's statement; the extracted one is a model's read of
        // a message window, and it is the one that gives way.
        const { selected, omitted } = selectRelationshipEdges(
            [edge('Auto', 'friend', SOURCE_AUTO), edge('Manual', 'friend', SOURCE_MANUAL)],
            { maxEdges: 1 },
        );
        expect(selected.map(e => e.target)).toEqual(['Manual']);
        expect(omitted).toBe(1);
    });

    test('a missing source counts as manual, never as auto', () => {
        // The fail-safe direction isEdgeAutoManaged exists for: everything
        // written before provenance shipped was entered by hand.
        const { selected } = selectRelationshipEdges(
            [edge('Auto', 'friend', SOURCE_AUTO), { target: 'Legacy', type: 'friend' }],
            { maxEdges: 1 },
        );
        expect(selected.map(e => e.target)).toEqual(['Legacy']);
    });

    test('structural salience decides what survives the cut', () => {
        const { selected } = selectRelationshipEdges(
            [edge('Cara', 'acquaintance'), edge('Bo', 'family'), edge('Ada', 'friend')],
            { maxEdges: 2 },
        );
        expect(selected.map(e => e.target)).toEqual(['Bo', 'Ada']);
    });

    test('an unknown type sorts mid-tier, not last', () => {
        // A type the enum gains later must not be silently unrenderable.
        const { selected } = selectRelationshipEdges(
            [edge('Known', 'acquaintance'), edge('Novel', 'godparent')],
            { maxEdges: 1 },
        );
        expect(selected.map(e => e.target)).toEqual(['Novel']);
    });

    test('duplicate targets cannot spend two slots', () => {
        const { selected, omitted } = selectRelationshipEdges([
            edge('Jonah', 'friend'), edge('jonah', 'rival'), edge('Ada', 'ally'),
        ], { maxEdges: 3 });
        // Same tier and both manual, so the alphabetical tie-break orders
        // them; the point is that "jonah" did not survive as a second slot.
        expect(selected.map(e => e.target)).toEqual(['Ada', 'Jonah']);
        expect(omitted).toBe(0);
    });

    test('the character budget drops whole edges, never partial ones', () => {
        const edges = ['Anderson', 'Bellweather', 'Castellanos', 'Devereaux']
            .map(n => edge(n, 'ally'));
        const { selected } = selectRelationshipEdges(edges, { maxChars: 30 });
        const rendered = renderRelationshipEdges(selected);
        expect(rendered.length).toBeLessThanOrEqual(30);
        // Every surviving name is intact — a truncated name is a false claim
        // about who this NPC knows, not a shorter true one.
        for (const e of selected) expect(rendered).toContain(e.target);
    });

    test('one oversized edge is kept rather than rendering nothing', () => {
        const { selected } = selectRelationshipEdges(
            [edge('A'.repeat(500), 'family')],
            { maxChars: 10 },
        );
        expect(selected).toHaveLength(1);
    });

    test('an empty or malformed list is not a crash', () => {
        expect(selectRelationshipEdges([]).selected).toEqual([]);
        expect(selectRelationshipEdges(null).selected).toEqual([]);
        expect(selectRelationshipEdges([
            { target: '', type: 'friend' }, { target: 'Ada', type: '' }, null,
        ]).selected).toEqual([]);
    });
});

describe('rendering is deterministic', () => {
    test('insertion order cannot change the rendered string', () => {
        const names = ['Zoe', 'Ada', 'Mo'];
        const forward = names.map(n => ({ target: n, type: 'ally', source: SOURCE_MANUAL }));
        const reversed = [...forward].reverse();
        const render = list => renderRelationshipEdges(selectRelationshipEdges(list).selected);
        expect(render(forward)).toBe(render(reversed));
        expect(render(forward)).toBe('ally of Ada, Mo, Zoe');
    });

    test('a re-sync after a notes-only rewrite produces identical text', () => {
        // syncRelationshipsToLorebook skips the write when the entry would not
        // change. That short-circuit is what stops the auto-extract cadence
        // invalidating the prompt cache every 10 messages, and it only works
        // if a rephrased note leaves the block alone.
        setStance('Mara', 'wary');
        updateRelationship('Mara', 'Jonah', 'friend', 'note one');
        const first = formatRelationshipBlock('Mara');
        updateRelationship('Mara', 'Jonah', 'friend', 'note one, rephrased by the extractor');
        expect(formatRelationshipBlock('Mara')).toBe(first);
    });
});

describe('a dense graph stays bounded', () => {
    test('thirty noisy edges render within both caps', () => {
        for (let i = 0; i < 30; i++) {
            updateRelationship('Hub', 'Contact Number ' + i, 'acquaintance', 'x'.repeat(280));
        }
        const block = formatRelationshipBlock('Hub');
        const rendered = block.replace(/^Relationships: /, '').replace(/\.$/, '');
        expect(rendered.length).toBeLessThanOrEqual(RELATIONSHIP_BLOCK_MAX_CHARS);
        expect(block).not.toContain('xxx');
        // One type collapses to one clause, so edge count is not readable from
        // the separators — count the collapsed target list directly.
        expect(rendered.split(', ').length).toBeLessThanOrEqual(RELATIONSHIP_BLOCK_MAX_EDGES);
    });
});
