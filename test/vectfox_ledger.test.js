import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeApi } from './stubs/core.js';
import { saveSettings } from '../knowledge/settings.js';
import { saveRegistry } from '../knowledge/registry.js';
import { state } from '../knowledge/state.js';
import { _resetEpoch, bumpEpoch } from '../core/scope.js';
import { appendLedgerLines, writeToLorebook } from '../knowledge/lorebook.js';
import { validateVectFoxHistory, historyWriteGuard } from '../knowledge/vectfox_history.js';
import { mapVectFoxAcquisitions, prepareVectFoxLedger } from '../knowledge/vectfox_ledger.js';
import { loadCleanupBook, hostCacheConflict, saveCleanupBook } from '../knowledge/cleanup_persistence.js';

vi.mock('../knowledge/cleanup_persistence.js', () => ({
    loadCleanupBook: vi.fn(), hostCacheConflict: vi.fn(), saveCleanupBook: vi.fn(),
}));

const context = { name: 'Ranger', aliases: ['Captain'] };
const content = 'Ranger\nKnowledge Ledger:\n- (no entries yet)';
const acquisition = (claim, extra = {}) => ({ character: 'Ranger', claim, basis: 'witnessed',
    epistemic_status: 'fact', uncertainty: '', evidence: [{ source_index: 0, source_ref: 'vf:e:source:0', quote: 'supported acquisition' }], ...extra });
const event = acquisitions => ({ event_ref: 'vf:e', characters: ['Ranger', 'Alex'],
    summary: 'The sealed letter contained a confession. The destination was secret.',
    source_refs: [{ ref: 'vf:e:source:0' }], knowledge_status: 'recorded', knowledge: { v: 1, acquisitions } });
const source = () => ({ ref: 'vf:e:source:0', status: 'verified', reason: null,
    current_fingerprint: 'fp', message: { mes: 'The narrative establishes a supported acquisition here.' } });
let events, api, status, entry, saves, generation, sourceStatus;

beforeEach(() => {
    resetCoreStubs(); _resetEpoch();
    saveSettings({ scope: 'global' });
    saveRegistry({ Ranger: { uid: 7, type: 'major', entityId: 'ranger-1', aliases: ['Captain'] } });
    events = [event([acquisition('Alex delivered a sealed letter.')])];
    sourceStatus = 'verified';
    status = { ready: true, scope_token: 'scope', capabilities: { history: { available: true },
        source_resolution: { available: true }, knowledge_acquisition: { available: true, schema_version: 1 } } };
    api = { version: 1, getStatus: () => structuredClone(status),
        findEvents: vi.fn(async () => ({ ok: true, scope_token: status.scope_token, events: structuredClone(events), coverage: { partial: true } })),
        resolveSources: vi.fn(async request => ({ ok: true, scope_token: status.scope_token,
            sources: request.sources.map(ref => ({ ...ref, ...source(), status: sourceStatus })) })) };
    vi.stubGlobal('window', { VectFoxAPI: api });
    entry = { uid: 7, comment: 'Ranger', content };
    saves = vi.fn();
    state.wiScript = { loadWorldInfo: async () => ({ entries: { 7: structuredClone(entry) } }), saveWorldInfo: saves };
    loadCleanupBook.mockImplementation(async () => ({ entries: { 7: structuredClone(entry) } }));
    hostCacheConflict.mockReturnValue(null);
    saveCleanupBook.mockClear();
    generation = vi.fn(); setFakeApi(generation);
});
afterEach(() => vi.unstubAllGlobals());

