import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeApi } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getEvidenceFile, saveEvidenceMap } from '../knowledge/evidence.js';
import { getRegistryEntry, setGrowthDossierSettings } from '../knowledge/registry.js';
import { buildUpdatedDossierContent } from '../knowledge/lorebook.js';
import { validateFieldValue, validateScanRecord } from '../knowledge/field_contract.js';
import { GROWTH_DOSSIER_CEILINGS } from '../knowledge/growth_dossier_state.js';
import { bumpEpoch } from '../core/scope.js';
import { pauseStore, _resetPausedStores, _setScopeKeyResolver } from '../core/schema_status.js';
import { draftGrowthDossier, extractGrowthDossierLines, growthDossierEvidence, growthDossierPromptEvidence,
    parseGrowthDossierProposal, splitGrowthSentences, validateGrowthDossierProposal } from '../knowledge/growth_dossier.js';
import { appendGrowthApprovalToBook, mergeGrowthHistoryIdentities } from '../knowledge/growth_history.js';

const current = { personality: 'Keeps promises. Trusts slowly.', voice: 'Speaks plainly.' };
const evidence = [{ id: 'obs-1', claim: 'Owns mistakes', ts: 100 }];
const change = (field, before, after = before, action = 'keep', evidenceIds = []) => ({ field, before, after, action, evidenceIds });
function proposal() {
    return { ...current, changes: [change('personality', 'Keeps promises.'),
        change('personality', 'Trusts slowly.'), change('voice', current.voice)] };
}
const validate = (p, options = {}) => validateGrowthDossierProposal(p, { current, evidence, ...options });

