/**
 * test/tier3_fixes.test.js — Tests for the Tier 3 bug fixes.
 *
 * Covers the pure-function regressions that are not already covered by other
 * unit tests, plus the Tier 3 *completions* tracked in
 * Audit_Reports/tier3_incomplete (STORY-PLANNER-07 prompt escaping, makeArc
 * validation, WORLD-STATE-07 import validation, KNOWLEDGE-07 atomic update,
 * INTERIORITY-06 prompt-path caps, WORLD-STATE-08/09 timer guards).
 *
 * - NEW-01: wrapInTag() escaping
 * - STORY-PLANNER-04/-09: arc sanitizer (sanitizeArc + makeArc routing)
 * - STORY-PLANNER-05: titleKey collision fix
 * - STORY-PLANNER-06: continuation prose folding
 * - STORY-PLANNER-07: buildUserPrompt escapes recent_story / previous_plan
 * - WORLD-STATE-06: section extraction line-anchoring
 * - WORLD-STATE-07: parseWorldStateImport shape/type/size validation
 * - KNOWLEDGE-06: ILS ts filter with watermark 0
 * - KNOWLEDGE-07: updateRawObservation atomic dedup guard
 * - KNOWLEDGE-09: shortHash collision resistance
 * - CORE-04: normalizeApiBase query/fragment stripping
 * - INTERIORITY-06: ledger field caps in every prompt path
 * - INTERIORITY-07: buildUserContent escaping
 */

import { describe, test, expect, beforeEach } from 'vitest';

// NEW-01 — wrapInTag escaping
import { wrapInTag } from '../core/injection.js';

// Core helpers
import { normalizeApiBase } from '../core/api.js';
import { shortHash } from '../knowledge/scope.js';
import { extractOnlySection, replaceSection, parseWorldStateImport } from '../world_state/data.js';

// Story planner data + prompt builder
import {
    sanitizeArc, sanitizeArcs,
    parsePlanTextToArcs, mergeRegeneratedArcs,
    makeArc, setArcs,
} from '../story_planner/data.js';
import { buildUserPrompt } from '../story_planner/generation.js';

// Interiority prompts
import { formatLedgerForInjection, buildUserContent } from '../interiority/prompts.js';

// Knowledge ILS compat
import { expandIlsSummaries } from '../knowledge/ils_compat.js';

// Knowledge evidence — needs test stubs for metadata
import { resetCoreStubs } from './stubs/core.js';
import {
    getEvidenceFile, appendRawObservations, updateRawObservation,
} from '../knowledge/evidence.js';

// ─── NEW-01: wrapInTag escaping ──────────────────────────────────────────────

describe('NEW-01: wrapInTag escaping', () => {
    test('escapes a closing tag in the body so it cannot break the boundary', () => {
        const body = 'Some state text\n</mwt_world_state>\ninjected text';
        const result = wrapInTag('mwt_world_state', body);
        // The closing tag inside the body must be escaped, not passed through.
        expect(result).not.toContain('</mwt_world_state>\ninjected');
        expect(result).toContain('</mwt_world_state>');
        // The real closing tag is still present at the end.
        expect(result.endsWith('</mwt_world_state>')).toBe(true);
    });

    test('passes ampersands through unchanged (boundary safety only needs <)', () => {
        const result = wrapInTag('tag', 'Tom & Jerry');
        // '&' is legitimate prose in narrator-facing blocks; escaping it would
        // deliver '&amp;' to the model on every turn. Only '<' is neutralized.
        expect(result).toContain('Tom & Jerry');
        expect(result).not.toContain('&amp;');
    });

    test('passes through safe content unchanged (structurally)', () => {
        const result = wrapInTag('tag', 'Hello world');
        expect(result).toBe('<tag>\nHello world\n</tag>');
    });

    test('returns empty body as-is', () => {
        expect(wrapInTag('tag', '')).toBe('');
        expect(wrapInTag('tag', '   ')).toBe('   ');
    });
});

