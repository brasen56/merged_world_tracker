import { beforeEach, describe, expect, test } from 'vitest';
import { buildProfileEvidenceView, formatConsolidationEvidence, formatProfileEvidence,
    isPositionUnknown } from '../knowledge/growth_timeline.js';
import { growthDossierEvidence, growthDossierPromptEvidence, validateGrowthDossierProposal } from '../knowledge/growth_dossier.js';
import { growthEchoStatus } from '../knowledge/growth_lineage.js';
import { getReceiptIdentity } from '../core/message_identity.js';
import { appendRawObservations, getEvidenceFile, getEvidenceForProfile, getRawForConsolidation,
    saveEvidenceMap } from '../knowledge/evidence.js';
import { generateProfile, generatePsychoanalyzeProfile, consolidateEvidence } from '../knowledge/growth.js';
import { resetCoreStubs, setFakeChat, setFakeApi } from './stubs/core.js';
import { saveSettings } from '../knowledge/settings.js';

const observation = (n, extra = {}) => ({ id: `obs-${String(n).padStart(3, '0')}`, ts: 1000 + n,
    tsSource: 'message', verified: true, category: 'trait', claim: `behavior ${n}`, quote: `receipt ${n}`, ...extra });
const arcFile = () => ({ raw: Array.from({ length: 12 }, (_, n) => observation(n)).reverse(), consolidated: [], archivedRaw: [] });
const claimFile = () => {
    const file = arcFile();
    file.archivedRaw = file.raw.filter(o => o.ts >= 1008);
    file.raw = file.raw.filter(o => o.ts < 1008);
    file.consolidated.push({ id: 'con-1', category: 'trait', claim: 'Hand-edited blended claim',
        sources: file.archivedRaw.map(o => o.id), firstSeen: 999999, lastSeen: 999999 });
    return file;
};

beforeEach(() => resetCoreStubs());

