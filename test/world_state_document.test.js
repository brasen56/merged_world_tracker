/** Phase 1 shared World State Markdown contract. */
import { describe, expect, test } from 'vitest';

import {
    normalizePresentValue,
    normalizeSceneAnchor,
    parseCurrentScene,
    parseWorldStateSections,
    patchCurrentScene,
    projectWorldState,
    validateWorldStateDocument,
} from '../core/world_state_document.js';
import {
    ANNOTATED_PRESENT_SCENE,
    HOOK_BEARING_SCENE,
    MINIMAL_SCENE,
} from './fixtures/world_state_phase0.js';

describe('parseWorldStateSections', () => {
    test('matches headers only at line starts and preserves source slices', () => {
        const text = `${MINIMAL_SCENE}\n\n## Recent Changes\n- We discussed ## Plot Seeds, but it is not a header.`;
        const result = parseWorldStateSections(text);

        expect(result.sections.map(section => section.name)).toEqual(['Current Scene', 'Recent Changes']);
        expect(result.sections[1].raw).toContain('discussed ## Plot Seeds');
        expect(result.issues).toEqual([]);
    });

    test('reports duplicate known headers and unknown headers', () => {
        const text = `${MINIMAL_SCENE}\n\n## Pending\n- First\n\n## Pending\n- Second\n\n## Invented Header\n- No`;
        const result = parseWorldStateSections(text);

        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'duplicate-section', section: 'Pending' }),
            expect.objectContaining({ code: 'unknown-section', section: 'Invented Header' }),
        ]));
    });

    test('supports CRLF without normalizing the document', () => {
        const text = MINIMAL_SCENE.replaceAll('\n', '\r\n');
        const result = parseWorldStateSections(text);
        expect(result.lineEnding).toBe('\r\n');
        expect(result.sections[0].raw).toBe(text);
    });
});

describe('normalizePresentValue', () => {
    test('removes annotations before comma splitting and exact duplicates after it', () => {
        expect(normalizePresentValue(
            'Simon (living room, unpacking), Charlotte [bedroom, asleep], Simon, The Ash Fox',
        )).toEqual(['Simon', 'Charlotte', 'The Ash Fox']);
    });

    test('keeps titles, epithets, aliases, and source order', () => {
        expect(normalizePresentValue(
            'The Vixen, Captain of the Guard, Old Man Jenkins, Vix, The Vixen',
        )).toEqual(['The Vixen', 'Captain of the Guard', 'Old Man Jenkins', 'Vix']);
        expect(normalizePresentValue('')).toEqual([]);
    });

    test.each([
        ['Alex (kitchen, Bob, Carol', ['Alex (kitchen', 'Bob', 'Carol']],
        ['Alex, Bob]', ['Alex', 'Bob]']],
        ['Alex ([kitchen), Bob', ['Alex ([kitchen)', 'Bob']],
    ])('conservatively preserves names when annotations are malformed: %s', (value, expected) => {
        expect(normalizePresentValue(value)).toEqual(expected);
    });
});

describe('normalizeSceneAnchor', () => {
    test.each([
        ['June 4, 2026 2pm', { date: 'June 4, 2026', time: '2pm' }],
        ['June 4, 2026 2:30pm', { date: 'June 4, 2026', time: '2:30pm' }],
        ['June 4, 2026 14:30', { date: 'June 4, 2026', time: '14:30' }],
        ['June 4, 2026 late afternoon', { date: 'June 4, 2026', time: 'Late afternoon' }],
        ['Unknown', { date: 'Unknown' }],
    ])('splits an unambiguous Chronicle anchor: %s', (dateTime, patch) => {
        expect(normalizeSceneAnchor({ dateTime }).patch).toEqual(patch);
    });

    test('fails closed on ambiguous time prose', () => {
        const result = normalizeSceneAnchor({ dateTime: 'sometime after the meeting' });
        expect(result.ok).toBe(false);
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'ambiguous-date-time' }));
    });

    test.each(['around 2pm', 'June 4, 2026 around 2pm', 'about 2 bells after sunset'])
    ('fails closed on approximate or relative time prose: %s', dateTime => {
        const result = normalizeSceneAnchor({ dateTime });
        expect(result.ok).toBe(false);
        expect(result.patch).toEqual({});
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'ambiguous-date-time' }));
    });

    test('only preserves a compact location when its words remain contiguous and ordered', () => {
        expect(normalizeSceneAnchor({
            location: 'The harbour office on Customs Row', current: { location: 'Harbour office' },
        }).patch).toEqual({});
        expect(normalizeSceneAnchor({
            location: 'Office across the harbour', current: { location: 'Harbour office' },
        }).patch).toEqual({ location: 'Office across the harbour' });
        expect(normalizeSceneAnchor({
            location: 'Old Harbour officer station', current: { location: 'Harbour office' },
        }).patch).toEqual({ location: 'Old Harbour officer station' });
    });

    test.each(['June 4, 2026 14:30pm', 'June 4, 2026 00:30 AM', 'June 4, 2026 25:00'])
    ('fails closed on an invalid or contradictory clock: %s', dateTime => {
        const result = normalizeSceneAnchor({ dateTime });
        expect(result.ok).toBe(false);
        expect(result.patch).toEqual({});
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'invalid-clock' }));
    });
});

