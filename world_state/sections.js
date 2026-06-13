/**
 * world_state/sections.js — Per-section regeneration logic.
 *
 * Depends on data.js, settings.js, injection.js, refresh.js (for buildSystemPrompt).
 */

import {
    resolveApiCall, normaliseOutput, escapeRegex,
} from '../core/index.js';

import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import {
    state, SECTIONS, VARIETY_LABELS, NEXT_SECTION_LOOKAHEAD,
    getWorldStateText, setWorldStateData,
    pushToHistory,
} from './data.js';
import { applyWorldStateInjection } from './injection.js';
import { getRecentMessagesForScan } from './refresh.js';

// ─── Section extraction / replacement ────────────────────────────────────────

/**
 * Pull out exactly one "## Section\n...body..." block from a larger text.
 * Stops at the next "## " header or end of text.
 */
export function extractOnlySection(text, sectionName) {
    const escaped = escapeRegex(sectionName);
    const pattern = new RegExp(`(## ${escaped}\\b[\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`);
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}

/**
 * Replace one "## Section" block in the document with newContent.
 * If the section doesn't already exist, append it.
 */
export function replaceSection(text, sectionName, newContent) {
    const escaped = escapeRegex(sectionName);
    const pattern = new RegExp(`## ${escaped}\\b[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const trimmed = newContent.trim();
    if (pattern.test(text)) {
        return text.replace(pattern, () => trimmed);
    }
    return (text.trim() + '\n\n' + trimmed).trim();
}

// ─── Section prompt builders ─────────────────────────────────────────────────

function buildSystemPrompt() {
    const custom = getSettings().customPrompt?.trim();
    return custom || DEFAULT_SYSTEM_PROMPT;
}

function buildSectionSystemPrompt(sectionName, variety) {
    const baseSystem = buildSystemPrompt();

    let extra = '';
    if (sectionName === 'Plot Seeds') {
        if (variety >= 4) {
            extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Lean toward bold, unexpected, or destabilizing seeds. Avoid the safest interpretation.
- At least one seed should introduce a disruption, twist, or escalation that hasn't been telegraphed yet.
- Diversify categories: try to hit at least 4 different ones from [contact, entrance, social, institutional, opportunity, pressure, threat].
- Consider tangential connections — characters, threads, or pressures that haven't been combined before.
- Still: every seed must be a NEW EVENT, not a restatement of established facts.`;
        } else if (variety === 3) {
            extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Cover more categories than usual: aim for at least 3 different ones from [contact, entrance, social, institutional, opportunity, pressure, threat].
- Mix safer and bolder seeds.
- Consider less obvious escalations of existing pressures.`;
        }
    } else if (variety >= 4) {
        extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Prefer bolder, more vivid, less default interpretations where the section allows it.`;
    }

    const override = `

---

OVERRIDE FOR THIS GENERATION:
- Output ONLY the "## ${sectionName}" section. No other sections.
- Your output MUST begin with the exact header "## ${sectionName}" — nothing before it.
- Use the formatting and rules defined above for that section.
- The rest of the existing world state is provided as context (do NOT include it in your output).${extra}`;

    return baseSystem + override;
}

function buildSectionUserMessage(sectionName) {
    const fullState = getWorldStateText().trim() || 'None yet.';
    const recent = getRecentMessagesForScan() || 'No recent messages.';
    return [
        '### Full Current World State (for context only — do not include in output)',
        fullState,
        '',
        '### Recent Chat Messages',
        recent,
        '',
        '='.repeat(60),
        `Output ONLY the regenerated "## ${sectionName}" section now.`,
        `Begin with the header "## ${sectionName}" — nothing before it.`,
    ].join('\n');
}

function validateSectionOutput(text, sectionName) {
    if (!text) return { ok: false, reason: 'empty response' };

    const escaped = escapeRegex(sectionName);
    const headerPattern = new RegExp(`^##\\s*${escaped}\\b`, 'm');
    if (!headerPattern.test(text)) {
        const preview = text.slice(0, 100).replace(/\n/g, ' ');
        return { ok: false, reason: `missing "## ${sectionName}" header. First 100 chars: "${preview}"` };
    }

    const rpMarkers = [
        { pattern: /\b(you see|you notice|before you|you feel)\b/i, label: 'second-person narration' },
    ];
    for (const { pattern, label } of rpMarkers) {
        if (pattern.test(text)) return { ok: false, reason: `RP marker detected: ${label}` };
    }

    return { ok: true };
}

// ─── Section regeneration ────────────────────────────────────────────────────

export async function regenerateSection(sectionName, variety = 2) {
    if (!hasValidSettings()) {
        throw new Error('No API connection configured. Open ⚙ Settings in the World State panel.');
    }
    if (!SECTIONS.includes(sectionName)) {
        throw new Error(`Unknown section: ${sectionName}`);
    }
    if (state.wstIsRefreshing) {
        throw new Error('World State is already refreshing.');
    }

    state.wstIsRefreshing = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        const s = getSettings();
        const baseTemp = isNaN(Number(s.temperature)) ? 0.3 : Number(s.temperature);
        const tempBoost = { 1: 0, 2: 0.05, 3: 0.3, 4: 0.55, 5: 0.85 }[variety] || 0;
        const temperature = Math.min(1.4, baseTemp + tempBoost);

        const sectionSettings = { ...s, temperature };

        const _wsApi3 = resolveApiCall({ moduleSettings: sectionSettings });
        const raw = await _wsApi3.fetchFn({
            systemPrompt: buildSectionSystemPrompt(sectionName, variety),
            userContent: buildSectionUserMessage(sectionName),
            settings: _wsApi3.settings,
            retries: 1,
        });

        const text = normaliseOutput(raw);
        const check = validateSectionOutput(text, sectionName);
        if (!check.ok) {
            throw new Error(`Section regen validation failed: ${check.reason}`);
        }

        const cleaned = extractOnlySection(text, sectionName) || text.trim();

        const currentText = getWorldStateText();
        const updated = replaceSection(currentText, sectionName, cleaned);

        if (currentText?.trim()) pushToHistory(currentText);
        setWorldStateData({ text: updated });
        applyWorldStateInjection();

        console.log(`[MWT:WorldState] Section "${sectionName}" regenerated (variety ${variety}).`);
        return updated;
    } finally {
        state.wstIsRefreshing = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}