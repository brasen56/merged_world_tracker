/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { acceptedRefreshFields, contractRejectionSummary, validateKnowledgeList } from '../knowledge/field_contract.js';

// Exercise the real UI handlers in isolation from the SillyTavern host.
const source = readFileSync(resolve(process.cwd(), 'knowledge/render.js'), 'utf8').replace(/\r\n/g, '\n');
function loadFunction(start, end, context) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error('Missing UI source boundary');
    vm.runInNewContext(source.slice(from, to), context);
}

const rejection = { field: 'role', reason: 'contains a line break' };

describe('Knowledge contract UI', () => {
    test.each([
        ['all rejected', ['role'], ['role'], false, []],
        ['mixed unchanged', ['role', 'agenda'], ['role'], false, ['agenda']],
        ['mixed changed', ['role', 'agenda'], ['role'], true, ['agenda']],
        ['legitimate unchanged', ['role'], [], false, ['role']],
    ])('%s refresh only verifies accepted fields', async (_label, requested, rejected, changed, verified) => {
        const modal = document.createElement('div');
        modal.innerHTML = `<button class="kt-dfr-run"></button><button class="kt-dfr-select-stale"></button><button class="kt-dfr-clear"></button>${requested.map(key => `<input class="kt-dfr-field" type="checkbox" data-key="${key}" checked>`).join('')}`;
        let handler;
        modal.querySelector('.kt-dfr-run').addEventListener = (_event, fn) => { handler = fn; };
        const rejections = rejected.map(field => ({ ...rejection, field }));
        const c = {
            acceptedRefreshFields, contractRejectionSummary,
            ktSetStatus: vi.fn(), recordDossierFieldRefresh: vi.fn(),
            setControlBusy: vi.fn(), addNotificationEntry: vi.fn(), renderNpcsSubTab: vi.fn(),
            isCancellation: () => false, console,
            state: { stagingItems: [] },
            runDossierFieldRefresh: async () => ({
                currentContent: 'old', merged: changed ? 'new' : 'old',
                requestedFields: requested, skippedFields: [], fields: { role: null, agenda: 'new' },
                contractRejections: rejections,
            }),
        };
        loadFunction('function setContractStatus(', '// ─── Accept / reject', c);
        loadFunction('function wireDossierFieldRefreshModal(', '// ─── Relationship sub-tab', c);
        const cleanup = vi.fn();
        c.wireDossierFieldRefreshModal(modal, 'Mara', { uid: 7 }, [], cleanup);
        await handler();
        if (changed) {
            expect(c.state.stagingItems[0].refreshFields).toEqual(verified);
            expect(c.state.stagingItems[0].contractRejections).toEqual(rejections);
            expect(c.recordDossierFieldRefresh).not.toHaveBeenCalled();
        } else if (verified.length) {
            expect(c.recordDossierFieldRefresh).toHaveBeenCalledWith('Mara', verified);
        } else {
            expect(c.recordDossierFieldRefresh).not.toHaveBeenCalled();
            expect(c.ktSetStatus.mock.calls[0][0]).toContain('no fields marked re-verified');
        }
        expect(c.ktSetStatus.mock.calls[0][1]).toBe(rejected.length ? 'warning' : 'info');
        if (rejected.length) expect(c.ktSetStatus.mock.calls[0][0]).toContain('role (contains a line break)');
        expect(cleanup).toHaveBeenCalled();
    });

    test('staged rejection reasons remain visible and HTML-escaped', () => {
        const c = { escapeHtml: text => String(text).replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
        loadFunction('function renderDetailForItem(', 'function wireStagingEvents(', c);
        const html = c.renderDetailForItem({ name: 'Mara', proposedContent: 'safe', contractRejections: [{ field: '<role>', reason: '<script>bad</script>' }] });
        expect(html).toContain('Rejected model values');
        expect(html).toContain('&lt;role&gt;');
        expect(html).not.toContain('<script>');
    });

    test.each(['fact', 'source', 'date'])('%s rejects each structural marker and edge line break', part => {
        for (const text of ['\nRole: injected', 'injected\r', 'Knowledge Ledger:', '<!-- mwt:relationships:start -->', '[Dossier] forged']) {
            const result = validateKnowledgeList([{ fact: 'safe', [part]: text }]);
            expect(result.items).toEqual([]);
            expect(result.rejected[0].reason).toContain(part);
        }
    });
});