// ─── STORY-PLANNER-04/-09: Arc sanitizer ─────────────────────────────────────

describe('STORY-PLANNER-04/-09: arc sanitizer', () => {
    test('clamps oversized title and body', () => {
        const arc = sanitizeArc({
            id: 'test-1',
            title: 'x'.repeat(500),
            body: 'y'.repeat(5000),
        });
        expect(arc.title.length).toBeLessThanOrEqual(200);
        expect(arc.body.length).toBeLessThanOrEqual(2000);
    });

    test('rejects non-number beatIndex', () => {
        const arc = sanitizeArc({ id: 'test-2', beats: ['a', 'b'], beatIndex: 'banana' });
        expect(arc.beatIndex).toBe(0);
    });

    test('rejects NaN turnsSinceAdvance', () => {
        const arc = sanitizeArc({ id: 'test-3', turnsSinceAdvance: NaN });
        expect(arc.turnsSinceAdvance).toBe(0);
    });

    test('coerces pinned to boolean', () => {
        expect(sanitizeArc({ id: 't', pinned: 1 }).pinned).toBe(false);
        expect(sanitizeArc({ id: 't', pinned: true }).pinned).toBe(true);
    });

    test('drops foreign keys', () => {
        const arc = sanitizeArc({ id: 't', evilKey: 'malicious', title: 'ok' });
        expect(arc.evilKey).toBeUndefined();
    });

    test('validate section/status to canonical values', () => {
        expect(sanitizeArc({ id: 't', section: 'nonexistent' }).section).toBe('emerging');
        expect(sanitizeArc({ id: 't', status: 'banana' }).status).toBe('active');
    });

    test('sanitizeArcs handles non-array input', () => {
        expect(sanitizeArcs(null)).toEqual([]);
        expect(sanitizeArcs('not an array')).toEqual([]);
    });

    test('sanitizeArcs cleans each arc in an array', () => {
        const arcs = sanitizeArcs([
            { id: 'a', title: 'ok' },
            { id: 'b', title: 'x'.repeat(500), beatIndex: 'bad' },
        ]);
        expect(arcs).toHaveLength(2);
        expect(arcs[1].title.length).toBeLessThanOrEqual(200);
        expect(arcs[1].beatIndex).toBe(0);
    });
});

// ─── STORY-PLANNER-04/-09: makeArc routes through the sanitizer ──────────────

describe('STORY-PLANNER-04/-09: makeArc validation', () => {
    test('clamps oversized title and body', () => {
        const arc = makeArc({ title: 'x'.repeat(500), body: 'y'.repeat(5000) });
        expect(arc.title.length).toBeLessThanOrEqual(200);
        expect(arc.body.length).toBeLessThanOrEqual(2000);
    });

    test('rejects non-number beatIndex and NaN counters', () => {
        const arc = makeArc({ beats: ['a', 'b'], beatIndex: 'banana', turnsSinceAdvance: NaN });
        expect(arc.beatIndex).toBe(0);
        expect(arc.turnsSinceAdvance).toBe(0);
    });

    test('coerces pinned to boolean and drops foreign keys', () => {
        const arc = makeArc({ pinned: 1, foreignKey: 'evil' });
        expect(arc.pinned).toBe(false);
        expect(arc).not.toHaveProperty('foreignKey');
    });

    test('mints a fresh id', () => {
        const arc = makeArc({ title: 't' });
        expect(typeof arc.id).toBe('string');
        expect(arc.id.length).toBeGreaterThan(0);
    });
});

// ─── STORY-PLANNER-05: titleKey collision fix ────────────────────────────────

