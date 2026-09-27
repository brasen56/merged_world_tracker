/**
 * Drop Growth-owned fields from model-driven NPC dossier updates.
 * Personality belongs to the evidence file when one exists; canon_lock is
 * deliberately still writable outside the manual-only field picker.
 * @param {string} name canonical registry key
 * @param {object} fields model-supplied dossier fields
 * @returns {object} original fields or a copy with Personality nulled
 */
import { hasEvidenceFile } from './evidence.js';

export function applyFieldOwnership(name, fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fields;
    if (fields.personality == null) return fields;
    if (!hasEvidenceFile(name)) return fields;
    return { ...fields, personality: null };
}