describe('parseCurrentScene', () => {
    test('returns raw values and a normalized roster from Current Scene only', () => {
        const text = `${ANNOTATED_PRESENT_SCENE}\n\n## Pending\nDate: Not the scene date\nPresent: Intruder`;
        const scene = parseCurrentScene(text);

        expect(scene.raw).toMatchObject({
            date: 'Unknown',
            time: 'Evening',
            location: 'Simon’s living room',
            present: 'Simon (living room, unpacking), Charlotte [bedroom, asleep], Sophie (in bed), The Ash Fox',
            situation: 'The household is settling in after the move.',
        });
        expect(scene.present).toEqual(['Simon', 'Charlotte', 'Sophie', 'The Ash Fox']);
    });

    test.each([
        ['Date'], ['Time'], ['Location'], ['Present'], ['Situation'],
    ])('reports a field-specific issue when %s is missing', label => {
        const text = MINIMAL_SCENE.split('\n').filter(line => !line.startsWith(`${label}:`)).join('\n');
        expect(parseCurrentScene(text).issues).toContainEqual(expect.objectContaining({
            code: 'missing-scene-field', field: label.toLowerCase(),
        }));
    });

    test('rejects duplicate fields and multiline scene values', () => {
        const duplicate = MINIMAL_SCENE.replace('Time: Late afternoon', 'Time: Late afternoon\nTime: Evening');
        expect(parseCurrentScene(duplicate).issues).toContainEqual(expect.objectContaining({
            code: 'duplicate-scene-field', field: 'time',
        }));

        const multiline = MINIMAL_SCENE.replace(
            'Situation: The group is waiting for the missing manifest.',
            'Situation: The group is waiting.\nThis continuation is not a scalar field.',
        );
        expect(parseCurrentScene(multiline).issues).toContainEqual(expect.objectContaining({
            code: 'unexpected-scene-content',
        }));
    });

    test.each([
        'Alex (kitchen, Bob, Carol',
        'Alex, Bob]',
        'Alex ([kitchen), Bob',
    ])('reports malformed Present annotation delimiters: %s', present => {
        const scene = parseCurrentScene(MINIMAL_SCENE.replace('Alex, Derek', present));
        expect(scene.issues).toContainEqual(expect.objectContaining({
            code: 'malformed-present-annotations', field: 'present',
        }));
    });
});

describe('patchCurrentScene', () => {
    test('changes only supplied values and leaves all other bytes unchanged', () => {
        const crlf = `${MINIMAL_SCENE}\n\n## Pending\n- Keep  spacing exactly.`.replaceAll('\n', '\r\n');
        const patched = patchCurrentScene(crlf, { time: 'Evening', location: 'Customs Row' });
        const expected = crlf
            .replace('Time: Late afternoon', 'Time: Evening')
            .replace('Location: Harbour office', 'Location: Customs Row');

        expect(patched).toBe(expected);
        expect(patchCurrentScene(crlf, {})).toBe(crlf);
    });

    test('normalizes Present only when it is explicitly patched', () => {
        const untouched = patchCurrentScene(ANNOTATED_PRESENT_SCENE, { time: 'Night' });
        expect(untouched).toContain('Present: Simon (living room, unpacking), Charlotte [bedroom, asleep], Sophie (in bed), The Ash Fox');

        const normalized = patchCurrentScene(ANNOTATED_PRESENT_SCENE, {
            present: 'Simon (living room, unpacking), Charlotte [asleep], Simon, The Vixen',
        });
        expect(normalized).toContain('Present: Simon, Charlotte, The Vixen');
    });

    test('can explicitly supply a missing legacy field without rewriting other lines', () => {
        const partial = MINIMAL_SCENE.replace('Time: Late afternoon\n', '');
        const patched = patchCurrentScene(partial, { time: 'Unknown' });
        expect(patched).toContain('Situation: The group is waiting for the missing manifest.\nTime: Unknown');
        expect(patched.replace('\nTime: Unknown', '')).toBe(partial);
    });

    test('refuses to patch a malformed Present value', () => {
        expect(() => patchCurrentScene(MINIMAL_SCENE, {
            present: 'Alex (kitchen, Bob, Carol',
        })).toThrow(/malformed annotation delimiters/);
    });
});