describe('pure Growth story timeline', () => {
    test('reversed capture order, ranks instead of elapsed time, and immutability', () => {
        const file = arcFile();
        const snapshot = structuredClone(file);
        const view = buildProfileEvidenceView(file);
        expect(view.orderUnknown).toBe(false);
        expect(view.items[0]).toMatchObject({ id: 'obs-000', phase: 'early', position: 0 });
        expect(view.items.at(-1)).toMatchObject({ id: 'obs-011', phase: 'late', position: 100 });
        const hiatus = structuredClone(file);
        for (const o of hiatus.raw) if (o.ts > 1005) o.ts += 60 * 86400000;
        expect(buildProfileEvidenceView(hiatus)).toEqual(view);
        expect(file).toEqual(snapshot);
        expect(formatProfileEvidence(view)).not.toContain('1000');
    });
    test('sources changing wholly within late phase receive ordered samples and derived spans', () => {
        const file = claimFile();
        const claim = buildProfileEvidenceView(file).items.find(o => o.id === 'con-1');
        expect(claim).toMatchObject({ claim: 'Hand-edited blended claim', sourceMessages: 4,
            phase: 'late', lastPhase: 'late', spread: { early: 0, middle: 0, late: 4 },
            earliestQuote: 'receipt 8', latestQuote: 'receipt 11' });
        expect(claim.samples.map(s => s.claim)).toEqual(['behavior 8', 'behavior 9', 'behavior 10', 'behavior 11']);
    });
    test('counts messages, picks lowest id per message, and ties share one position', () => {
        const file = claimFile();
        file.archivedRaw.push(observation(20, { ts: 1008, msgKey: 'id:eight', claim: 'duplicate message' }));
        file.archivedRaw.find(o => o.ts === 1008).msgKey = 'id:eight';
        file.consolidated[0].sources.push('obs-020');
        const view = buildProfileEvidenceView(file);
        const claim = view.items.find(o => o.id === 'con-1');
        expect(claim.sourceMessages).toBe(4);
        expect(claim.samples[0].claim).toBe('behavior 8');
        file.raw.push(observation(21, { ts: 1004, msgKey: 'id:other' }));
        const tied = buildProfileEvidenceView(file).items.filter(o => ['obs-004', 'obs-021'].includes(o.id));
        expect(tied[0].position).toBe(tied[1].position);
        expect(tied[0].phase).toBe(tied[1].phase);
        expect(formatProfileEvidence(view)).toContain('display order breaks no ties');
    });
    test('distinct messages at equal times count separately, legacy ties undercount safely', () => {
        const file = claimFile();
        file.archivedRaw.push(observation(20, { ts: 1008, msgKey: 'id:other' }));
        file.consolidated[0].sources.push('obs-020');
        const claim = buildProfileEvidenceView(file).items.find(o => o.id === 'con-1');
        expect(claim.sourceMessages).toBe(5);
        expect(claim.samples[0].position).toBe(claim.samples[1].position);
        delete file.archivedRaw.at(-1).msgKey;
        expect(buildProfileEvidenceView(file).items.find(o => o.id === 'con-1').sourceMessages).toBe(4);
    });
    test.each([1, 2])('fewer than three timestamps (%s) marks order unknown', count => {
        const file = arcFile();
        file.raw.forEach((o, n) => { o.ts = 1000 + n % count; });
        const view = buildProfileEvidenceView(file);
        expect(view.orderUnknown).toBe(true);
        expect(view.items.every(o => o.position === null && o.phase === null)).toBe(true);
        expect(formatProfileEvidence(view)).toContain('order unknown');
    });
    test('fully consolidated unknown-order evidence retains neutral receipts and source claims', () => {
        const sources = [observation(0, { msgKey: 'id:a' }), observation(1, { ts: 1000, msgKey: 'id:b' })];
        const file = { raw: [], archivedRaw: sources, consolidated: [
            { id: 'con-1', category: 'trait', claim: 'A grounded pattern', sources: sources.map(o => o.id) },
        ] };
        const snapshot = structuredClone(file);
        const view = buildProfileEvidenceView(file);
        const text = formatProfileEvidence(view);
        expect(view.orderUnknown).toBe(true);
        expect(view.items[0].samples.map(s => s.claim)).toEqual(['behavior 0', 'behavior 1']);
        expect(text).toContain('Source quote: "receipt 0"');
        expect(text).toContain('Source quote: "receipt 1"');
        expect(text).not.toMatch(/Earliest|Latest|early ×|middle ×|late ×|0 source messages/);
        expect(formatProfileEvidence(buildProfileEvidenceView(file, { sampleBudget: 0 }))).toContain('Source quote: "receipt 0"');
        expect(JSON.stringify(growthDossierPromptEvidence(file))).not.toMatch(/receipt|[Qq]uote/);
        expect(file).toEqual(snapshot);
    });
    test('individually position-unknown verified sources retain receipts without affecting chronology', () => {
        const file = arcFile();
        file.archivedRaw = [observation(20, { ts: 0, msgKey: 'id:unknown' }),
            observation(21, { tsSource: 'capture', msgKey: 'id:capture' }),
            observation(22, { verified: false, quote: 'UNVERIFIED' })];
        file.consolidated = [{ id: 'con-1', category: 'trait', claim: 'Undated support',
            sources: file.archivedRaw.map(o => o.id) }];
        const view = buildProfileEvidenceView(file);
        expect(view.orderUnknown).toBe(false);
        expect(view.items.find(o => o.id === 'con-1')).toMatchObject({ position: null, sourceMessages: 0 });
        const text = formatProfileEvidence(view);
        expect(text).toContain('Source quote: "receipt 20"');
        expect(text).toContain('Source quote: "receipt 21"');
        expect(text).not.toMatch(/UNVERIFIED|Earliest|Latest|early ×/);
    });
    test('equal-position consolidated receipts use neutral labels, not chronological endpoints', () => {
        const file = arcFile();
        file.archivedRaw = [observation(20, { ts: 1000, msgKey: 'id:a', msgIdx: 9 }),
            observation(21, { ts: 1000, msgKey: 'id:b', msgIdx: 1 })];
        file.consolidated = [{ id: 'con-1', category: 'trait', claim: 'Simultaneous support', sources: ['obs-020', 'obs-021'] }];
        const view = buildProfileEvidenceView(file);
        expect(view.orderUnknown).toBe(false);
        const text = formatProfileEvidence(view);
        expect(text).toContain('Source quote: "receipt 20"');
        expect(text).toContain('Source quote: "receipt 21"');
        expect(text).not.toMatch(/Earliest|Latest/);
    });
    test('undated receipts accompany dated endpoints without inflating support or leaking dossier quotes', () => {
        const file = claimFile();
        file.archivedRaw.push(observation(20, { ts: 0, msgKey: 'id:undated' }));
        file.consolidated[0].sources.push('obs-020');
        const view = buildProfileEvidenceView(file);
        const claim = view.items.find(o => o.id === 'con-1');
        expect(claim).toMatchObject({ sourceMessages: 4, earliestQuote: 'receipt 8', latestQuote: 'receipt 11',
            spread: { early: 0, middle: 0, late: 4 }, sourceQuotes: ['receipt 20'] });
        expect(claim.samples.at(-1)).toEqual({ claim: 'behavior 20', position: null, phase: null });
        const text = formatProfileEvidence(view);
        // One line for span and support; a claim inside one phase sends only its latest receipt.
        expect(text).toContain('Seen: late 72.7 → late 100 · 4 source messages: early ×0, middle ×0, late ×4');
        expect(text).toContain('   Latest: "receipt 11"');
        expect(text).not.toContain('Earliest');
        expect(text).toContain('Source quote: "receipt 20"');
        expect(JSON.stringify(growthDossierPromptEvidence(file))).not.toMatch(/receipt|[Qq]uote/);
        const budgeted = buildProfileEvidenceView(file, { sampleBudget: 0 });
        expect(budgeted.items.find(o => o.id === 'con-1')).toMatchObject({ samples: [], omittedMessages: 4, omittedUndated: 1 });
        expect(formatProfileEvidence(budgeted)).toContain('Source quote: "receipt 20"');
        expect(formatProfileEvidence(budgeted)).toContain('… 5 source messages omitted …');
    });
    test('undated sources never take the latest dated sample slots', () => {
        const file = arcFile();
        const dated = Array.from({ length: 10 }, (_, n) => observation(30 + n, { ts: 1000 + n,
            claim: n < 7 ? `waits for permission ${n}` : `takes initiative ${n}` }));
        const undated = [20, 21, 22].map(n => observation(n, { ts: 0, msgKey: `id:u${n}`, claim: `restored scene ${n}` }));
        file.archivedRaw = [...dated, ...undated];
        file.consolidated = [{ id: 'con-1', category: 'trait', claim: 'Defers, then acts', sources: file.archivedRaw.map(o => o.id) }];
        const claim = buildProfileEvidenceView(file).items.find(o => o.id === 'con-1');
        expect(claim.samples.map(s => s.claim)).toEqual(['waits for permission 0', 'waits for permission 1',
            'takes initiative 8', 'takes initiative 9', 'restored scene 20', 'restored scene 21']);
        expect(claim).toMatchObject({ omittedMessages: 6, omittedUndated: 1 });
        const text = formatProfileEvidence(buildProfileEvidenceView(file));
        expect(text.indexOf('… 6 more …')).toBeGreaterThan(text.indexOf('waits for permission 1'));
        expect(text.indexOf('… 6 more …')).toBeLessThan(text.indexOf('takes initiative 8'));
        expect(text.indexOf('takes initiative 9')).toBeLessThan(text.indexOf('order unknown restored scene 20'));
        expect(text).toContain('… 1 more with unknown order …');
        file.archivedRaw.push(observation(23, { ts: 0, msgKey: 'id:u23' }));
        file.consolidated[0].sources.push('obs-023');
        const capped = buildProfileEvidenceView(file).items.find(o => o.id === 'con-1');
        expect(capped.samples.filter(s => s.position == null)).toHaveLength(2);
        expect(capped).toMatchObject({ omittedMessages: 6, omittedUndated: 2 });
    });
    test('tied endpoint quotes are explicitly representative of their positions', () => {
        const file = arcFile();
        file.archivedRaw = [observation(20, { ts: 1000, msgKey: 'id:a' }), observation(21, { ts: 1000, msgKey: 'id:b' }),
            observation(22, { ts: 1011, msgKey: 'id:c' }), observation(23, { ts: 1011, msgKey: 'id:d' })];
        file.consolidated = [{ id: 'con-1', category: 'trait', claim: 'Changes across the story',
            sources: file.archivedRaw.map(o => o.id) }];
        const text = formatProfileEvidence(buildProfileEvidenceView(file));
        expect(text).toContain('Earliest position (representative quote): "receipt 20"');
        expect(text).toContain('Latest position (representative quote): "receipt 23"');
        expect(text).not.toMatch(/Earliest:|Latest:/);
    });
    test('a single source message reads as singular', () => {
        const file = arcFile();
        file.archivedRaw = [observation(20, { ts: 1004 })];
        file.consolidated = [{ id: 'con-1', category: 'trait', claim: 'One moment', sources: ['obs-020'] }];
        expect(formatProfileEvidence(buildProfileEvidenceView(file))).toContain('· 1 source message: early ×0, middle ×1, late ×0');
    });
    test('dominant timestamp threshold is strictly over one quarter', () => {
        const file = arcFile();
        file.raw.slice(0, 3).forEach(o => { o.ts = 1000; });
        expect(buildProfileEvidenceView(file).orderUnknown).toBe(true);
        file.raw[2].ts = 2000;
        expect(buildProfileEvidenceView(file).orderUnknown).toBe(false);
    });
    test.each([
        [{ ts: 100, capturedAt: 100 }, true], [{ ts: 100, capturedAt: 149 }, true],
        [{ ts: 100, capturedAt: 150 }, false], [{ ts: 100, capturedAt: 99 }, false],
        [{ ts: 100, capturedAt: Infinity }, false], [{ ts: Infinity }, true], [{ ts: NaN }, true],
        [{ ts: 0, tsSource: 'message' }, true], [{ ts: 100, verified: false, tsSource: 'message' }, true],
        [{ ts: 100, capturedAt: 100, tsSource: 'message' }, false],
        [{ ts: 100, capturedAt: 1000, tsSource: 'capture' }, true],
        [{ ts: 100, capturedAt: 1000, tsSource: 'cited' }, true],
        [{ ts: 100, capturedAt: 1000, tsSource: 'cited', verified: true }, true],
    ])('fallback/provenance %j -> unknown %s', (o, unknown) => expect(isPositionUnknown(o)).toBe(unknown));
    test('unknown sources never affect spans/support and deleted-claim archive never returns', () => {
        const file = claimFile();
        file.archivedRaw.push(observation(99, { claim: 'DELETED SECRET' }));
        file.archivedRaw.find(o => o.ts === 1011).verified = false;
        const view = buildProfileEvidenceView(file);
        const claim = view.items.find(o => o.id === 'con-1');
        expect(claim.sourceMessages).toBe(3);
        expect(claim.latestQuote).toBe('receipt 10');
        expect(JSON.stringify(view)).not.toContain('DELETED SECRET');
        file.raw.push(file.archivedRaw[0]); // Expand duplicate must not change the domain.
        expect(buildProfileEvidenceView(file).items.find(o => o.id === 'con-1').position).toBe(claim.position);
    });
    test('k = 2 cap; late-reaching claims first, then span; one pass that skips what no longer fits', () => {
        const file = arcFile();
        file.archivedRaw = file.raw;
        file.raw = [];
        const ids = keep => file.archivedRaw.filter(o => keep(o.ts)).map(o => o.id);
        file.consolidated = [
            { id: 'con-a', claim: 'widest, ends before late', sources: ids(ts => ts <= 1007) }, // 8 messages, early 0 → middle 63.6
            { id: 'con-b', claim: 'narrow, late only', sources: ids(ts => ts >= 1009) }, // 3 messages, late 81.8 → late 100
            { id: 'con-c', claim: 'whole story', sources: ids(ts => [1000, 1004, 1008, 1011].includes(ts)) }, // 4 messages, early 0 → late 100
        ];
        const claim = (view, id) => view.items.find(o => o.id === id);
        const cost = o => JSON.stringify({ samples: o.samples, omittedMessages: o.omittedMessages,
            omittedUndated: o.omittedUndated }).length;
        const full = buildProfileEvidenceView(file, { sampleBudget: Infinity });
        expect(claim(full, 'con-a')).toMatchObject({ omittedMessages: 4 });
        expect(claim(full, 'con-a').samples.map(s => s.claim)).toEqual(['behavior 0', 'behavior 1', 'behavior 6', 'behavior 7']);
        expect(claim(full, 'con-b').samples).toHaveLength(3);
        expect(claim(full, 'con-c').samples).toHaveLength(4);
        // Reaching late outranks span: the narrow late-only claim beats the widest one that ended earlier.
        const lateFirst = buildProfileEvidenceView(file, { sampleBudget: cost(claim(full, 'con-c')) + cost(claim(full, 'con-b')) });
        expect(claim(lateFirst, 'con-c').samples).toHaveLength(4);
        expect(claim(lateFirst, 'con-b').samples).toHaveLength(3);
        expect(claim(lateFirst, 'con-a')).toMatchObject({ samples: [], omittedMessages: 8 });
        // One pass: a claim that no longer fits gets nothing, and a cheaper one after it still may.
        expect(cost(claim(full, 'con-c'))).toBeGreaterThan(cost(claim(full, 'con-b')));
        const skip = buildProfileEvidenceView(file, { sampleBudget: cost(claim(full, 'con-b')) });
        expect(claim(skip, 'con-c')).toMatchObject({ samples: [], omittedMessages: 4 });
        expect(claim(skip, 'con-b').samples).toHaveLength(3);
        expect(buildProfileEvidenceView(file, { sampleBudget: cost(claim(full, 'con-b')) })).toEqual(skip);
        // Exhausted budget: spans and the cross-phase receipts survive.
        const empty = buildProfileEvidenceView(file, { sampleBudget: 0 });
        expect(empty.items.every(o => o.samples.length === 0)).toBe(true);
        expect(formatProfileEvidence(empty)).toContain('Earliest: "receipt 0"  Latest: "receipt 11"');
        expect(formatProfileEvidence(empty)).toContain('… 8 source messages omitted …');
    });
    test('default budget is a share of the evidence text without samples, never below the floor', () => {
        const file = claimFile();
        const unsampled = view => formatProfileEvidence({ ...view, items: view.items.map(o => ({ ...o,
            samples: [], omittedMessages: 0, omittedUndated: 0 })) }).length;
        const base = unsampled(buildProfileEvidenceView(file));
        expect(buildProfileEvidenceView(file).sampleBudget).toBe(8000); // a small store sits on the floor
        expect(buildProfileEvidenceView(file, { sampleBudgetFloor: 0 }).sampleBudget).toBe(Math.floor(0.25 * base));
        expect(buildProfileEvidenceView(file, { sampleBudgetFloor: 0, sampleBudgetShare: 1 }).sampleBudget).toBe(base);
        expect(buildProfileEvidenceView(file, { sampleBudget: 123 }).sampleBudget).toBe(123); // explicit override
        // Larger evidence text, larger budget: growth stays proportional to the store.
        const bigger = claimFile();
        bigger.raw.push(...Array.from({ length: 40 }, (_, n) => observation(200 + n, { ts: 2000 + n })));
        expect(buildProfileEvidenceView(bigger, { sampleBudgetFloor: 0 }).sampleBudget)
            .toBeGreaterThan(buildProfileEvidenceView(file, { sampleBudgetFloor: 0 }).sampleBudget);
    });
    test('positions are rounded once, so the shown number and its phase label agree', () => {
        // 54 timestamps: rank 18 is 33.96…, shown as 34 — which must read "middle", not "early".
        const file = { raw: Array.from({ length: 54 }, (_, n) => observation(n)), consolidated: [], archivedRaw: [] };
        const view = buildProfileEvidenceView(file);
        expect(view.items.find(o => o.id === 'obs-018')).toMatchObject({ position: 34, phase: 'middle' });
        expect(view.items.every(o => o.position === Math.round(o.position * 10) / 10)).toBe(true);
        expect(formatProfileEvidence(view)).toContain('Seen: middle 34\n');
    });
    test('dossier split keeps validator/echo times but model samples have no ids/quotes/receipts', () => {
        const file = claimFile();
        const model = growthDossierPromptEvidence(file);
        const internal = growthDossierEvidence(file);
        expect(internal.find(o => o.id === 'con-1').firstSeen).toBe(999999);
        const claim = model.find(o => o.id === 'con-1');
        expect(claim.samples).toHaveLength(4);
        for (const sample of claim.samples) expect(Object.keys(sample).sort()).toEqual(['claim', 'phase', 'position']);
        // Keys that restate another (or qualify quotes that never travel) stay out of the draft input.
        for (const item of model) {
            for (const key of ['orderUnknown', 'earliestTied', 'latestTied']) expect(item).not.toHaveProperty(key);
        }
        expect(model.find(o => o.id === 'obs-000')).not.toHaveProperty('samples');
        expect(claim).not.toHaveProperty('omittedMessages');
        for (const forbidden of ['receipt', 'firstSeen', 'lastSeen', '"ts"', '"sources"', 'quote']) {
            expect(JSON.stringify(model)).not.toContain(forbidden);
        }
        const current = { personality: 'Waits.', voice: '' };
        const change = { field: 'personality', before: 'Waits.', after: 'Acts.', action: 'edit', evidenceIds: ['con-1'] };
        expect(validateGrowthDossierProposal({ personality: 'Acts.', voice: '', changes: [change] }, { current, evidence: internal }).ok).toBe(true);
        const keep = { ...change, action: 'keep', before: 'Acts.' };
        const lineage = [{ field: 'personality', after: 'Acts.', firstApprovedAt: 500 }];
        expect(growthEchoStatus(keep, internal, lineage)).toBe('possible echo — all dated support was written after first approval');
        expect(growthEchoStatus(keep, internal, lineage)).toEqual(growthEchoStatus(keep, growthDossierEvidence(file), lineage));
    });
    test('read-only identity never modifies restored originals', () => {
        const originals = [{ mes: 'old', extra: {} }, { id: 'host' }, { extra: { mesid: 'host2' } }, { extra: { mwt_uuid: 'existing' } }];
        const snapshot = JSON.stringify(originals);
        expect(originals.map(getReceiptIdentity)).toEqual([null, 'id:host', 'mesid:host2', 'uuid:existing']);
        expect(JSON.stringify(originals)).toBe(snapshot);
    });
});

