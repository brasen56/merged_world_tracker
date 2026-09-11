/** @vitest-environment jsdom */

// Regression coverage for the Accessibility Slice 3:
//
//   A11Y-S3-01 — backup preview Confirm left aria-busy="true" forever on
//                failure paths (busy must clear in `finally`; eligibility is
//                applied separately from busy).
//   A11Y-S3-02 — Chronicle consolidation button stayed disabled+busy after an
//                API failure (the click handler never awaited the callback).
//   A11Y-S3-03 — the per-handler busy-state sweep was incomplete (paused-store
//                recovery export, Chronicle Snapshot/Regenerate, Interiority
//                Generate Now, Knowledge accept/batch/clipboard/relationship
//                handlers).
//   A11Y-S3-04 — the sweep's re-audit: the Scan
//                replacement button, Promote/Demote, state-tracker
//                register/export/import, both #kt-view-modal open paths, and
//                the Growth modal open; plus the catch-up eligibility restore
//                (busy clear must not enable ineligible actions). The sibling
//                live-region findings live in
//                test/custom_status_live_regions.test.js.
//
// Two halves, both following established precedents:
//
//   Behavioral — the real showConsolidationPreview() against jsdom (the
//     S3-02 headline bug; chronicle/render.js imports fine under the
//     barrel→stub alias, see test/tier5_regression_net.test.js). The
//     production failure shape is exercised: the callback settles WITHOUT
//     re-rendering (the real onConfirm catches its own API errors and only
//     sets status). A rejecting callback is pinned structurally below —
//     clicking one here would just trade the finally-clear for a Vitest
//     unhandled-rejection error, since jsdom drops listener promises.
//   Source contracts — `?raw` imports pin the busy wiring of handlers that
//     cannot run under Vitest (index.js listeners, backup restore flow,
//     lorebook-write handlers) — the same read-the-source approach as
//     test/focus_status_motion.test.js and test/main_tabbar_adoption.test.js.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { state, saveSettings } from '../chronicle/data.js';
import { showConsolidationPreview } from '../chronicle/render.js';

// Source texts (never executed — see the header note).
import backupRenderSource from '../backup/render.js?raw';
import chronicleRenderSource from '../chronicle/render.js?raw';
import interiorityRenderSource from '../interiority/render.js?raw';
import knowledgeRenderSource from '../knowledge/render.js?raw';
import indexSource from '../index.js?raw';

// ─── A11Y-S3-02: Chronicle consolidation button (behavioral) ─────────────────