describe('validateWorldStateDocument', () => {
    test('accepts a valid Current Scene-only sparse document and unknown date/time', () => {
        const result = validateWorldStateDocument(MINIMAL_SCENE);
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.normalizedText).toBe(MINIMAL_SCENE);
    });

    test('fails duplicate scene headers, missing fields, unknown headers, and roleplay leakage', () => {
        const malformed = [
            MINIMAL_SCENE.replace('Location: Harbour office\n', ''),
            '',
            MINIMAL_SCENE,
            '',
            '## Made Up',
            'Suddenly, the room falls silent.',
        ].join('\n');
        const result = validateWorldStateDocument(malformed);

        expect(result.ok).toBe(false);
        expect(result.errors.map(entry => entry.code)).toEqual(expect.arrayContaining([
            'duplicate-section', 'missing-scene-field', 'unknown-section', 'roleplay-leakage',
        ]));
    });

    test('rejects Current Scene when another section appears first', () => {
        const text = `## Pending\n- The manifest is due tomorrow.\n\n${MINIMAL_SCENE}`;

        for (const mode of ['structural', 'default-contract', 'custom-prompt']) {
            const result = validateWorldStateDocument(text, { mode });
            expect(result.ok).toBe(false);
            expect(result.errors).toContainEqual(expect.objectContaining({ code: 'document-preamble' }));
        }
    });

    test.each([
        '*Alex walks into the room.*',
        '```text\nAlex walks into the room.\n```',
        'Alex asked, "Are you there?"',
        '“Are you there?” Alex asked.',
        '"Are you there"',
        '“Are you there”',
        'Alex walks into the room.',
    ])('rejects clear roleplay leakage: %s', leakedText => {
        const result = validateWorldStateDocument(`${MINIMAL_SCENE}\n\n## Recent Changes\n${leakedText}`);
        expect(result.ok).toBe(false);
        expect(result.errors).toContainEqual(expect.objectContaining({ code: 'roleplay-leakage' }));
    });

    test.each([
        '- Alex entered the room before the meeting.',
        '- Alex asked Mara whether the manifest was ready.',
        '- Alex described the replacement seal as "new".',
        '- **Alex**: Current goal is to locate the missing manifest.',
    ])('accepts legitimate factual bullets: %s', factualBullet => {
        const result = validateWorldStateDocument(`${MINIMAL_SCENE}\n\n## Recent Changes\n${factualBullet}`);
        expect(result.errors).not.toContainEqual(expect.objectContaining({ code: 'roleplay-leakage' }));
    });

    test.each([
        'Alex (kitchen, Bob, Carol',
        'Alex, Bob]',
        'Alex ([kitchen), Bob',
    ])('rejects malformed Present annotations without offering lossy normalization: %s', present => {
        const text = MINIMAL_SCENE.replace('Alex, Derek', present);
        for (const mode of ['structural', 'default-contract', 'custom-prompt']) {
            const result = validateWorldStateDocument(text, { mode });
            expect(result.ok).toBe(false);
            expect(result.errors).toContainEqual(expect.objectContaining({ code: 'malformed-present-annotations' }));
            expect(result.normalizedText).toBe(text);
        }
    });

    test('normalization is safe guidance structurally, strict for defaults, and a warning for custom prompts', () => {
        const structural = validateWorldStateDocument(ANNOTATED_PRESENT_SCENE);
        expect(structural.ok).toBe(true);
        expect(structural.warnings).toContainEqual(expect.objectContaining({ code: 'present-needs-normalization' }));
        expect(structural.normalizedText).toContain('Present: Simon, Charlotte, Sophie, The Ash Fox');
        expect(ANNOTATED_PRESENT_SCENE).toContain('Simon (living room, unpacking)');

        const builtin = validateWorldStateDocument(ANNOTATED_PRESENT_SCENE, { mode: 'default-contract' });
        expect(builtin.ok).toBe(false);
        expect(builtin.errors).toContainEqual(expect.objectContaining({ code: 'present-needs-normalization' }));

        const custom = validateWorldStateDocument(ANNOTATED_PRESENT_SCENE, {
            mode: 'custom-prompt', compactness: { situation: 10 },
        });
        expect(custom.ok).toBe(true);
        expect(custom.warnings.map(entry => entry.code)).toEqual(expect.arrayContaining([
            'present-needs-normalization', 'compactness-target-exceeded',
        ]));
    });
});

describe('projectWorldState', () => {
    test('separates factual and hook sections and always omits the stale archive', () => {
        const text = `${HOOK_BEARING_SCENE}\n\n## Archive (Stale)\n- Old secret`;
        const factual = projectWorldState(text, { view: 'factual' });
        const hooks = projectWorldState(text, { view: 'hooks' });

        expect(factual).toContain('## Current Scene');
        expect(factual).not.toContain('## Story Momentum');
        expect(factual).not.toContain('Old secret');
        expect(hooks).toContain('## Story Momentum');
        expect(hooks).toContain('## Plot Seeds');
        expect(hooks).toContain('## Potential Entrances');
        expect(hooks).not.toContain('## Current Scene');
        expect(projectWorldState(text)).not.toContain('Old secret');
    });
});