/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getArcs, getPlanData, makeArc, setArcs, state, updateArc } from '../story_planner/data.js';
import { saveSettings } from '../story_planner/settings.js';
import {
    onChatChangedWhilePaused, onMessageDeleted, onMessageEdited, onMessageSwiped,
} from '../story_planner/index.js';
import {
    acceptProgressSuggestion, checkProgress, ignoreProgressSuggestion,
    PROGRESS_MAX_MESSAGE_CHARS, PROGRESS_MESSAGE_WINDOW, staleProgressSuggestionsFrom,
} from '../story_planner/progress.js';
import { createModal, releaseManagedInert, showModal } from '../core/modal.js';
import { _resetEpoch, bumpEpoch } from '../core/scope.js';
import { resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';

function messages() {
    return [
        { id: 'old', name: 'Mara', mes: 'The harbour office opens for the morning.' },
        { id: 'evidence', name: 'Clerk', mes: 'The clerk compares the pages. “The second seal is broken,” she says.' },
        { id: 'tail-user', is_user: true, name: 'User', mes: 'What happens next?' },
        { id: 'tail-ai', name: 'Mara', mes: 'This response may still be swiped.' },
    ];
}

function modelResult(verdict = 'beat_planted', excerpt = 'The second seal is broken') {
    return JSON.stringify({ results: [{ item: 'i1', verdict, source: 'm2', excerpt, reason: 'The planned clue appears explicitly.' }] });
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    state.progressSuggestions = [];
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'phase-5-chat' }) };
    setFakeChat(messages());
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
    setArcs([makeArc({ title: 'Forged manifest', body: 'Expose the forgery.', beats: ['A clerk notices the second seal is broken.'] })]);
});

afterEach(() => {
    delete globalThis.SillyTavern;
    document.body.innerHTML = '';
    releaseManagedInert();
});