describe('strict Growth proposal contract', () => {
    test.each(['{"personality":', '{"x":1,}', 'prefix {"x":1}', '{"x":1} suffix', '[]', 'null', '{"x":1}\n{"y":2}'])('rejects malformed/truncated/wrapped output %s', text => {
        expect(parseGrowthDossierProposal(text).ok).toBe(false);
    });
    test('accepts complete JSON and exactly one whole fence', () => {
        const p = proposal();
        expect(parseGrowthDossierProposal(JSON.stringify(p)).proposal).toEqual(p);
        expect(parseGrowthDossierProposal('```json\n' + JSON.stringify(p) + '\n```').proposal).toEqual(p);
    });
    test('shared sentence grammar and extraction preserve clauses', () => {
        expect(splitGrowthSentences('Waits; watches. Then acts! A fragment')).toEqual(['Waits; watches.', 'Then acts!', 'A fragment']);
        expect(extractGrowthDossierLines('Personality: Keeps promises.\nVoice: Plain.\nRole: captain')).toEqual({ personality: 'Keeps promises.', voice: 'Plain.' });
    });
    test.each(['personality', 'voice'])('%s ceiling is inclusive, target is advisory, scan cap unchanged', field => {
        const ceiling = GROWTH_DOSSIER_CEILINGS[field];
        const value = 'x'.repeat(ceiling - 1) + '.';
        const p = proposal();
        p[field] = value;
        p.changes = p.changes.filter(c => c.field !== field);
        for (const before of splitGrowthSentences(current[field])) p.changes.push({ ...change(field, before, '', 'remove', ['obs-1']), reason: 'evidence' });
        p.changes.push(change(field, '', value, 'add', ['obs-1']));
        expect(validate(p).ok).toBe(true);
        expect(validate(p).warnings).toContainEqual(expect.objectContaining({ field, code: 'over-target' }));
        expect(validate(p, { limits: { personality: 1500, voice: 1000 } }).warnings).toEqual([]);
        expect(validate({ ...p, [field]: value + 'x' }).ok).toBe(false);
        expect(validateFieldValue(field, value).ok).toBe(false);
        expect(validateScanRecord({ fields: { [field]: value } }).data.fields[field]).toBeNull();
        const dossier = 'Personality: old\nVoice: old\nRole: captain';
        expect(buildUpdatedDossierContent(dossier, { [field]: value })).not.toContain(value);
        expect(buildUpdatedDossierContent(dossier, { [field]: value }, undefined, { ceilings: GROWTH_DOSSIER_CEILINGS })).toContain(value);
    });
    test('target equality is not a warning, exceeding by one is', () => {
        const limits = { personality: current.personality.length, voice: current.voice.length };
        expect(validate(proposal(), { limits }).warnings.some(w => w.code === 'over-target')).toBe(false);
        limits.voice--;
        expect(validate(proposal(), { limits }).warnings).toContainEqual(expect.objectContaining({ field: 'voice', code: 'over-target' }));
    });
    test.each(['bad\nline', 'Personality: nested', {}, null, 1])('rejects invalid field %j whole', value => {
        expect(validate({ ...proposal(), personality: value }).ok).toBe(false);
    });
    test('downgrades non-verbatim keeps to evidence-backed edits', () => {
        const p = proposal();
        p.personality = 'Owns mistakes. Trusts slowly.';
        p.changes[0].after = 'Owns mistakes.';
        expect(validate(p).ok).toBe(false);
        p.changes[0].evidenceIds = ['obs-1'];
        expect(validate(p).proposal.changes[0].action).toBe('edit');
    });
    test('missing ids warn, but edits/removals require at least one live id', () => {
        const p = proposal();
        p.changes[0].evidenceIds = ['deleted'];
        expect(validate(p).warnings).toContainEqual(expect.objectContaining({ code: 'unresolvable-evidence' }));
        p.changes[0].action = 'edit';
        expect(validate(p).ok).toBe(false);
        p.changes[0].evidenceIds.push('obs-1');
        expect(validate(p).ok).toBe(true);
        p.personality = 'Trusts slowly.';
        Object.assign(p.changes[0], { action: 'remove', after: '', reason: 'evidence', evidenceIds: ['deleted'] });
        expect(validate(p).ok).toBe(false);
        p.changes[0].evidenceIds.push('obs-1');
        expect(validate(p).ok).toBe(true);
    });
    test('length removals require actual overflow including the joining space', () => {
        const p = proposal();
        p.personality = 'Trusts slowly.';
        Object.assign(p.changes[0], { action: 'remove', after: '', reason: 'length' });
        const limits = { personality: current.personality.length, voice: 350 };
        expect(validate(p, { limits }).ok).toBe(false);
        limits.personality--;
        expect(validate(p, { limits }).ok).toBe(true);
    });
    test.each(['personality', 'voice'])('%s cannot be cleared through the validator-to-merger path', field => {
        const p = proposal();
        p[field] = '';
        p.changes = p.changes.filter(c => c.field !== field);
        for (const before of splitGrowthSentences(current[field])) {
            p.changes.push({ ...change(field, before, '', 'remove', ['obs-1']), reason: 'evidence' });
        }
        const result = validate(p);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain(`${field}: clearing an existing line is not supported`);
        expect(result.proposal).toBeUndefined();

        const dossier = `Personality: ${current.personality}\nVoice: ${current.voice}\nRole: captain`;
        // A rejected draft supplies no fields to apply; ordinary empty/null updates stay no-ops too.
        expect(buildUpdatedDossierContent(dossier, result.proposal, [], { ceilings: GROWTH_DOSSIER_CEILINGS })).toBe(dossier);
        expect(buildUpdatedDossierContent(dossier, { [field]: '' })).toBe(dossier);
        expect(buildUpdatedDossierContent(dossier, { [field]: null })).toBe(dossier);

        const baseline = { ...current, [field]: '' };
        const unchanged = validate({ ...baseline, changes: proposal().changes.filter(c => c.field !== field) }, { current: baseline });
        expect(unchanged.ok).toBe(true);
        const blankDossier = `Personality: ${baseline.personality}\nVoice: ${baseline.voice}\nRole: captain`;
        expect(buildUpdatedDossierContent(blankDossier, unchanged.proposal, [], { ceilings: GROWTH_DOSSIER_CEILINGS })).toBe(blankDossier);
    });
    test.each(['personality', 'voice'])('%s output items must match final sentence boundaries', field => {
        const baseline = { ...current, [field]: 'Patient' };
        const p = { ...baseline, [field]: 'Patient Speaks plainly.', changes: [
            ...proposal().changes.filter(c => c.field !== field),
            change(field, 'Patient'), change(field, '', 'Speaks plainly.', 'add', ['obs-1']),
        ] };
        const result = validate(p, { current: baseline });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('every proposed sentence in order');

        // Punctuating the fragment is a real edit, requiring evidence, not a keep plus an add.
        p[field] = 'Patient. Speaks plainly.';
        Object.assign(p.changes.at(-2), { action: 'edit', after: 'Patient.', evidenceIds: ['obs-1'] });
        expect(validate(p, { current: baseline }).ok).toBe(true);
        expect(validate({ ...baseline, changes: [
            ...proposal().changes.filter(c => c.field !== field), change(field, 'Patient'),
        ] }, { current: baseline }).ok).toBe(true);
    });
    test.each(['omit-source', 'omit-output', 'duplicate', 'unknown-field', 'extra-field', 'invent-source', 'multi-sentence', 'reason'])('rejects incomplete/invalid accounting: %s', mode => {
        const p = proposal();
        if (mode === 'omit-source') p.changes.shift();
        if (mode === 'omit-output') p.personality += ' Extra.';
        if (mode === 'duplicate') p.changes.push({ ...p.changes[0] });
        if (mode === 'unknown-field') p.changes[0].field = 'role';
        if (mode === 'extra-field') p.role = 'admiral';
        if (mode === 'invent-source') p.changes[0].before = 'Never existed.';
        if (mode === 'multi-sentence') p.changes[0].after = 'One. Two.';
        if (mode === 'reason') p.changes[0].reason = 'length';
        expect(validate(p).ok).toBe(false);
    });
    test('original and hand-edited keeps get deterministic no-evidence labels and no links', () => {
        const p = proposal();
        p.changes[0].evidenceIds = ['obs-1'];
        expect(validate(p).proposal.changes.every(c => c.sourceLabel === 'from the original line, no evidence' && !c.evidenceIds.length)).toBe(true);
        const result = validate(p, { approved: { personality: 'Keeps promises.', voice: current.voice } });
        expect(result.proposal.changes[0].sourceLabel).toBeUndefined();
        expect(result.proposal.changes[1].sourceLabel).toBe('hand edit, no evidence');
    });
    test.each(['INTJ', 'ENFP-T', 'Enneagram', 'Type 7', 'a 3', 'a 3 with a 4 wing', '3w4', '4 wing', 'wing 5', 'DISC', 'Big Five',
        'personality type', 'analytical type', 'choleric temperament', 'sanguine type', 'four temperaments', 'temperament type', 'character archetype',
    ])('warns for typology %s without blocking baseline keep', term => {
        const text = `An ${term}.`;
        const p = { personality: text, voice: '', changes: [change('personality', text)] };
        const result = validate(p, { current: { personality: text, voice: '' } });
        expect(result.ok).toBe(true);
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'typology' }));
    });
    test.each([
        'Keeps to the east wing of the manor.', 'Took the new recruit under her wing.', 'Has an even temperament until cornered.',
        'Rated a 9 at the archery trials.', 'Throws a disc for the dog.', 'Grows melancholic at dusk.', 'Plays the type of fool who listens.',
    ])('ordinary prose raises no typology warning: %s', text => {
        const p = { personality: text, voice: '', changes: [change('personality', text)] };
        expect(validate(p, { current: { personality: text, voice: '' } }).warnings).toEqual([]);
    });
    test.each(['Says “hello”.', 'Says "hello".', 'Answers ‘aye’ to everything.', "Answers 'aye' to everything.", 'Calls it «duty».'])('quote warnings are advisory: %s', voice => {
        const p = proposal();
        p.voice = voice;
        Object.assign(p.changes[2], { action: 'edit', after: p.voice, evidenceIds: ['obs-1'] });
        expect(validate(p).ok).toBe(true);
        expect(validate(p).warnings).toContainEqual(expect.objectContaining({ code: 'quotes' }));
    });
    test.each(['Doesn’t trust the crew’s officers.', "Doesn't trust the crew's officers.", 'Laughs at her friends’ jokes.', "Laughs at her friends' jokes."])('apostrophes are not quotes: %s', voice => {
        const p = proposal();
        p.voice = voice;
        Object.assign(p.changes[2], { action: 'edit', after: p.voice, evidenceIds: ['obs-1'] });
        expect(validate(p).warnings).toEqual([]);
    });
    test('internal evidence projection retains echo times; model projection excludes times and receipts', () => {
        expect(growthDossierEvidence({ raw: [{ ...evidence[0], category: 'values', quote: 'SECRET', canon: true }],
            consolidated: [{ id: 'con-1', claim: 'calm', firstSeen: 50, quote: 'SECRET', sources: ['obs-1'] }],
            archivedRaw: [{ id: 'old', quote: 'SECRET' }] })).toEqual([
            { id: 'con-1', category: undefined, claim: 'calm', firstSeen: 50, tier: 'consolidated', canon: false },
            { ...evidence[0], category: 'values', tier: 'raw', canon: true },
        ]);
        const model = growthDossierPromptEvidence({ raw: [{ ...evidence[0], category: 'values', quote: 'SECRET', canon: true }] });
        // A null position is the only unknown-order marker the model needs (the prompt says so).
        expect(model).toEqual([{ id: 'obs-1', claim: 'Owns mistakes', category: 'values', canon: true,
            tier: 'raw', position: null, phase: null }]);
        expect(JSON.stringify(model)).not.toContain('SECRET');
    });
});