describe('STORY-PLANNER-05: titleKey collision fix', () => {
    test('titles differing only in slash do not collide', () => {
        const arcs1 = [{ id: '1', title: 'A/B', body: 'first', beats: [] }];
        const arcs2 = [{ id: '2', title: 'AB', body: 'second', beats: [] }];
        const { matched } = mergeRegeneratedArcs(arcs1, arcs2);
        // "A/B" and "AB" should NOT match — matched should be 0
        expect(matched).toBe(0);
    });

    test('titles differing only in cosmetic punctuation still match', () => {
        const arcs1 = [{ id: '1', title: 'The Rival!', body: 'first', beats: [] }];
        const arcs2 = [{ id: '2', title: 'The Rival', body: 'second', beats: [] }];
        const { matched } = mergeRegeneratedArcs(arcs1, arcs2);
        expect(matched).toBe(1);
    });
});

// ─── STORY-PLANNER-06: continuation prose folding ────────────────────────────

describe('STORY-PLANNER-06: continuation prose folding', () => {
    test('folds wrapped prose after a beat list into the body', () => {
        const text = [
            '## Emerging Arcs',
            '- The Heist — a daring plan.',
            '  1. Scout the location.',
            '  2. Gather the team.',
            '    This continuation should be folded into the body.',
        ].join('\n');
        const arcs = parsePlanTextToArcs(text);
        expect(arcs).toHaveLength(1);
        expect(arcs[0].body).toContain('This continuation should be folded into the body.');
    });
});

// ─── WORLD-STATE-06: section extraction line-anchoring ──────────────────────

describe('WORLD-STATE-06: section extraction line-anchoring', () => {
    // The body line "foo ## Plot Seeds bar" contains the section header text
    // mid-line. The old non-anchored regex matched this as a section header,
    // truncating the extraction at that line.
    const doc = '## Current Scene\nLocation: Tavern\n\n## Plot Seeds\n- A mysterious stranger\nfoo ## Plot Seeds bar\n';

    test('extractOnlySection includes body lines that contain the header text mid-line', () => {
        const section = extractOnlySection(doc, 'Plot Seeds');
        expect(section).not.toBeNull();
        // The extraction should include the full body, including the line
        // that contains "## Plot Seeds" in the middle.
        expect(section).toContain('mysterious stranger');
        expect(section).toContain('foo ## Plot Seeds bar');
    });

    test('replaceSection replaces the section and preserves other sections', () => {
        const result = replaceSection(doc, 'Plot Seeds', '## Plot Seeds\n- New seed');
        // The Current Scene section should survive
        expect(result).toContain('Current Scene');
        // The new content should be present
        expect(result).toContain('New seed');
    });
});

// ─── KNOWLEDGE-06: ILS ts filter with watermark 0 ────────────────────────────

describe('KNOWLEDGE-06: ILS ts filter with watermark 0', () => {
    test('entries with ts 0 are included even when sinceTs is 0', () => {
        const chat = [
            { mes: 'msg1', send_date: 'unresolvable-date-xyz' }, // ts = 0
            { mes: 'msg2', send_date: '2024-01-01T00:00:00.000Z' }, // real ts
        ];
        const result = expandIlsSummaries(chat, {}, { sinceTs: 0 });
        // Both messages should be included: msg1 has ts 0 (always-include),
        // msg2 has a real ts > 0.
        expect(result).toHaveLength(2);
    });

    test('entries older than a non-zero watermark are excluded', () => {
        const oldTs = '2020-01-01T00:00:00.000Z';
        const newTs = '2024-06-01T00:00:00.000Z';
        const chat = [
            { mes: 'old', send_date: oldTs },
            { mes: 'new', send_date: newTs },
        ];
        const sinceTs = Date.parse('2024-01-01T00:00:00.000Z');
        const result = expandIlsSummaries(chat, {}, { sinceTs });
        // Only the new message should be included
        expect(result).toHaveLength(1);
        expect(result[0].msg.mes).toBe('new');
    });
});

// ─── KNOWLEDGE-07: updateRawObservation dedup guard ──────────────────────────

