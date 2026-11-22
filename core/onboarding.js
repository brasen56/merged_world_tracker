/** First-run detection and the shared, re-entrant preset picker. Import directly. */
import { getContextSafe } from './context.js';
import { getGlobalSettings, saveGlobalSettings } from './settings.js';
import { PRESETS, applyPreset } from './presets.js';
import { createModal, showModal, hideModal, setStatus } from './modal.js';
import { notify } from './notifications.js';

export const CURRENT_ONBOARDING_VERSION = 1;
const MODAL_ID = 'mwt-onboarding';
const STORE_KEYS = Object.keys(PRESETS.standard);
// Also guard before/if migration runs: malformed or unread legacy records
// still indicate an existing install, not permission to reset its defaults.
const LEGACY_KEYS = ['world_state_settings', 'session_chronicle_settings', 'knowledge_tracker_settings'];
const GUIDE_URL = 'https://github.com/brasen56/merged_world_tracker/blob/main/SETUP_GUIDE.md';

/** Call after module initialization. Reads persisted records, not merged defaults. */
export function shouldShowOnboarding() {
    if ((getGlobalSettings().onboardingVersion ?? 0) >= CURRENT_ONBOARDING_VERSION) return false;
    try {
        const stores = getContextSafe()?.extensionSettings;
        if (!stores) return false;
        if (STORE_KEYS.some(key => stores[key] != null && Object.keys(stores[key]).length > 0)) return false;
        return [...STORE_KEYS, ...LEGACY_KEYS].every(key => localStorage.getItem(key) === null);
    } catch {
        // An inaccessible persistence layer cannot establish a fresh install.
        return false;
    }
}

const CARDS = [
    ['lite', 'Lite', 'I want to try MWT with the lightest touch',
        'World State + Chronicle, plus Ledger · Minimal detail · Nothing automatic', 'Lowest — occasional manual calls'],
    ['standard', 'Standard', 'Everything available, but I press the buttons',
        'All five preset modules, plus Ledger · Standard detail · Nothing automatic', 'On-demand only'],
    ['full', 'Full', 'Keep the bookkeeping running in the background',
        'All five preset modules, plus Ledger · Detailed World State · Scheduled bookkeeping and Interiority thoughts', 'Background calls'],
];

/** Opens on demand regardless of the fresh-install gate. Never generates. */
export function openOnboarding({ beforeApply = () => true, onApplied = () => {}, quiet = false } = {}) {
    const existing = document.getElementById(MODAL_ID);
    if (existing) return existing; // Do not replace an active picker/its close callback.
    let acknowledged = false;
    let presetApplied = false;
    const modal = createModal({
        id: MODAL_ID,
        title: 'Welcome to MWT — pick a starting point',
        cssClass: 'mwt-onboarding',
        destroyOnClose: true,
        onClose: () => {
            if (acknowledged) return;
            if (!saveGlobalSettings({ onboardingVersion: CURRENT_ONBOARDING_VERSION })) {
                setStatus(modal, 'Could not save setup acknowledgement. Please try again.', 'error');
                return false;
            }
            acknowledged = true;
            if (!presetApplied) notify('MWT setup', 'You can return to Settings → Modules → Run setup… at any time.', 'info');
        },
        content: `
            <div class="mwt-onboarding-cards">
                ${CARDS.map(([key, name, audience, summary, load]) => `
                    <button type="button" class="mwt-btn mwt-onboarding-card" data-onboarding-preset="${key}">
                        <strong>${name}${key === 'standard' ? ' — Recommended' : ''}</strong>
                        <span>${audience}</span><span>${summary}</span>
                        <span class="mwt-text-dim">API usage: ${load}</span>
                    </button>`).join('')}
            </div>
            <p>Full schedules World State refresh (5 replies), Chronicle entries (40-message threshold), Knowledge scans (5 replies), NPC staging scans (10), growth capture (15), and relationship extraction (10). Story Planner stays manual at every level.</p>
            <p>You can change any of this later — every module is independent. These presets change global defaults only; explicit per-chat overrides still take precedence. Ledger is unchanged by presets (enabled and injecting by default). Ambient Conditions remains a separate opt-in. Applying a preset refreshes module panes and discards unsaved drafts in those panes.</p>
            <p>Chronicle entries reach the AI once you switch on 📥 Injection in the Chronicle tab — once per chat.</p>
            <p><a href="${GUIDE_URL}" target="_blank" rel="noopener noreferrer">Read the setup guide</a></p>
            <button type="button" class="mwt-btn mwt-onboarding-later" id="mwt-onboarding-later">Decide later</button>`,
    });
    modal.querySelector('#mwt-onboarding-later').addEventListener('click', () => hideModal(MODAL_ID));
    modal.querySelectorAll('[data-onboarding-preset]').forEach(button => {
        button.addEventListener('click', () => {
            const name = button.dataset.onboardingPreset;
            if (!beforeApply(name)) return;
            if (!applyPreset(name)) {
                setStatus(modal, 'Could not save every preset setting. Some settings may already have changed; choose a preset again to retry.', 'error');
                return;
            }
            presetApplied = true;
            hideModal(MODAL_ID);
            onApplied(name);
            if (acknowledged) notify('MWT setup', `${button.querySelector('strong').textContent.split(' — ')[0]} applied — see ⚙️ Settings to adjust`, 'success');
        });
    });
    if (!showModal(MODAL_ID, { quiet })) {
        // Host popup collision: leave the flag untouched so setup can be retried.
        modal._cleanupKeyHandler?.();
        modal.remove();
        return null;
    }
    return modal;
}

/** Startup entry point, kept separate so Settings re-entry never uses the gate. */
export function maybeShowOnboarding(options) {
    return shouldShowOnboarding() ? openOnboarding(options) : null;
}

/** Capture eligibility before other settings saves; defer UI until host readiness. */
export function registerOnboardingStartup({ eventSource, eventTypes, beforeApply, onApplied } = {}) {
    let pending = shouldShowOnboarding();
    let ready = false;
    const retry = () => {
        if (!ready || !pending) return null;
        if ((getGlobalSettings().onboardingVersion ?? 0) >= CURRENT_ONBOARDING_VERSION) {
            pending = false;
            return null;
        }
        const picker = openOnboarding({ beforeApply, onApplied, quiet: true });
        if (picker) pending = false;
        return picker;
    };
    if (pending && eventSource && eventTypes?.APP_READY) {
        eventSource.on(eventTypes.APP_READY, () => {
            ready = true;
            retry();
        });
    } else if (pending) {
        console.info('[MWT:Onboarding] Automatic setup skipped: eventSource or APP_READY is unavailable. Use Settings → Modules → Run setup… instead.');
    }
    return { retry };
}

/** Refresh only preset-owned panes, leaving the global Settings draft intact. */
export function refreshPresetPanes(root, tabs, renderPane) {
    if (!root) return;
    for (const tab of tabs) {
        if (!tab.module) continue;
        const pane = root.querySelector(`#mwt-tabpanel-${tab.id}`);
        if (!pane) continue;
        pane.innerHTML = renderPane(tab);
        tab.module.getModuleWireEvents?.()();
        tab.module.onPresetRefresh?.();
    }
}