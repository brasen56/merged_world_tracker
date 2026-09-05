/**
 * test/alias_matchers.test.js — The alias list reaches the matchers
 * (TODO §1 identity service, the `[NEXT]` follow-up).
 *
 * knowledge/identity.js (v2.3.0) ships user-approved `aliases[]` that
 * `resolveRegistryKey()` honors — but two consumers were still alias-blind:
 *
 *   1. World State's grounding gate (provenance.js §5.3): a bolded entry
 *      under an alias spelling ("**The Vixen**") was stripped as a phantom,
 *      and a canonical name ("**Mara Vance**") was stripped when only the
 *      alias appeared in the evidence.
 *   2. Interiority's matchers: buildSceneRoster's registry union matched
 *      only canonical keys against recent messages (and only the legacy
 *      chat-metadata mirror, which never carries aliases), and the
 *      model-output resolver (resolveRosterName) knew only the given-name
 *      heuristic — so a title alias stranded an NPC off the roster or
 *      discarded their thoughts/intentions at validation.
 *
 * The alias list lives ONLY in the live lorebook-store registry; every
 * consumer here reads it through a dynamic import (optional-dependency
 * pattern) and fails soft to the pre-alias behaviour.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    resetCoreStubs, setFakeChat, setFakeContextExtras, getFakeMeta, setFakeApi,
    WORLD_STATE_METADATA_KEY,
} from './stubs/core.js';
import { saveSettings as saveKnowledgeSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests } from '../knowledge/store.js';

import { groundingGate, collectRegistryAliasGroups } from '../world_state/provenance.js';
import {
    buildSceneRoster, resolveRosterName, collectRosterAliases, mergeSplitResults,
    runStrictCalls,
} from '../interiority/generation.js';
import { saveSettings as saveInterioritySettings } from '../interiority/data.js';
import { getEvaluatedNpcNames } from '../interiority/index.js';

// The alias fixture used throughout: the user has approved "The Vixen" as an
// alternate spelling of registry NPC "Mara Vance".
const GROUPS = [{ owner: 'Mara Vance', aliases: ['The Vixen'] }];
const ALIAS_INDEX = { 'mara vance': ['The Vixen'] };

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveKnowledgeSettings({ scope: 'global' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─── World State: the grounding gate ─────────────────────────────────────────

describe('groundingGate consults the alias list', () => {
    test('a bold entry under an approved alias spelling is not a phantom', () => {
        // Neither "Vixen" nor "Mara Vance" appears in the evidence — the old
        // gate stripped this entry even though the user vouched for the name.
        const text = '## Key Character States\n- **The Vixen**:\n  - Mood: sharp';
        const gate = groundingGate(text, {
            scanText: 'The bar stood empty.',
            priorText: '',
            aliasGroups: GROUPS,
        });
        expect(gate.ok).toBe(true);
        expect(gate.stripped).toHaveLength(0);
        expect(gate.cleanedText).toContain('**The Vixen**');
    });

    test('strict mode accepts an alias spelling without burning the retry', () => {
        const gate = groundingGate('- **The Vixen**: gone', {
            scanText: 'nothing relevant',
            priorText: '',
            mode: 'strict',
            aliasGroups: GROUPS,
        });
        expect(gate.ok).toBe(true);
        expect(gate.stripped).toHaveLength(0);
    });

    test('the alias bridges: a canonical name is grounded by alias-only evidence', () => {
        // The scan window never says "Mara Vance" — only her alias does. The
        // user's alias decision says that is one person, so the canonical
        // label is traceable to the evidence through it.
        const gate = groundingGate('- **Mara Vance**: smiling', {
            scanText: 'The Vixen leaned on the bar and smiled.',
            priorText: '',
            aliasGroups: GROUPS,
        });
        expect(gate.ok).toBe(true);
        expect(gate.stripped).toHaveLength(0);
    });

    test('names with no alias and no evidence are still phantoms', () => {
        const gate = groundingGate('- **Lorraine**: plotting', {
            scanText: 'Rain on the roof.',
            priorText: '',
            mode: 'soft',
            aliasGroups: GROUPS,
        });
        expect(gate.ok).toBe(true);
        expect(gate.stripped.map(p => p.label)).toEqual(['Lorraine']);
        expect(gate.cleanedText).not.toContain('Lorraine');
    });

    test('an alias grounds only its own full spelling — a word of it is not the alias', () => {
        // "Vixen" alone is not the approved alias "The Vixen": the gate still
        // demands evidence for it, exactly as it would without aliases.
        const gate = groundingGate('- **Vixen**: prowling', {
            scanText: 'A fox darted past the window.',
            priorText: '',
            mode: 'soft',
            aliasGroups: GROUPS,
        });
        expect(gate.stripped.map(p => p.label)).toEqual(['Vixen']);
    });

    test('a canonical name with aliases but no evidence of any form stays a phantom', () => {
        // The bridge must not become "any aliased NPC is always grounded" —
        // that would defeat the anti-invention gate.
        const gate = groundingGate('- **Mara Vance**: scheming', {
            scanText: 'Somewhere a bell rang.',
            priorText: '',
            mode: 'soft',
            aliasGroups: GROUPS,
        });
        expect(gate.stripped.map(p => p.label)).toEqual(['Mara Vance']);
    });

    test('the bridge matches the alias as a whole phrase — its words alone are not evidence', () => {
        // "Red Fox" is the alias; the scan windows mention "red" (first
        // probe) and "fox" (second probe) in unrelated prose, never the
        // phrase itself. Word-level matching — nameIsGrounded's rule, right
        // for canonical names — grounded the owner's canonical name off
        // either word; the bridge must demand the whole alias.
        const groups = [{ owner: 'Mara Vance', aliases: ['Red Fox'] }];
        const probes = [
            'Jonah wiped his hands on a red rag and stared at the harbour.',
            'A fox darted past the window.',
        ];
        for (const scanText of probes) {
            const gate = groundingGate('- **Mara Vance**: watching', {
                scanText,
                priorText: '',
                mode: 'soft',
                aliasGroups: groups,
            });
            expect(gate.stripped.map(p => p.label)).toEqual(['Mara Vance']);
        }
    });

    test('the alias phrase itself bridges, whitespace-flexible', () => {
        const groups = [{ owner: 'Mara Vance', aliases: ['Red Fox'] }];
        const gate = groundingGate('- **Mara Vance**: watching', {
            scanText: 'The Red    Fox slipped out through the side door.',
            priorText: '',
            aliasGroups: groups,
        });
        expect(gate.ok).toBe(true);
        expect(gate.stripped).toHaveLength(0);
    });

    test('a dot-ended alias still bridges — no word boundary exists beside the trailing punctuation', () => {
        // Unconditional `\b…\b` never matched "A.J." — beside the trailing
        // dot there is no boundary to find, so the bridge missed the alias's
        // own evidence and stripped the canonical name as a phantom.
        const groups = [{ owner: 'Anthony Jarvis', aliases: ['A.J.'] }];
        const gate = groundingGate('- **Anthony Jarvis**: watching', {
            scanText: 'A.J. slammed the manifest on the table.',
            priorText: '',
            mode: 'soft',
            aliasGroups: groups,
        });
        expect(gate.stripped).toHaveLength(0);
    });

    test('a bracketed alias still bridges ("(Vixen)")', () => {
        const groups = [{ owner: 'Mara Vance', aliases: ['(Vixen)'] }];
        const gate = groundingGate('- **Mara Vance**: smiling', {
            scanText: 'The bartender called (Vixen) over.',
            priorText: '',
            mode: 'soft',
            aliasGroups: groups,
        });
        expect(gate.stripped).toHaveLength(0);
    });

    test('a dot-ended alias bridges on its possessive too ("A.J.\'s")', () => {
        const groups = [{ owner: 'Anthony Jarvis', aliases: ['A.J.'] }];
        const gate = groundingGate('- **Anthony Jarvis**: watching', {
            scanText: 'Everyone heard A.J.\u2019s footsteps on the stairs.',
            priorText: '',
            mode: 'soft',
            aliasGroups: groups,
        });
        expect(gate.stripped).toHaveLength(0);
    });

    test('a punctuation-edged alias does not bridge on its unpunctuated spelling', () => {
        // "AJ" is not the approved alias "A.J." — the dots are part of the
        // name the user vouched for.
        const groups = [{ owner: 'Anthony Jarvis', aliases: ['A.J.'] }];
        const gate = groundingGate('- **Anthony Jarvis**: watching', {
            scanText: 'AJ slammed the manifest down.',
            priorText: '',
            mode: 'soft',
            aliasGroups: groups,
        });
        expect(gate.stripped.map(p => p.label)).toEqual(['Anthony Jarvis']);
    });

    test('a single-word alias bridges only when that word appears', () => {
        // A one-word alias IS its own phrase: "the dock boss shouted" is
        // real alias evidence for alias "Boss"; unrelated prose is not.
        const groups = [{ owner: 'Mara Vance', aliases: ['Boss'] }];
        const grounded = groundingGate('- **Mara Vance**: watching', {
            scanText: 'The dock boss shouted orders.',
            priorText: '',
            aliasGroups: groups,
        });
        expect(grounded.stripped).toHaveLength(0);
        const phantom = groundingGate('- **Mara Vance**: watching', {
            scanText: 'Rain on the roof.',
            priorText: '',
            mode: 'soft',
            aliasGroups: groups,
        });
        expect(phantom.stripped.map(p => p.label)).toEqual(['Mara Vance']);
    });

    test('without aliasGroups the gate behaves exactly as before', () => {
        const gate = groundingGate('- **The Vixen**: gone', {
            scanText: 'The bar stood empty.',
            priorText: '',
            mode: 'soft',
        });
        expect(gate.stripped.map(p => p.label)).toEqual(['The Vixen']);
    });
});

describe('collectRegistryAliasGroups reads the live registry', () => {
    test('returns one group per aliased record, skipping alias-less records', async () => {
        _setCacheForTests('Knowledge Tracker', {
            registry: {
                'Mara Vance': { uid: 1, aliases: ['The Vixen'] },
                'Ezra Blackwell': { uid: 2 },
            },
        });
        expect(await collectRegistryAliasGroups()).toEqual(GROUPS);
    });

    test('an empty or alias-free registry yields no groups', async () => {
        _setCacheForTests('Knowledge Tracker', { registry: {} });
        expect(await collectRegistryAliasGroups()).toEqual([]);
    });
});

// ─── Interiority: the roster matcher ─────────────────────────────────────────

describe("buildSceneRoster unions registry NPCs in via their aliases", () => {
    beforeEach(() => {
        // The live store registry carries the alias; the legacy chat-metadata
        // mirror is empty (modern chats seed it once, and it never carries
        // aliases) — this is exactly the shape the fix must handle.
        _setCacheForTests('Knowledge Tracker', {
            registry: {
                'Ezra Blackwell': { uid: 1 },
                'Mara Vance': { uid: 2, aliases: ['The Vixen'] },
            },
        });
        setFakeContextExtras({ name1: 'Alex', name2: 'Ezra Blackwell' });
        // The incomplete Present: line names only Ezra — the union exists for
        // precisely this failure.
        getFakeMeta()[WORLD_STATE_METADATA_KEY] = { text: 'Present: Ezra Blackwell' };
    });

    test('an NPC present only under an alias spelling reaches the roster canonically', async () => {
        setFakeChat([
            { mes: 'Ezra leaned against the doorframe.', name: 'Ezra Blackwell', is_user: false },
            { mes: 'The Vixen slipped out through the side door.', name: 'Narrator', is_user: false },
        ]);
        const roster = await buildSceneRoster();
        expect(roster).toContain('Ezra Blackwell');
        expect(roster).toContain('Mara Vance'); // rescued by the alias match
    });

    test('no canonical and no alias mention keeps the NPC off the roster', async () => {
        setFakeChat([
            { mes: 'Ezra nodded once and left.', name: 'Ezra Blackwell', is_user: false },
        ]);
        const roster = await buildSceneRoster();
        expect(roster).toContain('Ezra Blackwell');
        expect(roster).not.toContain('Mara Vance');
    });

    test('the player character is still excluded even under an alias-shaped match', async () => {
        // The union must not become a back door for the PC.
        setFakeChat([
            { mes: 'Alex crossed the room toward Ezra.', name: 'Alex', is_user: true },
            { mes: 'The Vixen watched from the stairs.', name: 'Narrator', is_user: false },
        ]);
        const roster = await buildSceneRoster();
        expect(roster).not.toContain('Alex');
        expect(roster).toContain('Mara Vance');
    });
});

describe("buildSceneRoster matches punctuation-edged aliases", () => {
    beforeEach(() => {
        // "A.J." is free text the user approved — its edges are punctuation,
        // which an unconditional `\b` wrapper could never match, so the NPC
        // failed scene detection whenever the chat only used the alias.
        _setCacheForTests('Knowledge Tracker', {
            registry: {
                'Ezra Blackwell': { uid: 1 },
                'Anthony Jarvis': { uid: 2, aliases: ['A.J.'] },
            },
        });
        setFakeContextExtras({ name1: 'Alex', name2: 'Ezra Blackwell' });
        // Present names only Ezra — the union exists for precisely this gap.
        getFakeMeta()[WORLD_STATE_METADATA_KEY] = { text: 'Present: Ezra Blackwell' };
    });

    test('an NPC present only as "A.J." reaches the roster canonically', async () => {
        setFakeChat([
            { mes: 'Ezra poured two glasses.', name: 'Ezra Blackwell', is_user: false },
            { mes: 'A.J. slammed the door and left without a word.', name: 'Narrator', is_user: false },
        ]);
        const roster = await buildSceneRoster();
        expect(roster).toContain('Ezra Blackwell');
        expect(roster).toContain('Anthony Jarvis'); // rescued by the edge-aware alias match
    });

    test('the unpunctuated spelling "AJ" is not the alias', async () => {
        setFakeChat([
            { mes: 'Ezra poured two glasses.', name: 'Ezra Blackwell', is_user: false },
            { mes: 'AJ slammed the door and left without a word.', name: 'Narrator', is_user: false },
        ]);
        const roster = await buildSceneRoster();
        expect(roster).toContain('Ezra Blackwell');
        expect(roster).not.toContain('Anthony Jarvis');
    });
});

// ─── Interiority: the model-output matcher ───────────────────────────────────

describe('resolveRosterName honors explicit registry aliases', () => {
    test('a title alias resolves to its roster member', () => {
        // "The Vixen" shares no token with "Mara Vance" — the given-name
        // heuristic can never prove this; only the user's alias can.
        expect(resolveRosterName(['Mara Vance'], 'The Vixen', ALIAS_INDEX)).toBe('Mara Vance');
    });

    test('an alias claimed by two roster members fails closed', () => {
        const index = { 'mara vance': ['The Vixen'], 'mara chen': ['The Vixen'] };
        expect(resolveRosterName(['Mara Vance', 'Mara Chen'], 'The Vixen', index)).toBeNull();
    });

    test('without an index the title alias stays unresolvable (heuristic only)', () => {
        expect(resolveRosterName(['Mara Vance'], 'The Vixen')).toBeNull();
        expect(resolveRosterName(['Mara Vance'], 'The Vixen', null)).toBeNull();
    });

    test('the heuristic steps still work alongside the index', () => {
        expect(resolveRosterName(['Mara Vance', 'Ezra'], 'Mara', ALIAS_INDEX)).toBe('Mara Vance');
        expect(resolveRosterName(['Mara Vance'], '  the vixen ', ALIAS_INDEX)).toBe('Mara Vance');
    });

    test('collectRosterAliases indexes by roster spelling', async () => {
        _setCacheForTests('Knowledge Tracker', {
            registry: {
                'Mara Vance': { uid: 1, aliases: ['The Vixen'] },
                'Ezra Blackwell': { uid: 2 },
            },
        });
        expect(await collectRosterAliases(['Mara Vance', 'Ezra Blackwell'])).toEqual(ALIAS_INDEX);
    });

    test('collectRosterAliases is inert for an empty roster', async () => {
        expect(await collectRosterAliases([])).toEqual({});
    });
});

describe('mergeSplitResults resolves alias spellings when given the index', () => {
    test('a call answered with the alias still merges', () => {
        const merged = mergeSplitResults(
            { npcs: [{ name: 'The Vixen', new_intentions: [{ action: 'flee the guild', trigger: 'dawn' }] }] },
            { npcs: [{ name: 'Mara Vance', reaction: { re: 'the closed shutters', thought: 'Too many eyes tonight.' } }] },
            ['Mara Vance'],
            ALIAS_INDEX,
        );
        expect(merged.npcs).toHaveLength(1);
        expect(merged.npcs[0].name).toBe('Mara Vance');
        expect(merged.npcs[0].reaction.thought).toBe('Too many eyes tonight.');
        expect(merged.npcs[0].new_intentions).toHaveLength(1);
    });

    test('without the index the alias answer is dropped (the old behaviour)', () => {
        const merged = mergeSplitResults(
            { npcs: [{ name: 'The Vixen', new_intentions: [{ action: 'flee', trigger: 'dawn' }] }] },
            null,
            ['Mara Vance'],
        );
        expect(merged.npcs).toHaveLength(1);
        expect(merged.npcs[0].new_intentions).toBeUndefined();
    });
});

describe('getEvaluatedNpcNames resolves alias spellings with the index', () => {
    test('an alias-spelled response name counts as evaluated', () => {
        expect(getEvaluatedNpcNames(
            { npcs: [{ name: 'The Vixen' }] },
            ['Mara Vance'],
            undefined,
            ALIAS_INDEX,
        )).toEqual(['Mara Vance']);
    });

    test('without the index the alias answer does not count', () => {
        expect(getEvaluatedNpcNames({ npcs: [{ name: 'The Vixen' }] }, ['Mara Vance'])).toEqual([]);
    });

    test('a fuller heuristic spelling still resolves even without an index', () => {
        // The refactor routes inference through resolveRosterName, which also
        // keeps the Charlotte / Charlotte Simpson case working here.
        expect(getEvaluatedNpcNames(
            { npcs: [{ name: 'Charlotte Simpson' }] },
            ['Charlotte'],
        )).toEqual(['Charlotte']);
    });
});

describe('runStrictCalls counts an evaluation only when the FULL roster resolves the answer to that member', () => {
    // The per-NPC evaluation check used to resolve each answer against its
    // singleton slice [name]. With two roster members importing the same
    // alias, each singleton counted the ambiguous answer as ITS successful
    // evaluation — both dormant entries were then confirmed and awakened even
    // though full-roster validation (validateAndApply) rejects the ambiguous
    // blocks. The fix resolves against `roster` and counts the evaluation
    // only when it lands on this loop's member.
    const CHAT = [
        { name: 'User', is_user: true, mes: 'The guild meeting drags on.', extra: {} },
        { name: 'Mara Vance', mes: 'Mara watches the door.', extra: {} },
    ];

    beforeEach(() => {
        globalThis.document = {
            dispatchEvent: vi.fn(),
            getElementById: () => null,
            querySelectorAll: () => [],
        };
        setFakeChat(CHAT);
        saveInterioritySettings({
            apiUrl: 'https://example.test', modelName: 'test',
            generateThoughts: false, generateIntentions: true,
        });
    });

    test('a duplicate alias claimed by two roster members evaluates NEITHER', async () => {
        const index = { 'mara vance': ['The Vixen'], 'mara chen': ['The Vixen'] };
        // Every strict call is answered with the ambiguous alias.
        setFakeApi(async () => JSON.stringify({ npcs: [{ name: 'The Vixen' }] }));

        const result = await runStrictCalls(['Mara Vance', 'Mara Chen'], [], { aliasIndex: index });

        expect(result.intentionsEvaluatedRoster).toEqual([]);
    });

    test('a fuller spelling of this member still counts', async () => {
        setFakeApi(async () => JSON.stringify({ npcs: [{ name: 'Charlotte Simpson' }] }));

        const result = await runStrictCalls(['Charlotte'], [], { aliasIndex: {} });

        expect(result.intentionsEvaluatedRoster).toEqual(['Charlotte']);
    });

    test("another member's exact name does not count for this loop's member", async () => {
        // The answer resolves — just not to the NPC whose call produced it.
        setFakeApi(async () => JSON.stringify({ npcs: [{ name: 'Ezra Blackwell' }] }));

        const result = await runStrictCalls(['Mara Vance', 'Ezra Blackwell'], [], { aliasIndex: {} });

        expect(result.intentionsEvaluatedRoster).toEqual(['Ezra Blackwell']);
    });
});
