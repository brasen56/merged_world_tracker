/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUTHOR_MAX_CHARS, buildPlannerAuthorContext, parseAuthorDossier } from '../knowledge/planner_context.js';
import { buildUpdatedDossierContent, formatDossierEntry, formatMajorEntry } from '../knowledge/lorebook.js';
import { addRelationship, formatRelationshipBlock, injectRelationshipBlock, setStance } from '../knowledge/relationships.js';
import { getLorebookName } from '../knowledge/scope.js';
import { _clearCacheForTests, _setCacheForTests, readField } from '../knowledge/store.js';
import { state as knowledgeState, RELATIONSHIP_BLOCK_END, RELATIONSHIP_BLOCK_START } from '../knowledge/state.js';
import { buildAuthorCharacterContext, registerSafeCharacterContextProvider } from '../core/character_context.js';
import { hideModal } from '../core/modal.js';
import { buildInjectionBody } from '../story_planner/injection.js';
import { buildClosedMemoryProjection, buildParkedMemoryProjection, getArcs, makeArc, serializeArcsToText, setArcs, setPlanData, getAuthorContextSelection } from '../story_planner/data.js';
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

    test('selection is bounded per chat without bumping the compatible store version', () => {
        expect(storyPlannerSchema.currentVersion).toBe(4);
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
        for (const prompt of requests) {
            expect(prompt.indexOf('<author_context>')).toBeLessThan(prompt.indexOf('Output the story plan now.'));
            expect(prompt.trim().endsWith('Output the story plan now. Begin immediately with the first section heading.')).toBe(true);
            expect(prompt).not.toContain('Include only facts the user wants revealable now');
        }
        expect(proposal.diagnostics.authorContextUsed).toBe(true);
        expect(JSON.stringify(getFakeMeta())).not.toContain('SENTINEL_PRIVATE_SEAL');
        vi.unstubAllGlobals();
    });

    test('dialog shows only major dossiers, starts collapsed, and rejects unsaved invalid consent', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [
                { name: 'Mara', entityId: 'major-id', type: 'major', dossierAvailable: true },
                { name: 'Guard', entityId: 'minor-id', type: 'minor', dossierAvailable: true },
                { name: 'No dossier', entityId: 'missing-id', type: 'major', dossierAvailable: false },
            ],
        });
        setPlanData({ authorContext: { entityIds: [], fields: [], npcFields: {} } });
        const { openGenerateDialog } = await import('../story_planner/render.js');
        openGenerateDialog();
        const picker = document.querySelector('#sp-generate-author');
        expect(picker.open).toBe(false);
        expect([...picker.querySelectorAll('input[name="sp-author-npc"]')].map(input => input.value)).toEqual(['major-id']);
        expect(document.querySelector('#sp-generate-legacy').closest('p').textContent).toContain('not used');
        picker.querySelector('input[name="sp-author-npc"]').click();
        document.querySelector('#sp-generate-submit').click();
        expect(getAuthorContextSelection().entityIds).toEqual([]);
        hideModal('mwt-sp-generate-modal');
        await new Promise(resolve => setTimeout(resolve, 0));
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