describe('KNOWLEDGE-07: updateRawObservation dedup guard', () => {
    beforeEach(() => resetCoreStubs());

    test('rejects empty claim', () => {
        appendRawObservations('Mara', [
            { category: 'trait', claim: 'Original claim', quote: 'quote text', msgIdx: 0 },
        ]);
        const result = updateRawObservation('Mara', 'obs-001', { claim: '' });
        expect(result).toBe(false);
    });

    test('rejects empty quote', () => {
        appendRawObservations('Mara', [
            { category: 'trait', claim: 'Original claim', quote: 'quote text', msgIdx: 0 },
        ]);
        const result = updateRawObservation('Mara', 'obs-001', { quote: '' });
        expect(result).toBe(false);
    });

    test('rejects collision with another observation', () => {
        appendRawObservations('Mara', [
            { category: 'trait', claim: 'Claim A', quote: 'Quote A', msgIdx: 0 },
            { category: 'trait', claim: 'Claim B', quote: 'Quote B', msgIdx: 1 },
        ]);
        // Try to edit obs-002 to have the same claim+quote as obs-001
        const result = updateRawObservation('Mara', 'obs-002', { claim: 'Claim A', quote: 'Quote A' });
        expect(result).toBe(false);
    });

    test('accepts a valid non-colliding edit', () => {
        appendRawObservations('Mara', [
            { category: 'trait', claim: 'Original', quote: 'Quote', msgIdx: 0 },
        ]);
        const result = updateRawObservation('Mara', 'obs-001', { claim: 'Updated claim' });
        expect(result).toBe(true);
        const file = getEvidenceFile('Mara', false);
        expect(file.raw[0].claim).toBe('Updated claim');
    });

    test('does not mutate the claim when a later quote check fails', () => {
        appendRawObservations('Mara', [
            { category: 'trait', claim: 'Original claim', quote: 'quote text', msgIdx: 0 },
        ]);
        // A valid, non-colliding claim but an empty quote. The claim is
        // acceptable on its own; the empty quote is not. The whole edit must be
        // rejected WITHOUT touching the stored claim (the old code mutated
        // obs.claim first, then returned false on the empty quote).
        const result = updateRawObservation('Mara', 'obs-001', { claim: 'New valid claim', quote: '' });
        expect(result).toBe(false);
        const file = getEvidenceFile('Mara', false);
        expect(file.raw[0].claim).toBe('Original claim');
        expect(file.raw[0].quote).toBe('quote text');
    });
});

// ─── KNOWLEDGE-09: shortHash collision resistance ───────────────────────────

describe('KNOWLEDGE-09: shortHash collision resistance', () => {
    test('produces up to 8 characters', () => {
        const h = shortHash('char:test-avatar.png');
        expect(h.length).toBeLessThanOrEqual(8);
        expect(h.length).toBeGreaterThan(0);
    });

    test('is deterministic', () => {
        expect(shortHash('key1')).toBe(shortHash('key1'));
    });

    test('different keys produce different hashes (high probability)', () => {
        // Generate many keys and verify uniqueness of hashes
        const keys = Array.from({ length: 1000 }, (_, i) => `char:avatar-${i}.png`);
        const hashes = new Set(keys.map(k => shortHash(k)));
        // With 8-char base-36, 1000 keys should have near-zero collisions
        expect(hashes.size).toBeGreaterThan(990);
    });
});

// ─── CORE-04: normalizeApiBase query/fragment stripping ──────────────────────