describe('headless drafting service', () => {
    let requests;
    let books;
    let save;
    const BOOK = 'Knowledge Tracker';
    const content = `[Dossier] Mara | Human | captain\nPersonality: ${current.personality}\nVoice: ${current.voice}\nRole: captain\nCanon Lock: born at sea`;
    beforeEach(() => {
        resetCoreStubs();
        _resetPausedStores();
        _setScopeKeyResolver(() => 'growth-test');
        _clearCacheForTests();
        saveSettings({ scope: 'global', apiUrl: 'https://example.test', modelName: 'test-model', dossierMode: true });
        _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, profileUid: 8, type: 'major', entityId: 'ent-mara', growthDossier: { enabled: true } } } });
        books = new Map([[BOOK, { entries: { 7: { uid: 7, comment: 'Mara', key: ['Mara'], content } } }]]);
        save = vi.fn();
        state.wiScript = { async loadWorldInfo(name) { return structuredClone(books.get(name) || { entries: { 8: { content: 'A generated profile.' } } }); }, saveWorldInfo: save };
        installCleanupFetch(state.wiScript);
        requests = [];
        setFakeApi(request => { requests.push(request); return JSON.stringify(proposal()); });
    });
    afterEach(() => { _clearCacheForTests(); _resetPausedStores(); _setScopeKeyResolver(null); state.wiScript = null; vi.unstubAllGlobals(); });
    test.each([true, false, undefined])('calls only when switch explicitly on (%s)', async enabled => {
        _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, profileUid: 8, entityId: 'ent-mara', growthDossier: enabled === undefined ? {} : { enabled } } } });
        if (enabled) expect((await draftGrowthDossier('Mara')).ok).toBe(true);
        else await expect(draftGrowthDossier('Mara')).rejects.toThrow('Turn Use Growth');
        expect(requests).toHaveLength(enabled ? 1 : 0);
        expect(save).not.toHaveBeenCalled();
    });
    test('requires profile before any API call', async () => {
        await expect(draftGrowthDossier('Mara', { profile: '' })).rejects.toThrow('Generate a Growth profile');
        expect(requests).toHaveLength(0);
    });
    test('one request, quote-free evidence and limits, no persistent writes', async () => {
        const file = getEvidenceFile('Mara');
        file.raw.push({ ...evidence[0], category: 'values', quote: 'SECRET RECEIPT', canon: true });
        file.consolidated.push({ id: 'con-1', category: 'traits', claim: 'Patient', firstSeen: 50 });
        saveEvidenceMap();
        setGrowthDossierSettings('Mara', { limits: { personality: 1400, voice: 800 } });
        const before = structuredClone(books);
        const result = await draftGrowthDossier('Mara', { profile: 'Fresh unsaved profile.' });
        expect(result.ok).toBe(true);
        expect(requests).toHaveLength(1);
        const input = JSON.parse(requests[0].userContent);
        expect(input.profile).toBe('Fresh unsaved profile.');
        expect(input.limits).toEqual({ personality: 1400, voice: 800 });
        expect(input.canonLock).toBe('born at sea');
        expect(input.evidence.every(o => o.position === null && o.phase === null && !('orderUnknown' in o))).toBe(true);
        expect(input.evidence.every(o => !('firstSeen' in o) && !('ts' in o))).toBe(true);
        expect(growthDossierEvidence(getEvidenceFile('Mara'))[0].firstSeen).toBe(50);
        expect(requests[0].userContent).not.toContain('SECRET RECEIPT');
        expect(books).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });
    test.each(['parse', 'validation', 'api'])('failure %s leaves book unchanged and does not retry parsing', async mode => {
        const before = structuredClone(books);
        let calls = 0;
        setFakeApi(() => { calls++; if (mode === 'api') throw new Error('offline'); return mode === 'parse' ? '{"personality":' : '{}'; });
        await expect(draftGrowthDossier('Mara')).rejects.toThrow();
        expect(calls).toBe(1);
        expect(books).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });
    test('switch disabled during request discards response', async () => {
        setFakeApi(() => { setGrowthDossierSettings('Mara', { enabled: false }); return JSON.stringify(proposal()); });
        await expect(draftGrowthDossier('Mara')).rejects.toThrow('Turn Use Growth');
        expect(save).not.toHaveBeenCalled();
    });
    test('paused Knowledge refuses before spending', async () => {
        pauseStore('knowledgeStore', { reason: 'unsafe schema' });
        await expect(draftGrowthDossier('Mara')).rejects.toThrow('paused');
        expect(requests).toHaveLength(0);
    });
    test('chat switch during model call discards response', async () => {
        setFakeApi(() => { bumpEpoch(); return JSON.stringify(proposal()); });
        await expect(draftGrowthDossier('Mara')).rejects.toThrow('scope or NPC changed');
        expect(save).not.toHaveBeenCalled();
    });
    test.each(['uid', 'entityId'])('in-place %s mutation during model call discards response', async field => {
        const info = getRegistryEntry('Mara').info;
        const before = structuredClone(books);
        setFakeApi(async () => {
            await Promise.resolve();
            info[field] = field === 'uid' ? 99 : 'ent-other';
            return JSON.stringify(proposal());
        });
        await expect(draftGrowthDossier('Mara')).rejects.toThrow('scope or NPC changed');
        expect(getRegistryEntry('Mara').info).toBe(info);
        expect(books).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });
    test('latest approval is read for hand-edit labels, never sent to the model', async () => {
        books.get(BOOK).entries[9] = { comment: '[MWT:growth-history]', content: JSON.stringify({ version: 1,
            records: { 'ent-mara': [{ acceptedAt: 1000, changes: [],
                approved: { personality: 'Keeps promises.', voice: current.voice }, privateHistory: 'HISTORY SECRET' }] } }) };
        const result = await draftGrowthDossier('Mara');
        expect(result.proposal.changes[0].sourceLabel).toBeUndefined();
        expect(result.proposal.changes[1].sourceLabel).toBe('hand edit, no evidence');
        expect(requests[0].userContent).not.toContain('HISTORY SECRET');
    });
    test('draft after identity fold uses retained approval for labels and echo rather than newer absorbed audit', async () => {
        const wi = books.get(BOOK);
        appendGrowthApprovalToBook(wi, 'ent-mara', { approved: current, current, changes: proposal().changes, acceptedAt: 1000 });
        const other = { personality: 'Acts impulsively.', voice: 'Shouts orders.' };
        appendGrowthApprovalToBook(wi, 'ent-other', { approved: other, current: other, acceptedAt: 2000 });
        save.mockImplementation(async (name, book) => { books.set(name, structuredClone(book)); });
        await mergeGrowthHistoryIdentities('ent-mara', 'ent-other', BOOK, () => {});
        getEvidenceFile('Mara').raw.push({ id: 'later', claim: 'Patient', category: 'trait', ts: 2500 });
        const p = proposal();
        p.changes[0].evidenceIds = ['later'];
        setFakeApi(request => { requests.push(request); return JSON.stringify(p); });
        const result = await draftGrowthDossier('Mara');
        expect(result.proposal.changes[0].sourceLabel).not.toBe('hand edit, no evidence');
        expect(result.proposal.changes[0].evidenceIds).toEqual(['later']);
        expect(result.proposal.changes[0].echoStatus).toContain('possible echo');
        expect(result.lineage[0].firstApprovedAt).toBe(1000);
        expect(requests[0].userContent).not.toContain('activeDossierApproval');
    });
    test('future history version blocks rather than pretending no approvals exist', async () => {
        books.get(BOOK).entries[9] = { comment: '[MWT:growth-history]', content: '{"version":99,"records":{}}' };
        await expect(draftGrowthDossier('Mara')).rejects.toThrow('unsupported-version');
        expect(requests).toHaveLength(0);
    });
});