describe('Phase 4b deterministic mapping', () => {
    test.each([
        ['sealed letter', [acquisition('Alex delivered a sealed letter.')], ['confession']],
        ['mention-only', [], ['confession']],
        ['off-screen explicit', [acquisition('The bridge fell.', { basis: 'document' })], ['confession']],
        ['off-screen unknown', [], ['bridge']],
        ['lie', [acquisition('Alex said the vault was empty.', { basis: 'told', epistemic_status: 'belief', uncertainty: 'Alex was lying; acceptance not stated.' })], ['[fact]']],
        ['rumor', [acquisition('The queen fled.', { basis: 'rumor', epistemic_status: 'rumor', uncertainty: 'Unconfirmed.' })], ['[fact]']],
        ['partial disclosure', [acquisition('A shipment will arrive.', { basis: 'told' })], ['destination']],
    ])('%s imports only explicit knowledge', (_label, acquisitions, excluded) => {
        const result = mapVectFoxAcquisitions([event(acquisitions)], context, [source()], content);
        expect(result.items).toHaveLength(acquisitions.length);
        const persisted = appendLedgerLines(content.split('\n'), result.items).join('\n');
        for (const word of excluded) expect(persisted).not.toContain(word);
        for (const item of acquisitions) {
            expect(persisted).toContain(item.claim);
            expect(persisted).toContain(`VectFox (${item.basis})`);
            expect(persisted).toContain('vf:e:source:0');
            if (item.uncertainty) expect(persisted).toContain(item.uncertainty);
        }
    });
    test('legacy, unsupported schema and other characters never populate ledgers', () => {
        const other = event([acquisition('Secret', { character: 'Alex' })]);
        expect(mapVectFoxAcquisitions([{ ...event([]), knowledge: null },
            { ...event([]), knowledge: { v: 2, acquisitions: [acquisition('Secret')] } }, other], context, [source()], content).items).toEqual([]);
    });
    test('registered alias maps, conflicting alias does not', () => {
        const input = [event([acquisition('Delivery occurred.', { character: 'Captain' })])];
        expect(mapVectFoxAcquisitions(input, context, [source()], content).items).toHaveLength(1);
        saveRegistry({ Ranger: { uid: 7, aliases: [] }, Captain: { uid: 8 } });
        expect(mapVectFoxAcquisitions(input, context, [source()], content).items).toHaveLength(0);
    });
    test('shared aliases are deferred for either NPC while canonical names still import', () => {
        saveRegistry({ Ranger: { uid: 7, aliases: ['Captain'] }, Alex: { uid: 8, aliases: ['Captain'] } });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            for (const name of ['Ranger', 'Alex']) {
                const npc = { name, aliases: ['Captain'] };
                const input = [event([acquisition('Delivery occurred.', { character: 'Captain' })])];
                const result = mapVectFoxAcquisitions(input, npc, [source()], content);
                expect(result.items).toEqual([]);
                expect(result.records).toEqual([]);
                expect(result.deferred).toHaveLength(1);
                expect(mapVectFoxAcquisitions([event([acquisition('Delivery occurred.', { character: name })])],
                    npc, [source()], content).items).toHaveLength(1);
            }
            expect(warning).toHaveBeenCalledWith(expect.stringContaining('ambiguous alias'));
        } finally {
            warning.mockRestore();
        }
    });
    test('an alias absent from the registry is deferred even if present in the supplied context', () => {
        saveRegistry({ Ranger: { uid: 7, aliases: [] } });
        const input = [event([acquisition('Delivery occurred.', { character: 'Captain' })])];
        const result = mapVectFoxAcquisitions(input, context, [source()], content);
        expect(result.items).toEqual([]);
        expect(result.deferred).toHaveLength(1);
    });
    test.each(['changed', 'missing', 'unresolved'])('defers %s originals', value => {
        const result = mapVectFoxAcquisitions(events, context, [{ ...source(), status: value }], content);
        expect(result.items).toEqual([]); expect(result.deferred).toHaveLength(1);
    });
    test('rejects forged references, unmatched quotes and oversized items without clipping', () => {
        const bad = [acquisition('Forged', { evidence: [{ source_index: 1, source_ref: 'vf:e:source:0', quote: 'supported acquisition' }] }),
            acquisition('No quote', { evidence: [{ source_index: 0, source_ref: 'vf:e:source:0', quote: 'not in original' }] }),
            acquisition('x'.repeat(900))];
        const result = mapVectFoxAcquisitions([event(bad)], context, [source()], content);
        expect(result.items).toEqual([]); expect(result.deferred).toHaveLength(3);
    });
    test('deduplicates accepted knowledge and repeat proposals without collapsing epistemic distinctions', () => {
        const input = [event([acquisition('Delivery occurred.'), acquisition('Delivery occurred.')])];
        const first = mapVectFoxAcquisitions(input, context, [source()], content);
        expect(first.items).toHaveLength(1);
        const saved = appendLedgerLines(content.split('\n'), first.items).join('\n');
        expect(mapVectFoxAcquisitions(input, context, [source()], saved).items).toHaveLength(0);
        const plain = 'Knowledge Ledger:\n- Delivery occurred. via Alex';
        expect(mapVectFoxAcquisitions(input, context, [source()], plain).items).toHaveLength(0);
        expect(mapVectFoxAcquisitions([event([acquisition('Delivery occurred.', { epistemic_status: 'rumor', basis: 'rumor' })])], context, [source()], plain).items).toHaveLength(1);
    });
    test.each([
        ['claim', 'The shipment arrives via the north gate.', ''],
        ['uncertainty', 'The shipment arrives.', 'Reported via Alex; not independently confirmed.'],
        ['both', 'The shipment arrives via the north gate.', 'Reported via Alex via a courier.'],
    ])('repeat imports preserve via inside %s text', (_label, claim, uncertainty) => {
        const input = [event([acquisition(claim, { uncertainty })])];
        const first = mapVectFoxAcquisitions(input, context, [source()], content);
        expect(first.items).toHaveLength(1);
        const saved = appendLedgerLines(content.split('\n'), first.items).join('\n');
        const repeat = mapVectFoxAcquisitions(input, context, [source()], saved);
        expect(repeat.items).toEqual([]);
        expect(repeat.records).toEqual([]);
        expect(repeat.deferred).toEqual([]);
    });
    test('a claim containing via does not suppress a distinct shorter claim', () => {
        const first = mapVectFoxAcquisitions([event([acquisition('The shipment arrives via the north gate.')])],
            context, [source()], content);
        const saved = appendLedgerLines(content.split('\n'), first.items).join('\n');
        const result = mapVectFoxAcquisitions([event([acquisition('The shipment arrives')])], context, [source()], saved);
        expect(result.items).toHaveLength(1);
    });
    test('legacy facts containing via still deduplicate with a source and optional date', () => {
        const claim = 'The shipment arrives via the north gate.';
        for (const date of ['', '2026-10-21']) {
            const saved = appendLedgerLines(content.split('\n'), [{ fact: claim, source: 'Alex', date }]).join('\n');
            expect(mapVectFoxAcquisitions([event([acquisition(claim)])], context, [source()], saved).items).toEqual([]);
        }
    });
    test('caps proposals at 30 items and reports deferred overflow', () => {
        const input = [event(Array.from({ length: 35 }, (_, i) => acquisition(`Specific acquisition ${i}.`)))];
        const result = mapVectFoxAcquisitions(input, context, [source()], content);
        expect(result.items).toHaveLength(30);
        expect(result.deferred).toHaveLength(5);
    });
});