describe('Growth prompt integration and unchanged UI read path', () => {
    beforeEach(() => {
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        Object.assign(getEvidenceFile('Mara'), arcFile());
        saveEvidenceMap();
    });
    test('Generate and Psychoanalyze share chronology without changing UI output/counts', async () => {
        const evidence = getEvidenceForProfile('Mara');
        const snapshot = structuredClone(evidence);
        const requests = [];
        setFakeApi(request => { requests.push(request); return 'Profile prose.'; });
        await generateProfile('Mara', evidence, '');
        await generatePsychoanalyzeProfile('Mara', evidence, 'Historical baseline.');
        for (const request of requests) {
            expect(request.userContent.indexOf('behavior 0')).toBeLessThan(request.userContent.indexOf('behavior 11'));
            expect(request.userContent).toContain('early 0');
            expect(request.userContent).toContain('late 100');
            expect(request.userContent).not.toContain('(msg');
        }
        expect(getEvidenceForProfile('Mara')).toEqual(snapshot);
        expect(evidence).toHaveLength(12);
        expect(evidence[0].claim).toBe('behavior 11');
    });
    test('consolidation display reorders but numeric IDs still resolve against the original snapshot', async () => {
        const raw = getRawForConsolidation('Mara');
        const expected = formatConsolidationEvidence(getEvidenceFile('Mara'), raw);
        setFakeApi(request => {
            expect(request.userContent).toContain(expected);
            expect(expected.indexOf('[12]')).toBeLessThan(expected.indexOf('[1]'));
            return JSON.stringify({ consolidated: [{ claim: 'Acts.', sources: [12, 1] }] });
        });
        const result = await consolidateEvidence('Mara');
        expect(result.sourceIds).toEqual(raw.map(o => o.id));
        expect(result.sourceIds[11]).toBe('obs-000');
    });
    test('capture provenance and identity survive evidence save with no message writes', () => {
        const chat = [{ id: 'host-id', send_date: 1000, mes: 'hello', extra: {} }];
        const snapshot = JSON.stringify(chat);
        setFakeChat(chat);
        appendRawObservations('New', [{ claim: 'acts', quote: 'hello', msgIdx: 0, verified: true },
            { claim: 'restored', quote: 'old', ts: 900, msgIdx: null, msgKey: 'id:original', verified: true },
            { claim: 'fallback', quote: 'missing', msgIdx: null, verified: false },
            { claim: 'paraphrased', quote: 'not said', msgIdx: 0, verified: false }]);
        expect(saveEvidenceMap().ok).toBe(true);
        expect(getEvidenceFile('New').raw).toEqual(expect.arrayContaining([
            expect.objectContaining({ tsSource: 'message', msgKey: 'id:host-id' }),
            expect.objectContaining({ tsSource: 'message', msgKey: 'id:original' }),
            expect.objectContaining({ tsSource: 'capture', msgKey: null }),
            // The cited message's date is kept for traceability, but it neither orders nor supports.
            expect.objectContaining({ claim: 'paraphrased', ts: 1000000, tsSource: 'cited', msgKey: null }),
        ]));
        expect(isPositionUnknown(getEvidenceFile('New').raw.find(o => o.claim === 'paraphrased'))).toBe(true);
        expect(JSON.stringify(chat)).toBe(snapshot);
    });
});