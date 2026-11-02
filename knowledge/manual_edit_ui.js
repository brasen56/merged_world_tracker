/** NPC Edit-in-View presenter. Persistence and all write guards live in manual_edit.js. */
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { setStatus } from '../core/modal.js';
import { setControlBusy } from '../core/ui.js';
import { getLorebookName } from './scope.js';
import { loadForManualEdit, saveManualEdit, isManualEditDirty } from './manual_edit.js';

/** Wire an explicitly opted-in NPC modal before decorating its shared shell. */
export function wireManualEdit(modal, { name, uid, onSaved }) {
    const scope = captureScope();
    const book = getLorebookName();
    const header = modal.querySelector('.kt-history-header');
    const view = modal.querySelector('.kt-history-body > pre');
    const body = modal.querySelector('.kt-history-body');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'kt-view-edit menu_button';
    edit.textContent = 'Edit';
    header.insertBefore(edit, header.querySelector('.kt-history-close'));
    const editor = document.createElement('div');
    editor.className = 'kt-manual-editor';
    editor.hidden = true;
    // Only static markup goes through innerHTML. All stored text uses value/textContent.
    editor.innerHTML = `
        <label for="kt-manual-body">Entry body</label>
        <textarea id="kt-manual-body" spellcheck="false" aria-describedby="kt-manual-help"></textarea>
        <label for="kt-manual-keywords">Trigger keywords (comma-separated)</label>
        <input id="kt-manual-keywords" type="text" aria-describedby="kt-manual-help">
        <section class="kt-manual-relationships" aria-labelledby="kt-manual-relationships-title">
            <h4 id="kt-manual-relationships-title">Managed relationships (read-only)</h4>
            <p>Edit these in the Relationships sub-tab. The latest graph is attached when saving.</p>
            <pre></pre>
        </section>
        <p id="kt-manual-help">No model calls. Empty keywords fall back to the NPC name. Empty content cannot be saved.</p>
        <div class="kt-manual-actions">
            <button type="button" class="kt-manual-save menu_button">Save</button>
            <button type="button" class="kt-manual-revert menu_button">Revert</button>
            <button type="button" class="kt-manual-cancel menu_button">Cancel</button>
            <button type="button" class="kt-manual-reload menu_button" hidden>Reload current entry</button>
        </div>`;
    body.append(editor);
    const status = document.createElement('div');
    status.className = 'mwt-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    body.append(status);
    const text = editor.querySelector('textarea');
    const keywords = editor.querySelector('input');
    const save = editor.querySelector('.kt-manual-save');
    const revert = editor.querySelector('.kt-manual-revert');
    const cancel = editor.querySelector('.kt-manual-cancel');
    const reload = editor.querySelector('.kt-manual-reload');
    const close = header.querySelector('.kt-history-close');
    let session = null;
    let pending = false;

    const current = () => scopeStillCurrent(scope).ok && getLorebookName() === book;
    const alive = () => {
        if (!modal.isConnected) return false;
        if (current()) return true;
        modal._closeModal?.();
        return false;
    };
    const dirty = () => session && !editor.hidden && isManualEditDirty(session, text.value, keywords.value);
    const discard = () => !dirty() || window.confirm('Discard unsaved NPC edits?');
    function updateSave() {
        save.disabled = pending || !text.value.trim();
    }
    function busy(control, value) {
        pending = value;
        setControlBusy(control, value);
        [edit, revert, cancel, reload, close].forEach(button => { button.disabled = value; });
        text.readOnly = value;
        keywords.readOnly = value;
        updateSave();
    }
    function fill() {
        text.value = session.baselineBody;
        keywords.value = session.keys.join(', ');
        const block = session.content.match(/<!-- mwt:relationships:start -->[\s\S]*?<!-- mwt:relationships:end -->/);
        editor.querySelector('.kt-manual-relationships pre').textContent = block?.[0] || 'No managed relationships.';
        reload.hidden = true;
        updateSave();
    }
    function showView(content) {
        view.textContent = content;
        view.hidden = false;
        editor.hidden = true;
        edit.hidden = false;
        edit.focus();
    }
    async function load(control) {
        if (!alive() || pending) return;
        if (control === reload && !discard()) return;
        busy(control, true);
        setStatus(modal, 'Loading current entry…');
        try {
            const result = await loadForManualEdit({ name, uid });
            if (!alive()) return;
            if (!result.ok) {
                setStatus(modal, result.error || 'Cannot load this entry for editing.', 'error');
                return;
            }
            session = result.session;
            fill();
            view.hidden = true;
            editor.hidden = false;
            edit.hidden = true;
            setStatus(modal, 'Editing current entry. Changes are not saved yet.');
        } catch (err) {
            if (alive()) setStatus(modal, `Cannot load entry: ${err.message}`, 'error');
        } finally {
            if (modal.isConnected) {
                busy(control, false);
                if (!editor.hidden) text.focus();
                else edit.focus();
            }
        }
    }
    edit.addEventListener('click', () => void load(edit));
    reload.addEventListener('click', () => void load(reload));
    text.addEventListener('input', updateSave);
    revert.addEventListener('click', () => {
        if (!alive() || pending || !discard()) return;
        fill();
        setStatus(modal, 'Draft reverted to the loaded entry.');
        text.focus();
    });
    cancel.addEventListener('click', () => {
        if (!alive() || pending || !discard()) return;
        showView(session.content);
        setStatus(modal, 'Editing cancelled. Nothing written.');
    });
    save.addEventListener('click', async () => {
        if (!alive() || pending || !session || !text.value.trim()) return;
        busy(save, true);
        setStatus(modal, 'Saving entry…');
        try {
            const result = await saveManualEdit({ session, body: text.value, keywords: keywords.value });
            if (!alive()) return;
            if (!result.ok) {
                reload.hidden = result.code !== 'stale-source';
                setStatus(modal, result.error || 'Save failed. Your draft is retained.', 'error');
                return;
            }
            session = result.session;
            showView(result.content);
            const message = result.noOp ? 'No changes to save. Nothing written.'
                : `"${name}" saved to lorebook.${result.reconciled ? ' Verified on disk after a lost save response.' : ''}`;
            setStatus(modal, message, 'success');
            if (!result.noOp) onSaved(message);
        } catch (err) {
            if (alive()) setStatus(modal, `Save failed: ${err.message}. Your draft is retained.`, 'error');
        } finally {
            if (modal.isConnected) {
                busy(save, false);
                if (editor.hidden) edit.focus();
                else text.focus();
            }
        }
    });
    // Scope MUST be checked before pending/dirty: the chat-change sweep closes
    // even an in-flight save without a native confirmation or leaked key handler.
    return () => !current() || (!pending && discard());
}