describe('retrieval and guarded acceptance', () => {
    test('stages without generation or writes, then persists source and meaning via existing write seam', async () => {
        const result = await prepareVectFoxLedger('Ranger', 7);
        expect(api.findEvents.mock.calls[0][0].scope).toEqual({ kind: 'current_chat' });
        expect(result.items).toHaveLength(1);
        expect(result.historyEvidence.coverage.partial).toBe(true);
        expect(saves).not.toHaveBeenCalled(); expect(generation).not.toHaveBeenCalled();
        const written = await writeToLorebook('Ranger', result.merged, ['Ranger'], 7, {
            bookName: result.historyEvidence.context.book,
            beforeWrite: entries => historyWriteGuard(result.historyEvidence, result.historyRevision, entries),
        });
        expect(written.success).toBe(true);
        expect(saveCleanupBook).toHaveBeenCalled();
        expect(result.merged).toContain('[fact] Alex delivered a sealed letter.');
        expect(result.merged).toContain('vf:e:source:0');
    });
    test('unavailable capability differs from successful empty history', async () => {
        events = [];
        expect((await prepareVectFoxLedger('Ranger', 7)).items).toEqual([]);
        status.capabilities.knowledge_acquisition.schema_version = 2;
        await expect(prepareVectFoxLedger('Ranger', 7)).rejects.toThrow(/unavailable/);
    });
    test('discards retrieval when the ledger is edited during the request', async () => {
        api.findEvents.mockImplementation(async () => {
            entry.content += '\nManual edit';
            return { ok: true, scope_token: status.scope_token, events };
        });
        await expect(prepareVectFoxLedger('Ranger', 7)).rejects.toThrow(/changed during import/);
        expect(saves).not.toHaveBeenCalled();
    });
    test('source changes, chat switches and concurrent entry edits block acceptance', async () => {
        const result = await prepareVectFoxLedger('Ranger', 7);
        sourceStatus = 'changed';
        await expect(validateVectFoxHistory(result.historyEvidence)).rejects.toThrow(/validity changed/);
        sourceStatus = 'verified';
        expect(historyWriteGuard(result.historyEvidence, result.historyRevision, { 7: { ...entry, content: 'edited' } }).error).toMatch(/revision/);
        bumpEpoch();
        expect(historyWriteGuard(result.historyEvidence, result.historyRevision, { 7: entry }).error).toMatch(/stale/);
        expect(saves).not.toHaveBeenCalled();
    });
});