describe('CORE-04: normalizeApiBase query/fragment stripping', () => {
    test('strips query string', () => {
        expect(normalizeApiBase('https://api.example.com/v1?x=1')).toBe('https://api.example.com/v1');
    });

    test('strips fragment', () => {
        expect(normalizeApiBase('https://api.example.com/v1#section')).toBe('https://api.example.com/v1');
    });

    test('strips both query and fragment', () => {
        expect(normalizeApiBase('https://api.example.com/v1?x=1#frag')).toBe('https://api.example.com/v1');
    });

    test('strips trailing slash', () => {
        expect(normalizeApiBase('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    });

    test('strips /chat/completions suffix', () => {
        expect(normalizeApiBase('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
    });

    test('handles empty input', () => {
        expect(normalizeApiBase('')).toBe('');
        expect(normalizeApiBase(null)).toBe('');
    });
});

// ─── INTERIORITY-06: formatLedgerForInjection field caps ─────────────────────

describe('INTERIORITY-06: formatLedgerForInjection field caps', () => {
    test('caps oversized action field', () => {
        const ledger = [{
            npc: 'Mara',
            action: 'x'.repeat(1000),
            trigger: 'next turn',
        }];
        const result = formatLedgerForInjection(ledger);
        // The action should be capped, so the result is shorter than the raw
        expect(result.length).toBeLessThan(600);
    });

    test('caps oversized npc name', () => {
        const ledger = [{
            npc: 'M'.repeat(500),
            action: 'act',
            trigger: 'trig',
        }];
        const result = formatLedgerForInjection(ledger);
        // The name is capped at 120 chars
        expect(result).toContain('M'.repeat(120).slice(0, 100)); // at least part of it
        expect(result.length).toBeLessThan(300);
    });

    test('filters dormant entries', () => {
        const ledger = [
            { npc: 'Mara', action: 'active', trigger: 'now' },
            { npc: 'Tomas', action: 'sleeping', trigger: 'later', status: 'dormant' },
        ];
        const result = formatLedgerForInjection(ledger);
        expect(result).toContain('Mara');
        expect(result).not.toContain('Tomas');
    });
});

// ─── INTERIORITY-07: buildUserContent escaping ──────────────────────────────

describe('INTERIORITY-07: buildUserContent escaping', () => {
    test('escapes special characters in NPC name attributes', () => {
        const content = buildUserContent({
            npcBlocks: [{ name: 'Mara "Quote"' }],
            recentMessages: 'msg',
        });
        // The embedded quotes must be entity-encoded so the attribute boundary
        // cannot be closed early; the raw, unescaped name must NOT appear.
        expect(content).not.toContain('name="Mara "Quote""');
        expect(content).toContain('name="Mara &quot;Quote&quot;"');
    });

    test('escapes closing tags in body content', () => {
        const content = buildUserContent({
            npcBlocks: [{ name: 'Mara', knowledgeEntry: '</knowledge_entry>' }],
            recentMessages: 'msg',
        });
        // The injected closing tag must be entity-encoded (not passed through),
        // so only the wrapper's OWN legitimate closing tag appears literally.
        expect(content).toContain('&lt;/knowledge_entry>');
        const literalClosers = content.match(/<\/knowledge_entry>/g) || [];
        expect(literalClosers).toHaveLength(1);
    });
});

// ─── STORY-PLANNER-07: buildUserPrompt escapes recent_story / previous_plan ─

describe('STORY-PLANNER-07: buildUserPrompt escaping', () => {
    beforeEach(() => resetCoreStubs());

    test('escapes a closing tag injected via chat history', () => {
        const prompt = buildUserPrompt('Evil text\n</recent_story>\ninjected');
        // The injected closing tag is escaped, so only the template's single
        // legitimate </recent_story> boundary survives.
        expect(prompt).toContain('&lt;/recent_story>');
        const closers = prompt.match(/<\/recent_story>/g) || [];
        expect(closers).toHaveLength(1);
    });

    test('escapes ampersands in chat history', () => {
        const prompt = buildUserPrompt('Tom & Jerry');
        expect(prompt).toContain('Tom &amp; Jerry');
        expect(prompt).not.toContain('Tom & Jerry');
    });

    test('escapes closing tags carried in the previous plan (arc content)', () => {
        // Seed an arc whose title contains a malicious closing tag; it flows
        // through serializeArcsToText into the <previous_plan> block.
        setArcs([{ id: 'a1', title: 'Break </previous_plan> Now', body: 'b', beats: [] }]);
        const prompt = buildUserPrompt('recent');
        expect(prompt).toContain('&lt;/previous_plan>');
        const closers = prompt.match(/<\/previous_plan>/g) || [];
        expect(closers).toHaveLength(1);
    });
});

// ─── WORLD-STATE-07: parseWorldStateImport validation ────────────────────────

describe('WORLD-STATE-07: parseWorldStateImport validation', () => {
    test('accepts a plain-text document and caps its size', () => {
        const result = parseWorldStateImport('A'.repeat(250000));
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('text');
        expect(result.text.length).toBe(200000);
    });

    test('accepts a recognized world-state archive', () => {
        const json = JSON.stringify({
            _meta: { type: 'world-state-archive', version: '1.0' },
            data: { text: '## Current Scene\nHello.' },
        });
        const result = parseWorldStateImport(json);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('text');
        expect(result.text).toContain('Current Scene');
    });

    test('accepts a settings archive as a separate kind', () => {
        const json = JSON.stringify({
            _meta: { type: 'world-state-tracker-settings' },
            settings: { apiUrl: 'x' },
        });
        const result = parseWorldStateImport(json);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('settings');
        expect(result.settings.apiUrl).toBe('x');
    });

    test('rejects an unrelated archive that merely has a string text', () => {
        const json = JSON.stringify({
            _meta: { type: 'character-card' },
            data: { text: 'should not be imported' },
        });
        const result = parseWorldStateImport(json);
        expect(result.ok).toBe(false);
    });

    test('rejects empty / non-string text', () => {
        expect(parseWorldStateImport(JSON.stringify({ data: { text: '   ' } })).ok).toBe(false);
        expect(parseWorldStateImport(JSON.stringify({ data: { text: 123 } })).ok).toBe(false);
    });

    test('rejects malformed JSON and empty input', () => {
        expect(parseWorldStateImport('{ not valid json').ok).toBe(false);
        expect(parseWorldStateImport('').ok).toBe(false);
        expect(parseWorldStateImport('   ').ok).toBe(false);
    });
});

// ─── INTERIORITY-06: buildUserContent caps ledger fields in every prompt path ─

describe('INTERIORITY-06: buildUserContent caps ledger fields', () => {
    test('caps oversized action/trigger/since in open intentions', () => {
        const content = buildUserContent({
            npcBlocks: [{
                name: 'Mara',
                openIntentions: [{
                    id: 'i-1',
                    action: 'x'.repeat(1000),
                    trigger: 'y'.repeat(1000),
                    since: 'z'.repeat(200),
                }],
            }],
            recentMessages: 'msg',
        });
        // The unbounded values must be capped, so they never appear in full.
        expect(content).not.toContain('x'.repeat(1000));
        expect(content).not.toContain('y'.repeat(1000));
        expect(content).not.toContain('z'.repeat(200));
        // wrapTag() emits <open_intentions>…</open_intentions> on one line, so
        // locate the line by content rather than a leading dash.
        const line = content.split('\n').find(l => l.includes('- [i-1]'));
        expect(line).toBeDefined();
        expect(line.length).toBeLessThan(1200);
    });

    test('caps oversized action/trigger/wakeHint in scheduled intentions', () => {
        const content = buildUserContent({
            npcBlocks: [{
                name: 'Mara',
                scheduledIntentions: [{
                    action: 'x'.repeat(1000),
                    trigger: 'y'.repeat(1000),
                    wakeHint: 'w'.repeat(1000),
                }],
            }],
            recentMessages: 'msg',
        });
        expect(content).not.toContain('x'.repeat(1000));
        expect(content).not.toContain('y'.repeat(1000));
        expect(content).not.toContain('w'.repeat(1000));
    });
});