describe('Story Planner Phase 5 — evidence-backed progress', () => {
    test('returns only verified proposals without settling their watermark or mutating progress', async () => {
        setFakeApi(() => modelResult());
        const result = await checkProgress();
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0]).toMatchObject({ kind: 'beat', messageIdentity: 'id:evidence' });
        expect(getArcs()[0].beats[0].state).toBe('pending');
        expect(getPlanData().progressWatermarks).toBeUndefined();
    });

    test('rejects invented excerpts without advancing the item watermark', async () => {
        setFakeApi(() => modelResult('beat_planted', 'A dragon burns every harbour ledger'));
        await expect(checkProgress()).rejects.toThrow('unverifiable excerpt');
        expect(getArcs()[0].beats[0].state).toBe('pending');
        expect(getPlanData().progressWatermarks).toBeUndefined();
    });

    test('accept re-verifies evidence and uses the normal planted mutation with history', async () => {
        setFakeApi(() => modelResult());
        const suggestion = (await checkProgress()).suggestions[0];
        const result = acceptProgressSuggestion(suggestion);
        expect(result.ok).toBe(true);
        expect(getArcs()[0].beats[0].state).toBe('planted');
        expect(getPlanData().history).toHaveLength(1);
        expect(getPlanData().progressWatermarks[suggestion.itemKey]).toEqual({ identity: 'id:evidence', index: 1 });
        expect(acceptProgressSuggestion(suggestion).ok).toBe(false);
    });

    test('accepting a beat seeds the next item watermark instead of reopening recent history', async () => {
        const arc = makeArc({ title: 'Two-stage route', beats: ['The seal breaks.', 'The ledger is opened.'] });
        setArcs([arc]);
        setFakeApi(() => modelResult());
        const suggestion = (await checkProgress()).suggestions[0];

        expect(acceptProgressSuggestion(suggestion).ok).toBe(true);

        const updated = getArcs()[0];
        const nextKey = `beat:${updated.id}:${updated.beats[1].id}`;
        expect(getPlanData().progressWatermarks[nextKey]).toEqual({ identity: 'id:evidence', index: 1 });
    });

    test('resolution acceptance uses the normal Resolve flow and keeps the edited reason', async () => {
        const ready = makeArc({ title: 'Manifest exposed', body: 'The forged manifest is publicly exposed.', beats: ['done'] });
        ready.beats[0] = { ...ready.beats[0], state: 'planted' };
        setArcs([ready]);
        setFakeApi(() => JSON.stringify({ results: [{ item: 'i1', verdict: 'arc_resolved', source: 'm2', excerpt: 'The second seal is broken', reason: 'The forgery is exposed.' }] }));
        const suggestion = (await checkProgress()).suggestions[0];
        expect(acceptProgressSuggestion(suggestion, 'The harbour clerk proved the forgery.').ok).toBe(true);
        expect(getArcs()[0]).toMatchObject({ status: 'resolved', closeReason: 'The harbour clerk proved the forgery.' });
    });

    test('ignore suppresses only the same item/evidence combination', async () => {
        setFakeApi(() => modelResult());
        const suggestion = (await checkProgress()).suggestions[0];
        ignoreProgressSuggestion(suggestion);
        // Clear the watermark to deliberately re-check the same evidence;
        // ignored evidence remains suppressed independently.
        getPlanData().progressWatermarks = {};
        expect((await checkProgress()).suggestions).toEqual([]);
    });

    test('a stale suggestion can be ignored without advancing its watermark', async () => {
        setFakeApi(() => modelResult());
        const suggestion = (await checkProgress()).suggestions[0];
        suggestion.stale = true;
        suggestion.staleReason = 'The source changed.';

        expect(ignoreProgressSuggestion(suggestion).ok).toBe(true);
        expect(getPlanData().progressWatermarks?.[suggestion.itemKey]).toBeUndefined();
        expect(getPlanData().ignoredProgressEvidence).toHaveLength(1);
    });

    test('ILS summaries are excluded from both the request and evidence verification', async () => {
        setFakeChat([
            { id: 'summary', name: 'Summary', mes: 'The clerk says the second seal is broken.', extra: { ILS_Data: { Ref: 'originals' } } },
            { id: 'tail-user', is_user: true, mes: 'Continue.' },
            { id: 'tail-ai', mes: 'Unsettled.' },
        ]);
        setFakeApi(({ userContent }) => {
            expect(userContent).not.toContain('second seal is broken');
            return JSON.stringify({ results: [{ item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' }] });
        });

        await expect(checkProgress()).resolves.toMatchObject({ upToDate: true });
    });

    test('caps the evidence prompt by recent message count and character budget', async () => {
        const settled = Array.from({ length: PROGRESS_MESSAGE_WINDOW + 25 }, (_, index) => ({
            id: `m-${index}`,
            name: 'Narrator',
            mes: `${index === 0 ? 'ANCIENT-MARKER ' : ''}${'x'.repeat(700)}`,
        }));
        setFakeChat([...settled, { id: 'tail-user', is_user: true, mes: 'Continue.' }, { id: 'tail-ai', mes: 'Unsettled.' }]);
        setFakeApi(({ userContent }) => {
            expect(userContent).not.toContain('ANCIENT-MARKER');
            const eligible = userContent.match(/<eligible_messages>([\s\S]*?)<\/eligible_messages>/)?.[1] || '';
            expect(eligible.length).toBeLessThanOrEqual(PROGRESS_MAX_MESSAGE_CHARS + 2000);
            return JSON.stringify({ results: [{ item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' }] });
        });

        await checkProgress();
    });

    test('does not call the API when every item is already at the settled tip', async () => {
        const arc = getArcs()[0];
        getPlanData().progressWatermarks = {
            [`beat:${arc.id}:${arc.beats[0].id}`]: { identity: 'id:evidence', index: 1 },
        };
        const api = vi.fn(() => modelResult());
        setFakeApi(api);

        await expect(checkProgress()).resolves.toMatchObject({ upToDate: true, suggestions: [] });
        expect(api).not.toHaveBeenCalled();
    });

    test.each(['edited', 'swiped', 'deleted'])('%s content rewinds a covering watermark', async mutation => {
        const arc = getArcs()[0];
        const key = `beat:${arc.id}:${arc.beats[0].id}`;
        getPlanData().progressWatermarks = { [key]: { identity: 'id:evidence', index: 1 } };

        if (mutation === 'edited') onMessageEdited(1);
        else if (mutation === 'swiped') onMessageSwiped(1);
        else onMessageDeleted(1, { adjustCounters: false });

        expect(getPlanData().progressWatermarks[key]).toEqual({ identity: 'id:old', index: 0 });
    });

    test('malformed persisted progress metadata cannot make Check progress throw', async () => {
        getPlanData().progressWatermarks = [];
        getPlanData().ignoredProgressEvidence = 42;
        setFakeApi(() => JSON.stringify({
            results: [{ item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' }],
        }));
        await expect(checkProgress()).resolves.toMatchObject({ suggestions: [], noEvidence: 1 });
    });

    test('ignore refuses an old-chat suggestion without writing into the current chat', async () => {
        setFakeApi(() => modelResult());
        const suggestion = (await checkProgress()).suggestions[0];
        bumpEpoch();
        expect(ignoreProgressSuggestion(suggestion)).toMatchObject({ ok: false, reason: 'scope-changed' });
        expect(getPlanData().ignoredProgressEvidence).toBeUndefined();
    });

    test('chat switch, concurrent arc edits, and message edits make acceptance fail closed', async () => {
        setFakeApi(() => modelResult());
        const first = (await checkProgress()).suggestions[0];
        bumpEpoch();
        expect(acceptProgressSuggestion(first)).toMatchObject({ ok: false, reason: 'scope-changed' });

        _resetEpoch();
        getPlanData().progressWatermarks = {};
        const second = (await checkProgress()).suggestions[0];
        updateArc(second.arcId, { body: 'A user edit made during review.' });
        expect(acceptProgressSuggestion(second)).toMatchObject({ ok: false, reason: 'source-changed' });

        setArcs([makeArc({ title: 'Fresh arc', beats: ['A clerk notices the second seal is broken.'] })]);
        getPlanData().progressWatermarks = {};
        const third = (await checkProgress()).suggestions[0];
        setFakeChat(messages().map(message => message.id === 'evidence' ? { ...message, mes: 'The clerk says nothing about a seal.' } : message));
        expect(acceptProgressSuggestion(third)).toMatchObject({ ok: false, reason: 'evidence-changed' });
    });

    test('edit/swipe invalidate only the exact source while delete invalidates shifted later sources', () => {
        const suggestions = [1, 2, 3].map(sourceIndex => ({ sourceIndex, stale: false }));
        state.progressSuggestions = suggestions;
        onMessageEdited(2);
        expect(suggestions.map(item => item.stale)).toEqual([false, true, false]);

        suggestions.forEach(item => { item.stale = false; });
        onMessageSwiped(1);
        expect(suggestions.map(item => item.stale)).toEqual([true, false, false]);

        suggestions.forEach(item => { item.stale = false; });
        onMessageDeleted(2, { adjustCounters: false });
        expect(suggestions.map(item => item.stale)).toEqual([false, true, true]);
    });

    test('an open review visibly becomes stale and disables Accept after an edit', async () => {
        setFakeApi(() => modelResult());
        await checkProgress();
        const modal = createModal({
            id: 'mwt-sp-progress-modal',
            title: 'Check progress — Review',
            content: `<article class="sp-progress-suggestion" data-progress-id="${state.progressSuggestions[0].id}">
                <div class="sp-proposal-actions">
                    <button data-progress-action="accept">Accept</button>
                </div>
            </article>`,
            destroyOnClose: true,
        });
        showModal(modal.id);
        expect(modal.querySelector('[data-progress-action="accept"]').disabled).toBe(false);

        onMessageEdited(1);

        expect(modal.querySelector('.sp-proposal-stale').textContent).toContain('edited');
        expect(modal.querySelector('[data-progress-action="accept"]').disabled).toBe(true);
    });

    test('remaining review rows still receive visible stale updates after an earlier row is removed', () => {
        const first = { id: 'first', kind: 'beat', arcTitle: 'First', itemText: 'One', excerpt: 'first quote', sourceIndex: 1, stale: false };
        const second = { id: 'second', kind: 'beat', arcTitle: 'Second', itemText: 'Two', excerpt: 'second quote', sourceIndex: 2, stale: false };
        state.progressSuggestions = [first, second];
        const modal = createModal({
            id: 'mwt-sp-progress-modal',
            title: 'Check progress — Review',
            content: `<article class="sp-progress-suggestion" data-progress-id="first">
                <div class="sp-proposal-actions"><button data-progress-action="accept">Accept</button></div>
            </article>
            <article class="sp-progress-suggestion" data-progress-id="second">
                <div class="sp-proposal-actions"><button data-progress-action="accept">Accept</button></div>
            </article>`,
            destroyOnClose: true,
        });
        showModal(modal.id);

        modal.querySelector('[data-progress-id="first"]').remove();
        state.progressSuggestions = [second];
        onMessageEdited(2);

        const remaining = modal.querySelector('[data-progress-id="second"]');
        expect(remaining.querySelector('.sp-proposal-stale').textContent).toContain('edited');
        expect(remaining.querySelector('[data-progress-action="accept"]').disabled).toBe(true);
    });

    test.each(['edited', 'swiped'])('%s messages invalidate a progress check while its API call is pending', async reason => {
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = checkProgress();
        await Promise.resolve();
        staleProgressSuggestionsFrom(1, reason);
        release(modelResult());
        await expect(pending).resolves.toMatchObject({ stale: true, suggestions: [] });
        expect(getPlanData().progressWatermarks).toBeUndefined();
        expect(state.progressSuggestions).toEqual([]);
    });

    test('a stale check explains the invalidation instead of claiming no evidence', async () => {
        const { showProgressSuggestions } = await import('../story_planner/render.js');
        showProgressSuggestions({ suggestions: [], noEvidence: 0, stale: true, staleReason: 'A message changed while progress was checked.' });
        const modal = document.getElementById('mwt-sp-progress-modal');
        expect(modal).not.toBeNull();
        expect(modal.querySelector('.sp-proposal-stale').textContent).toContain('A message changed while progress was checked.');
        expect(modal.textContent).not.toContain('No clear evidence');
    });

    test('resolution review prefills the model reason and Open source scrolls to the chat message', async () => {
        const ready = makeArc({ title: 'Manifest exposed', body: 'The forged manifest is publicly exposed.', beats: ['done'] });
        ready.beats[0] = { ...ready.beats[0], state: 'planted' };
        setArcs([ready]);
        setFakeApi(() => JSON.stringify({ results: [{ item: 'i1', verdict: 'arc_resolved', source: 'm2', excerpt: 'The second seal is broken', reason: 'The forgery is exposed.' }] }));
        const result = await checkProgress();
        document.body.innerHTML = '<div id="chat"><div class="mes" mesid="1"></div></div>';
        const target = document.querySelector('.mes');
        target.scrollIntoView = vi.fn();
        const { showProgressSuggestions } = await import('../story_planner/render.js');

        showProgressSuggestions(result);
        const modal = document.getElementById('mwt-sp-progress-modal');
        expect(modal.querySelector('textarea').value).toBe('The forgery is exposed.');
        modal.querySelector('[data-progress-action="source"]').click();
        expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    });

    test.each([
        ['missing', { results: [] }],
        ['duplicate', { results: [
            { item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' },
            { item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' },
        ] }],
        ['invalid', { results: [{ item: 'i1', verdict: 'arc_resolved', source: '', excerpt: '', reason: '' }] }],
    ])('rejects %s per-item output without advancing watermarks', async (_label, response) => {
        if (_label === 'duplicate') {
            setArcs([getArcs()[0], makeArc({ title: 'Second route', beats: ['A second pending beat.'] })]);
        }
        setFakeApi(() => JSON.stringify(response));
        await expect(checkProgress()).rejects.toThrow(/exactly one result|unknown or duplicate item|invalid verdict/);
        expect(getPlanData().progressWatermarks).toBeUndefined();
    });

    test('advances only items with a validated result when another item changed during the request', async () => {
        const second = makeArc({ title: 'Other route', beats: ['An unrelated current beat.'] });
        setArcs([getArcs()[0], second]);
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = checkProgress();
        await Promise.resolve();
        updateArc(getArcs()[0].id, { body: 'Changed while checking.' });
        release(JSON.stringify({ results: [
            { item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' },
            { item: 'i2', verdict: 'no_evidence', source: '', excerpt: '', reason: '' },
        ] }));
        await pending;
        const watermarks = getPlanData().progressWatermarks;
        expect(watermarks[`beat:${getArcs()[0].id}:${getArcs()[0].beats[0].id}`]).toBeUndefined();
        expect(watermarks[`beat:${second.id}:${second.beats[0].id}`]).toEqual({ identity: 'id:evidence', index: 1 });
    });

    test('cannot cite a message outside that item’s own post-watermark window', async () => {
        const arc = getArcs()[0];
        // The evidence itself is the watermark, so this item has no eligible
        // messages even if another item made the handle visible globally.
        getPlanData().progressWatermarks = { [`beat:${arc.id}:${arc.beats[0].id}`]: { identity: 'id:evidence', index: 1 } };
        const other = makeArc({ title: 'Other route', beats: ['An unrelated current beat.'] });
        setArcs([arc, other]);
        setFakeApi(() => JSON.stringify({ results: [
            { item: 'i1', verdict: 'beat_planted', source: 'm2', excerpt: 'The second seal is broken', reason: 'Old evidence.' },
            { item: 'i2', verdict: 'no_evidence', source: '', excerpt: '', reason: '' },
        ] }));
        await expect(checkProgress()).rejects.toThrow('invalid evidence');
    });

    test('a missing watermark identity resumes at its durable position instead of reopening history', async () => {
        const arc = getArcs()[0];
        getPlanData().progressWatermarks = {
            [`beat:${arc.id}:${arc.beats[0].id}`]: { identity: 'id:deleted-watermark', index: 1 },
        };
        setFakeChat([
            { id: 'old', name: 'Mara', mes: 'Old history must not be resent.' },
            { id: 'replacement', name: 'Clerk', mes: 'The second seal is broken.' },
            { id: 'tail-user', is_user: true, mes: 'Continue.' },
            { id: 'tail-ai', mes: 'Unsettled.' },
        ]);
        setFakeApi(({ userContent }) => {
            expect(userContent).not.toContain('Old history must not be resent');
            expect(userContent).toContain('The second seal is broken');
            return JSON.stringify({ results: [{ item: 'i1', verdict: 'no_evidence', source: '', excerpt: '', reason: '' }] });
        });
        await checkProgress();
    });

    test('chat change closes and destroys the outgoing progress review modal', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const modal = createModal({
            id: 'mwt-sp-progress-modal',
            title: 'Check progress — Review',
            content: '<button>Ignore</button>',
            destroyOnClose: true,
        });
        showModal(modal.id);
        expect(host.inert).toBe(true);

        onChatChangedWhilePaused();

        expect(document.getElementById('mwt-sp-progress-modal')).toBeNull();
        expect(host.inert).toBeFalsy();
    });
});