describe('A11Y-S3-02: Consolidate button owns its busy state', () => {
    beforeEach(() => {
        resetCoreStubs();
        document.body.innerHTML = '';
        // getContentEl() serves state.contentEl when set — the cheapest way to
        // point the real renderer at a host without building the whole tab.
        state.contentEl = null;
        state.modal = null;
        state.isGenerating = false;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        state.contentEl = null;
        state.isGenerating = false;
        saveSettings({ apiUrl: '', modelName: '' });
        vi.restoreAllMocks();
    });

    function renderPreview(onConfirm) {
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const host = document.createElement('div');
        document.body.append(host);
        state.contentEl = host;
        showConsolidationPreview(
            [{ id: 's1', text: 'base entry', createdAt: '2026-01-01T00:00:00.000Z', worldDate: 'Day 1' }],
            'base entry',
            onConfirm,
        );
        return { host, btn: host.querySelector('#sc-consolidate-go') };
    }

    test('shows disabled + aria-busy while consolidating and clears BOTH when the run fails without re-rendering', async () => {
        // The real onConfirm catches its own API errors, sets status, and
        // returns WITHOUT re-rendering — the exact path S3-02 describes: the
        // button must stop being busy AND become operable again for a retry.
        const onConfirm = vi.fn(async () => { /* API failed; status set; no re-render */ });
        const { btn } = renderPreview(onConfirm);

        expect(btn).toBeTruthy();
        expect(btn.disabled).toBe(false); // hasValidSettings() → rendered enabled

        btn.click();
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('aria-busy')).toBe('true');

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(btn.disabled).toBe(false);
        expect(btn.getAttribute('aria-busy')).toBe('false');
    });

    test('the success path re-renders away the button without touching the replaced control', async () => {
        const seen = [];
        const { host, btn } = renderPreview(async (content) => {
            seen.push(content);
            // Success calls renderContent(), which replaces the preview — the
            // isConnected guard must keep the handler from clearing (or
            // crashing on) the detached control.
            host.innerHTML = '<div class="sc-editor">re-rendered</div>';
        });

        btn.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(seen).toEqual(['base entry']);
        expect(host.querySelector('#sc-consolidate-go')).toBeNull();
    });

    test('a rejecting callback is structurally covered: the clear sits in a finally around the awaited call', () => {
        // jsdom drops listener promises, so a rejecting click would only add a
        // Vitest unhandled-rejection error — pin the try/finally shape instead:
        // the finally is guaranteed to run (and clear busy) BEFORE any
        // rejection propagates out of the handler.
        expect(chronicleRenderSource).toMatch(
            /const consolidateBtn = el\.querySelector\('#sc-consolidate-go'\);[\s\S]{0,300}?setControlBusy\(consolidateBtn, true\);\s*\n\s*try\s*\{\s*\n\s*await onConfirm\([\s\S]{0,200}?\}\s*finally\s*\{\s*\n\s*if \(consolidateBtn\.isConnected\) setControlBusy\(consolidateBtn, false\);/,
        );
    });
});

// ─── A11Y-S3-01: Backup preview Confirm (source contract) ────────────────────
// backup/render.js's restore flow can't run under Vitest (see
// test/backup_ui.test.js's header), so the busy lifecycle is pinned as a
// source contract — the same approach focus_status_motion.test.js takes for
// handler wiring that only a browser can execute.

describe('A11Y-S3-01: refreshSummary() busy contract (source)', () => {
    test('clears the busy pair in a finally on every exit, re-applying disabled only when not confirmable', () => {
        // The restructure: busy is set once, cleared once in `finally`, and
        // eligibility is computed from a confirmable flag — including on the
        // thrown-error and invalid-preview early returns inside the try.
        expect(backupRenderSource).toContain('let confirmable = false;');
        expect(backupRenderSource).toMatch(
            /finally\s*\{\s*[\s\S]{0,400}?setControlBusy\(confirmBtn, false\);\s*[\s\S]{0,120}?confirmBtn\.disabled = !confirmable;/,
        );
        // The success tail no longer clears busy itself — only the finally does.
        expect(backupRenderSource).not.toMatch(/'info'\);\s*\n\s*confirmable = true;\s*\n\s*setControlBusy\(confirmBtn, false\);/);
    });

    test('the exact-blocked re-preview is a loop pass, not an unguarded recursive return', () => {
        // A `return refreshSummary()` inside the try would run this frame's
        // finally over the recursive call's freshly-set busy state.
        expect(backupRenderSource).not.toContain('return refreshSummary()');
        expect(backupRenderSource).toMatch(
            /Re-preview in merge mode so the table matches the unchecked state\.\s*\n\s*continue;/,
        );
    });
});

// ─── A11Y-S3-03: the per-handler sweep (source contracts) ────────────────────

describe('A11Y-S3-03: remaining async handlers own their busy state (source)', () => {
    test('Chronicle Snapshot and Regenerate buttons await their generation and clear in finally', () => {
        expect(chronicleRenderSource).toMatch(
            /const generateBtn = el\.querySelector\('#sc-generate-btn'\);[\s\S]{0,400}?setControlBusy\(generateBtn, true\);[\s\S]{0,200}?await generateSnapshot\(\);[\s\S]{0,200}?if \(generateBtn\.isConnected\) setControlBusy\(generateBtn, false\);/,
        );
        expect(chronicleRenderSource).toMatch(
            /const regenerateBtn = el\.querySelector\('#sc-regenerate-btn'\);[\s\S]{0,500}?setControlBusy\(regenerateBtn, true\);[\s\S]{0,200}?await regenerateSnapshot\(snapshot\.id\);[\s\S]{0,200}?if \(regenerateBtn\.isConnected\) setControlBusy\(regenerateBtn, false\);/,
        );
    });

    test('Interiority Generate Now awaits the generation promise published on the event detail', () => {
        expect(interiorityRenderSource).toMatch(
            /const generateBtn = el\.querySelector\('#mwt-int-generate'\);[\s\S]{0,400}?setControlBusy\(generateBtn, true\);[\s\S]{0,400}?await detail\.promise;[\s\S]{0,300}?if \(generateBtn\.isConnected\) setControlBusy\(generateBtn, false\);/,
        );
        // …and index.js publishes that promise so the wait tracks the real
        // work, not a fire-and-forget dispatch.
        expect(indexSource).toMatch(
            /'mwt:interiority-generate', \(e\) =>[\s\S]{0,600}?const pending = Interiority\.triggerGenerate\?\.\(\);[\s\S]{0,120}?e\.detail\.promise = pending \?\? null;/,
        );
    });

    test('paused-store recovery export owns its busy pair across the awaited export', () => {
        expect(indexSource).toMatch(
            /'\[data-mwt-pause-export\]'[\s\S]{0,1000}?setControlBusy\(btn, true\);[\s\S]{0,200}?await exportRecoveryData\(\)[\s\S]{0,300}?finally\s*\{[\s\S]{0,200}?setControlBusy\(btn, false\);/,
        );
    });

    test('Knowledge Accept & Write and Accept All wrap the lorebook writes (busy set only after validation/confirm)', () => {
        expect(knowledgeRenderSource).toMatch(
            /const acceptBtn = el\.querySelector\('#kt-accept'\);[\s\S]*?setControlBusy\(acceptBtn, true\);[\s\S]{0,400}?await handleAccept\(item, text, keywords, el\);[\s\S]{0,300}?if \(acceptBtn\.isConnected\) setControlBusy\(acceptBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /const batchAcceptBtn = el\.querySelector\('#kt-batch-accept'\);[\s\S]{0,300}?confirm\(`Accept all \$\{state\.stagingItems\.length\} proposals\?`\)\) return;[\s\S]{0,200}?setControlBusy\(batchAcceptBtn, true\);[\s\S]{0,2500}?if \(batchAcceptBtn\.isConnected\) setControlBusy\(batchAcceptBtn, false\);/,
        );
    });

    test('Knowledge clipboard buttons (profile, evidence, psychoanalyze portrait) own their busy pair', () => {
        expect(knowledgeRenderSource).toMatch(
            /const copyProfileBtn = modal\.querySelector\('#kt-growth-copy'\);[\s\S]{0,300}?setControlBusy\(copyProfileBtn, true\);[\s\S]{0,300}?await navigator\.clipboard\.writeText\(text\);[\s\S]{0,400}?setControlBusy\(copyProfileBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /const copyEvidenceBtn = modal\.querySelector\('#kt-growth-copy-evidence'\);[\s\S]{0,400}?setControlBusy\(copyEvidenceBtn, true\);[\s\S]{0,300}?await navigator\.clipboard\.writeText\(`Evidence for[\s\S]{0,400}?setControlBusy\(copyEvidenceBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /const copyBtn = contentDiv\.querySelector\('#kt-growth-copy-psychoanalyze'\);[\s\S]{0,300}?setControlBusy\(copyBtn, true\);[\s\S]{0,300}?await navigator\.clipboard\.writeText\(text\);[\s\S]{0,400}?setControlBusy\(copyBtn, false\);/,
        );
    });

    test('Knowledge relationship add/set/clear/remove wrap the awaited lorebook sync', () => {
        expect(knowledgeRenderSource).toMatch(
            /const relAddBtn = el\.querySelector\('#kt-rel-add'\);[\s\S]*?setControlBusy\(relAddBtn, true\);[\s\S]{0,1500}?await syncRelationshipsToLorebook\(from\);[\s\S]{0,900}?if \(relAddBtn\.isConnected\) setControlBusy\(relAddBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /const stanceSetBtn = el\.querySelector\('#kt-stance-set'\);[\s\S]*?setControlBusy\(stanceSetBtn, true\);[\s\S]{0,900}?await syncRelationshipsToLorebook\(name\);[\s\S]{0,600}?if \(stanceSetBtn\.isConnected\) setControlBusy\(stanceSetBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /querySelectorAll\('\.kt-stance-clear'\)[\s\S]{0,500}?setControlBusy\(btn, true\);[\s\S]{0,600}?await syncRelationshipsToLorebook\(name\);[\s\S]{0,400}?if \(btn\.isConnected\) setControlBusy\(btn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /querySelectorAll\('\.kt-rel-remove'\)[\s\S]{0,500}?confirm\(`Remove relationship:[\s\S]{0,400}?setControlBusy\(btn, true\);[\s\S]{0,800}?await syncRelationshipsToLorebook\(from\);[\s\S]{0,400}?if \(btn\.isConnected\) setControlBusy\(btn, false\);/,
        );
    });
});

// ─── A11Y-S3-04: the remaining Knowledge sweep + eligibility restore ─────────
// The P2 follow-ups from re-audit of Slice 3: the
// sweep still missed Knowledge's Scan replacement button, Promote/Demote, the
// state-tracker register/export/import controls, both #kt-view-modal open
// paths, and the Growth modal's opening reads; and the catch-up loop cleared
// busy into enabled states the evidence rules forbid. All are pinned as
// source contracts here — the handlers bind host-only lorebook reads that a
// Vitest run cannot execute (the kt_view_modal_singleton.test.js suite covers
// the behavioral singleton half of the two view paths).

describe('A11Y-S3-04: the remaining Knowledge async controls own their busy state', () => {
    test('the replacement Scan button renders disabled + aria-busy while state.isRunning', () => {
        expect(knowledgeRenderSource).toMatch(
            /id="kt-scan-btn"[^>]*\$\{!hasValidSettings\(\) \|\| state\.isRunning \? 'disabled' : ''\} \$\{state\.isRunning \? 'aria-busy="true"' : ''\}/,
        );
    });

    test('Promote and Demote own their busy pair across the label-verified lorebook read', () => {
        expect(knowledgeRenderSource).toMatch(
            /querySelectorAll\('\.kt-npc-promote'\)[\s\S]{0,500}?setControlBusy\(btn, true\);[\s\S]{0,400}?await loadEntryContent\(reg\.uid, name\);[\s\S]{0,1200}?if \(btn\.isConnected\) setControlBusy\(btn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /querySelectorAll\('\.kt-npc-demote'\)[\s\S]{0,500}?setControlBusy\(btn, true\);[\s\S]{0,400}?await loadEntryContent\(reg\.uid, name\);[\s\S]{0,1200}?if \(btn\.isConnected\) setControlBusy\(btn, false\);/,
        );
    });

    test('state-tracker register/export/import own their busy pairs across the awaited reads', () => {
        expect(knowledgeRenderSource).toMatch(
            /const registerBtn = el\.querySelector\('#kt-state-register'\);[\s\S]{0,700}?setControlBusy\(registerBtn, true\);[\s\S]{0,300}?await loadStateTrackerEntry\(uid\);[\s\S]{0,600}?if \(registerBtn\.isConnected\) setControlBusy\(registerBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /const exportBtn = el\.querySelector\('#kt-state-export'\);[\s\S]{0,400}?setControlBusy\(exportBtn, true\);[\s\S]{0,600}?await loadStateTrackerEntry\(info\.uid\);[\s\S]{0,600}?if \(exportBtn\.isConnected\) setControlBusy\(exportBtn, false\);/,
        );
        expect(knowledgeRenderSource).toMatch(
            /const importBtn = el\.querySelector\('#kt-state-import'\);[\s\S]{0,300}?setControlBusy\(importBtn, true\);[\s\S]{0,300}?await pickTextFile\('\.json'\);[\s\S]{0,900}?if \(importBtn\.isConnected\) setControlBusy\(importBtn, false\);/,
        );
    });

    test('the two #kt-view-modal open paths and the Growth modal open own their busy pairs', () => {
        // NPC dossier path: the button is passed through so the shared open
        // helper can own its busy pair across the awaited read.
        expect(knowledgeRenderSource).toMatch(/openNpcViewModal\(btn\.dataset\.name, btn\)/);
        expect(knowledgeRenderSource).toMatch(
            /async function openNpcViewModal\(name, triggerBtn = null\) \{[\s\S]{0,500}?if \(triggerBtn\) setControlBusy\(triggerBtn, true\);[\s\S]{0,600}?await loadEntryContent\(reg\.uid, name\);[\s\S]{0,500}?if \(triggerBtn\?\.isConnected\) setControlBusy\(triggerBtn, false\);/,
        );
        // State Tracker path: guards first, then the busy pair.
        expect(knowledgeRenderSource).toMatch(
            /querySelectorAll\('\.kt-state-view'\)[\s\S]{0,700}?setControlBusy\(btn, true\);[\s\S]{0,500}?await loadStateTrackerEntry\(info\.uid\);[\s\S]{0,400}?if \(btn\.isConnected\) setControlBusy\(btn, false\);/,
        );
        // Growth modal open: the trigger spans the module/profile reads.
        expect(knowledgeRenderSource).toMatch(
            /growthModalOpening = true;[\s\S]{0,400}?if \(triggerBtn\) setControlBusy\(triggerBtn, true\);[\s\S]{0,6000}?if \(triggerBtn\?\.isConnected\) setControlBusy\(triggerBtn, false\);/,
        );
    });

    test('a failed catch-up restores prior eligibility instead of enabling ineligible actions', () => {
        // Eligibility is snapshotted BEFORE the buttons are marked busy…
        expect(knowledgeRenderSource).toMatch(
            /const priorDisabled = new Map\(\[btn, captureBtn, regenerateBtn, consolidateBtn, backfillBtn\]\s*\.map\(b => \[b, b\?\.disabled \?\? false\]\)\);/,
        );
        // …and re-applied when busy clears, so Generate (needs ≥1 observation)
        // and Consolidate (needs ≥2 non-canon raw) cannot come back enabled
        // from a failed run that never re-rendered the modal.
        expect(knowledgeRenderSource).toMatch(
            /\[captureBtn, regenerateBtn, consolidateBtn, backfillBtn\]\.forEach\(b => \{\s*setControlBusy\(b, false\);\s*if \(b && priorDisabled\.get\(b\)\) b\.disabled = true;\s*\}\);/,
        );
    });
});
