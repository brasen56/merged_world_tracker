/**
 * Drop Growth-owned fields from model-driven NPC dossier updates.
 * An explicit switch owns both identity fields (on) or neither (off).
 * Never set keeps the legacy Personality-only evidence lock. canon_lock
 * remains writable outside the manual-only field picker.
 * @param {string} name canonical registry key
 * @param {object} fields model-supplied dossier fields
 * @returns {object} original fields or a copy with owned fields nulled
 */
import { hasEvidenceFile } from './evidence.js';
import { getRegistryEntry } from './registry.js';

/** Only an explicit setting replaces the legacy evidence-based partition. */
export function growthOwnsField(name, key) {
    if (key !== 'personality' && key !== 'voice') return false;
    const enabled = getRegistryEntry(name)?.info?.growthDossier?.enabled;
    if (typeof enabled === 'boolean') return enabled;
    return key === 'personality' && hasEvidenceFile(name);
}

export function applyFieldOwnership(name, fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fields;
    let result = fields;
    for (const key of ['personality', 'voice']) {
        if (fields[key] != null && growthOwnsField(name, key)) result = { ...result, [key]: null };
    }
    return result;
}