/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildPlannerAuthorContext, parseAuthorDossier } from '../knowledge/planner_context.js';
import { getLorebookName } from '../knowledge/scope.js';
import { readField } from '../knowledge/store.js';
import { state as knowledgeState } from '../knowledge/state.js';
import { buildAuthorCharacterContext, registerSafeCharacterContextProvider } from '../core/character_context.js';
import { buildInjectionBody } from '../story_planner/injection.js';
import { buildClosedMemoryProjection, buildParkedMemoryProjection, getArcs, makeArc, serializeArcsToText, setArcs } from '../story_planner/data.js';
import { sanitizeAuthorContextSelection, storyPlannerSchema } from '../story_planner/schema.js';
import { saveSettings } from '../story_planner/settings.js';
import { captureScope, resetCoreStubs, setFakeApi, setFakeChat, setFakeContextExtras, getFakeMeta } from './stubs/core.js';

beforeEach(() => { resetCoreStubs(); vi.restoreAllMocks(); });

describe('Story Planner private author-context boundary', () => {
    test('parses whole ordered dossiers and refuses unrecognised or forged boundaries', () => {
        const dossier = '[Dossier] Mara | human | clerk\nRole: Clerk\nRead on PC: wary\nCurrent Agenda: private agenda\nSecrets: hidden seal\nCanon Lock: never sold it\n\nKnowledge Ledger:\n- knows the key via witness';
        expect(parseAuthorDossier(dossier)).toMatchObject({ fields: { role: 'Clerk', secrets: 'hidden seal', canon_lock: 'never sold it' }, ledger: ['- knows the key via witness'] });
        expect(() => parseAuthorDossier(dossier.replace('Secrets: hidden seal', 'Secrets: hidden seal\nRole: fake role'))).toThrow();
        expect(() => parseAuthorDossier(dossier.replace('Knowledge Ledger:', 'Unknown Section:'))).toThrow();
        expect(() => parseAuthorDossier(dossier.replace('Knowledge Ledger:', ''))).toThrow();
    });

    test('Knowledge provider attributes ledger to its owning NPC and includes only consented complete groups', async () => {
        const registry = readField(getLorebookName(), 'registry', {});
        registry.Mara = { entityId: 'mara-id', uid: 1, type: 'major' };
        registry.Derek = { entityId: 'derek-id', uid: 2, type: 'major' };
        const oldScript = knowledgeState.wiScript;
        knowledgeState.wiScript = {
            loadWorldInfo: async () => ({ entries: {
                1: { comment: 'Mara', content: '[Dossier] Mara | human | clerk\nRole: Clerk\nSecrets: MARA_SECRET\nCanon Lock: Mara never sold the seal.\nKnowledge Ledger:\n- MARA_LEDGER via witness' },
                2: { comment: 'Derek', content: '[Dossier] Derek | human | witness\nRole: Witness\nSecrets: DEREK_SECRET\nKnowledge Ledger:\n- DEREK_LEDGER via letter' },
            } }),
        };
        try {
            const selection = { entityIds: ['mara-id', 'derek-id'], npcFields: { 'mara-id': ['knowledge', 'canon_lock'], 'derek-id': ['secrets'] } };
            const result = await buildPlannerAuthorContext(selection);
            expect(result.text).toContain('NPC: Mara\nEntity: mara-id\nknowledge: - MARA_LEDGER via witness\ncanon_lock: Mara never sold the seal.');
            expect(result.text).toContain('NPC: Derek\nEntity: derek-id\nsecrets: DEREK_SECRET');
            expect(result.text).not.toMatch(/MARA_SECRET|DEREK_LEDGER/);
            await expect(buildPlannerAuthorContext({ entityIds: ['derek-id'], npcFields: { 'derek-id': ['canon_lock'] } })).rejects.toThrow(/Canon Lock/);
            registry.Derek.type = 'minor';
            await expect(buildPlannerAuthorContext({ entityIds: ['derek-id'], npcFields: { 'derek-id': ['secrets'] } })).rejects.toThrow(/major-NPC dossier/);
        } finally {
            knowledgeState.wiScript = oldScript;
            delete registry.Mara;
            delete registry.Derek;
        }
    });

    test('private context requires a provider and never falls back to public context', async () => {
        await expect(buildAuthorCharacterContext({ entityIds: ['m'], fields: ['secrets'] })).rejects.toThrow(/unavailable/);
        const provider = vi.fn(async () => ({ text: 'hidden seal', coverage: [] }));
        registerSafeCharacterContextProvider({ buildAuthorContext: provider });
        expect((await buildAuthorCharacterContext({ entityIds: ['m'], fields: ['secrets'] })).text).toBe('hidden seal');
        expect(provider).toHaveBeenCalledTimes(1);
        await expect(buildAuthorCharacterContext({ entityIds: [], fields: ['secrets'] })).rejects.toThrow(/Select at least one/);
    });

    test('private-looking arbitrary fields cannot persist into the public arc schema or projections', () => {
        const secret = 'SENTINEL_PRIVATE_SEAL';
        const arc = makeArc({ title: 'Public title', body: 'Public payoff', beats: ['Public beat'] });
        setArcs([{ ...arc, authorNote: secret, secret, beats: arc.beats.map(beat => ({ ...beat, authorNote: secret })) }]);
        const stored = getArcs();
        expect(JSON.stringify(stored)).not.toContain(secret);
        expect([serializeArcsToText(stored), buildInjectionBody(), buildClosedMemoryProjection(stored), buildParkedMemoryProjection(stored)].join('\n')).not.toContain(secret);
    });

    test('selection is bounded per chat, schema migration has its own version', () => {
        expect(storyPlannerSchema.currentVersion).toBe(5);
        expect(sanitizeAuthorContextSelection({ entityIds: ['one', 'one'], fields: ['secrets', 'bogus', 'secrets'] })).toEqual({ entityIds: ['one'], fields: ['secrets'], npcFields: { one: ['secrets'] } });
        expect(sanitizeAuthorContextSelection({ entityIds: ['one', 'two'], npcFields: { one: ['secrets'], two: ['canon_lock', 'unknown'] } }).npcFields)
            .toEqual({ one: ['secrets'], two: ['canon_lock'] });
    });

    test('private context is sent only through a reviewed scoped call, including retry', async () => {
        saveSettings({ apiUrl: 'https://example.test', modelName: 'author-test' });
        setFakeChat([
            { is_user: true, name: 'User', mes: 'We prepare the journey and carefully review the records while deciding which route to take next and which witness to ask.' },
            { is_user: false, name: 'Mara', mes: 'The archive is open and the records are ready. The witness waits by the doors as we compare the signatures and plan the next meeting.' },
            { is_user: true, name: 'User', mes: 'We continue the review.' },
        ]);
        setFakeContextExtras({ getCurrentChatId: () => 'author-context-test' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'author-context-test' }) });
        const requests = [];
        setFakeApi(async request => {
            requests.push(request.userContent);
            return requests.length === 1 ? 'invalid output' : '## Horizon Arcs\n- The Open Door — Public turning point.\n  - Public setup beat.';
        });
        registerSafeCharacterContextProvider({
            listCandidates: () => [{ name: 'Mara', entityId: 'm', mergedEntityIds: [] }],
            buildAuthorContext: async () => ({ text: 'secrets: SENTINEL_PRIVATE_SEAL', coverage: [{ name: 'Mara', status: 'complete' }] }),
        });
        const { generatePlan } = await import('../story_planner/generation.js');
        const request = { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1 };
        const authorContextSelection = { entityIds: ['m'], fields: ['secrets'] };
        await expect(generatePlan(true, request, { reviewOnly: true, authorContextSelection })).rejects.toThrow(/reviewed scoped/);
        await expect(generatePlan(false, null, { reviewOnly: true, authorContextSelection })).rejects.toThrow(/reviewed scoped/);
        await expect(generatePlan(false, request, { authorContextSelection })).rejects.toThrow(/reviewed scoped/);
        const proposal = await generatePlan(false, request, { reviewOnly: true, authorContextSelection });
        expect(requests).toHaveLength(2);
        expect(requests.every(prompt => prompt.includes('SENTINEL_PRIVATE_SEAL'))).toBe(true);
        expect(proposal.diagnostics.authorContextUsed).toBe(true);
        expect(JSON.stringify(getFakeMeta())).not.toContain('SENTINEL_PRIVATE_SEAL');
        vi.unstubAllGlobals();
    });

    test('private-informed review edits public text before Apply and leaves withheld facts out', async () => {
        setFakeContextExtras({ getCurrentChatId: () => 'author-review-test' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'author-review-test' }) });
        const secret = 'SENTINEL_PRIVATE_SEAL';
        const proposed = makeArc({ title: `Public ${secret}`, body: secret, beats: [secret] });
        const { showScopedReview } = await import('../story_planner/render.js');
        showScopedReview({
            request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1 }, scope: captureScope(),
            previousArcs: [], arcs: [proposed], addedArcIds: [proposed.id], reviewArcIds: [proposed.id],
            stats: { added: 1, matched: 0, carried: 0 },
            diagnostics: { authorContextUsed: true, authorContextCoverage: [{ name: 'Mara', status: 'complete' }] },
        });
        const editor = document.querySelector('.sp-author-review');
        expect(editor).not.toBeNull();
        editor.querySelector('[data-field="title"]').value = 'Public title';
        editor.querySelector('[data-field="body"]').value = 'Public consequence';
        editor.querySelector('[data-beat="0"]').value = 'Public setup';
        document.querySelector('#mwt-sp-scoped-apply').click();
        expect(getArcs()).toMatchObject([{ title: 'Public title', body: 'Public consequence' }]);
        expect(JSON.stringify(getFakeMeta())).not.toContain(secret);
        vi.unstubAllGlobals();
    });
});