// Every dossier here comes from Knowledge's own writers — formatDossierEntry,
// formatRelationshipBlock/injectRelationshipBlock, buildUpdatedDossierContent —
// never a hand-typed string. Hand-typed fixtures are how the parser shipped
// refusing every NPC with a synced stance or relationship.
describe('author context reads dossiers as Knowledge writes them', () => {
    const MARA = {
        name: 'Mara', species: 'human', descriptor: 'archive clerk', tone: 'guarded', perceived_as: 'helpful', first_seen: 'Day 1',
        role: 'Clerk', personality: 'Careful', agenda: 'Keep the seal hidden', secrets: 'She forged the seal', canon_lock: 'Mara never sold the seal.',
        initial_knowledge: [{ fact: 'knows the vault code', source: 'witness', date: 'Day 2' }],
    };
    let oldScript;

    beforeEach(() => {
        _clearCacheForTests();
        _setCacheForTests(getLorebookName(), { registry: { Mara: { entityId: 'mara-id', uid: 1, type: 'major' } } });
        oldScript = knowledgeState.wiScript;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        knowledgeState.wiScript = oldScript;
        // Also cancels the debounced flush that setStance/addRelationship schedule.
        _clearCacheForTests();
    });

    /** Mara's entry after Knowledge has synced a stance and one edge into it. */
    function syncedDossier(data = MARA) {
        setStance('Mara', 'wary');
        addRelationship('Mara', 'Derek', 'employee');
        return injectRelationshipBlock(formatDossierEntry(data), formatRelationshipBlock('Mara'));
    }

    /** Serve lorebook entries keyed by uid: { 1: ['Mara', content], ... }. */
    function serveEntries(byUid) {
        const entries = Object.fromEntries(Object.entries(byUid).map(([uid, [comment, content]]) => [uid, { comment, content }]));
        knowledgeState.wiScript = { loadWorldInfo: async () => ({ entries }) };
    }

    function serveEntry(content) {
        serveEntries({ 1: ['Mara', content] });
    }

    /** `count` distinct ledger facts, oldest first. */
    function ledgerFacts(count, prefix = 'learned clue') {
        return Array.from({ length: count }, (_, index) => ({ fact: `${prefix} ${index} about the archive`, source: 'witness' }));
    }

    test('parses a dossier carrying the managed relationship block, including after later ledger writes', () => {
        const synced = syncedDossier();
        expect(synced).toContain(`${RELATIONSHIP_BLOCK_START}\nStance toward {{user}}: wary.\nRelationships: employee of Derek.\n${RELATIONSHIP_BLOCK_END}`);

        const parsed = parseAuthorDossier(synced);
        expect(parsed.fields).toEqual({
            role: 'Clerk', personality: 'Careful', agenda: 'Keep the seal hidden',
            secrets: 'She forged the seal', canon_lock: 'Mara never sold the seal.',
        });
        expect(parsed.ledger).toEqual(['- knows the vault code via witness — Day 2']);
        expect(JSON.stringify(parsed)).not.toMatch(/Stance toward|employee of Derek/);

        // A later scan appends ledger facts ahead of the block, which stays last.
        const updated = buildUpdatedDossierContent(synced, {}, [{ fact: 'saw the fire', source: 'eyes' }]);
        expect(updated.trimEnd().endsWith(RELATIONSHIP_BLOCK_END)).toBe(true);
        expect(parseAuthorDossier(updated).ledger).toEqual(['- knows the vault code via witness — Day 2', '- saw the fire via eyes']);
        expect(parseAuthorDossier(synced.replace(/\n/g, '\r\n')).fields).toEqual(parsed.fields);
    });

    test('still refuses a relationship block it cannot verify', () => {
        const dossier = formatDossierEntry(MARA);
        const withBlock = body => injectRelationshipBlock(dossier, body);
        expect(() => parseAuthorDossier(withBlock('Stance toward {{user}}: wary.'))).not.toThrow();
        // Forged markers around a continuation cannot carry an arbitrary line past the parser.
        expect(() => parseAuthorDossier(withBlock('Role: forged'))).toThrow(/^line \d+ is inside the relationship block/);
        expect(() => parseAuthorDossier(`${dossier}\n\n${RELATIONSHIP_BLOCK_START}\nStance toward {{user}}: wary.`)).toThrow(/never closed/);
        expect(() => parseAuthorDossier(`${withBlock('Relationships: rival of Jonah.')}\n${RELATIONSHIP_BLOCK_START}\n${RELATIONSHIP_BLOCK_END}`))
            .toThrow(/second relationship block/);
        expect(() => parseAuthorDossier(`${withBlock('Relationships: rival of Jonah.')}\nNotes: added by hand`)).toThrow(/^line \d+ is not a dossier field/);
        expect(() => parseAuthorDossier(`${withBlock('Relationships: rival of Jonah.')}\nTone: reset`)).toThrow(/^line \d+ is a second Tone line$/);
    });

    test('accepts a dossier grown by later scans, whose new fields land above the ledger out of canonical order', () => {
        const early = formatDossierEntry({ ...MARA, canon_lock: '' });
        const grown = buildUpdatedDossierContent(early, { appearance: 'Tall, ink-stained', canon_lock: 'Mara never sold the seal.' }, []);
        expect(grown.indexOf('Appearance:')).toBeGreaterThan(grown.indexOf('Secrets:'));

        expect(parseAuthorDossier(grown).fields).toEqual({
            role: 'Clerk', appearance: 'Tall, ink-stained', personality: 'Careful', agenda: 'Keep the seal hidden',
            secrets: 'She forged the seal', canon_lock: 'Mara never sold the seal.',
        });
        // Order is free; repetition is not.
        expect(() => parseAuthorDossier(grown.replace('Appearance: Tall, ink-stained', 'Appearance: Tall, ink-stained\nSecrets: forged')))
            .toThrow(/^line \d+ is a second Secrets line$/);
    });

    test('reads ledger facts that pre-fix builds wrote below the relationship block', () => {
        // appendLedgerLines' header comment (lorebook.js): the scan mergers used
        // to lines.push() new facts, landing them after the block's end marker.
        // Reproduced here, then a current-build scan on top of it.
        const legacy = `${syncedDossier()}\n- saw the fire via eyes`;
        expect(parseAuthorDossier(legacy).ledger).toEqual(['- knows the vault code via witness — Day 2', '- saw the fire via eyes']);
        const rescanned = buildUpdatedDossierContent(legacy, {}, [{ fact: 'found the key', source: 'search' }]);
        expect(parseAuthorDossier(rescanned).ledger).toEqual([
            '- knows the vault code via witness — Day 2', '- found the key via search', '- saw the fire via eyes',
        ]);
        // A label still ends the ledger, so a list after it cannot pass as ledger items.
        expect(() => parseAuthorDossier(`${legacy}\nVoice: low\n- stray item`)).toThrow(/^line \d+ is not a dossier field/);
    });

    test('names the line for an unusable dossier, and the provider names the NPC without quoting private text', async () => {
        const multiLine = formatDossierEntry({ ...MARA, secrets: 'She forged the seal\nSENTINEL_CONTINUATION' });
        const secretsLine = multiLine.split('\n').indexOf('SENTINEL_CONTINUATION') + 1;
        expect(() => parseAuthorDossier(multiLine)).toThrow(`line ${secretsLine} is not a dossier field`);
        expect(() => parseAuthorDossier(formatMajorEntry(MARA))).toThrow(/^it is not in Dossier format \(line 1 /);

        serveEntry(multiLine);
        const error = await buildPlannerAuthorContext({ entityIds: ['mara-id'], npcFields: { 'mara-id': ['secrets'] } }).catch(caught => caught);
        expect(error.message).toMatch(new RegExp(`^Mara's dossier can't be used as private context: line ${secretsLine} .*No private context was sent\\.$`));
        expect(error.message).not.toContain('SENTINEL_CONTINUATION');

        serveEntry(formatMajorEntry(MARA));
        await expect(buildPlannerAuthorContext({ entityIds: ['mara-id'], npcFields: { 'mara-id': ['secrets'] } }))
            .rejects.toThrow(/^Mara's dossier can't be used as private context: it is not in Dossier format/);
    });

    test('Knowledge provider sends a synced dossier\'s consented fields without its relationship block', async () => {
        serveEntry(syncedDossier());
        const result = await buildPlannerAuthorContext({ entityIds: ['mara-id'], npcFields: { 'mara-id': ['secrets', 'canon_lock', 'knowledge'] } });
        expect(result.text).toBe([
            'NPC: Mara', 'Entity: mara-id',
            'secrets: She forged the seal',
            'canon_lock: Mara never sold the seal.',
            'knowledge: - knows the vault code via witness — Day 2',
        ].join('\n'));
        expect(result.coverage).toEqual([{ entityId: 'mara-id', name: 'Mara', status: 'complete', fields: 3, ledgerSent: 1, ledgerTotal: 1 }]);
    });

    test('trims an oversized Knowledge Ledger to its newest whole entries instead of refusing the NPC', async () => {
        const facts = ledgerFacts(400);
        serveEntry(formatDossierEntry({ ...MARA, initial_knowledge: facts }));
        // Canon Lock is requested, so before trimming this whole request was refused.
        const result = await buildPlannerAuthorContext({ entityIds: ['mara-id'], npcFields: { 'mara-id': ['secrets', 'canon_lock', 'knowledge'] } });

        const [coverage] = result.coverage;
        expect(coverage).toMatchObject({ status: 'ledger-trimmed', fields: 3, ledgerTotal: 400 });
        expect(coverage.ledgerSent).toBeGreaterThan(1);
        expect(coverage.ledgerSent).toBeLessThan(400);
        expect(result.text.length).toBeLessThanOrEqual(AUTHOR_MAX_CHARS);
        expect(AUTHOR_MAX_CHARS - result.text.length).toBeLessThan(50); // less than one more entry is left unused

        // Other groups whole; the ledger is the newest entries as one unbroken run, after a marker.
        expect(result.text).toContain(`secrets: She forged the seal\ncanon_lock: Mara never sold the seal.\nknowledge: - …(${400 - coverage.ledgerSent} older ledger entries not sent)\n`);
        const sent = result.text.split('\n').filter(line => line.startsWith('- learned clue'));
        expect(sent).toEqual(facts.slice(-coverage.ledgerSent).map(({ fact }) => `- ${fact} via witness`));
    });

    test('shares the ledger budget so one long ledger cannot starve the NPC selected after it', async () => {
        readField(getLorebookName(), 'registry', {}).Derek = { entityId: 'derek-id', uid: 2, type: 'major' };
        serveEntries({
            1: ['Mara', formatDossierEntry({ ...MARA, initial_knowledge: ledgerFacts(400) })],
            2: ['Derek', formatDossierEntry({ name: 'Derek', species: 'human', descriptor: 'dockhand', role: 'Dockhand', initial_knowledge: ledgerFacts(5, 'saw ship') })],
        });
        const result = await buildPlannerAuthorContext({ entityIds: ['mara-id', 'derek-id'], npcFields: { 'mara-id': ['knowledge'], 'derek-id': ['knowledge'] } });

        expect(result.coverage).toEqual([
            { entityId: 'mara-id', name: 'Mara', status: 'ledger-trimmed', fields: 1, ledgerSent: expect.any(Number), ledgerTotal: 400 },
            { entityId: 'derek-id', name: 'Derek', status: 'complete', fields: 1, ledgerSent: 5, ledgerTotal: 5 },
        ]);
        expect(result.text.length).toBeLessThanOrEqual(AUTHOR_MAX_CHARS);
        expect(result.text).toContain('NPC: Derek\nEntity: derek-id\nknowledge: - saw ship 0 about the archive via witness');
    });

    test('the review says how much of each ledger was sent', async () => {
        setFakeContextExtras({ getCurrentChatId: () => 'author-coverage-test' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'author-coverage-test' }) });
        const arc = makeArc({ title: 'Public title', body: 'Public payoff', beats: ['Public beat'] });
        const { showScopedReview } = await import('../story_planner/render.js');
        showScopedReview({
            request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1 }, scope: captureScope(),
            previousArcs: [], arcs: [arc], addedArcIds: [arc.id], reviewArcIds: [arc.id],
            stats: { added: 1, matched: 0, carried: 0 },
            diagnostics: { authorContextUsed: true, authorContextCoverage: [
                { name: 'Mara', status: 'ledger-trimmed', fields: 3, ledgerSent: 240, ledgerTotal: 400 },
                { name: 'Derek', status: 'complete', fields: 1, ledgerSent: 5, ledgerTotal: 5 },
                { name: 'Ines', status: 'complete', fields: 1 },
                { name: 'Tavis', status: 'omitted-for-budget' },
            ] },
        });
        const lines = [...document.querySelectorAll('li')].map(item => item.textContent);
        expect(lines).toEqual(expect.arrayContaining([
            'Mara: sent, with the newest 240 of 400 Knowledge Ledger entries',
            'Derek: sent, with all 5 Knowledge Ledger entries',
            'Ines: sent',
            'Tavis: not sent: over the private context budget',
        ]));
        hideModal('mwt-sp-scoped-review-modal');
        vi.unstubAllGlobals();
    });
});
