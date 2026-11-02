/** Read-only recovery selection and advisory checks; neither function writes. */
import { DOSSIER_FIELDS, DOSSIER_MARKER, isDossierEntry, isHeaderLine } from './lorebook.js';
import { parseLedger } from './ledger_cleanup.js';
import { getRegistry, isSameNpcByName } from './registry.js';
import { normalizedEntryBody, stripRelationshipBlock } from './relationships.js';

const headerName = body => {
    const line = body.split('\n')[0].replace(DOSSIER_MARKER, '');
    return isHeaderLine(line) ? line.split('|')[0].trim() : null;
};

/**
 * History is newest-first. Match the editor's newline-normalized dirty rule.
 * Keys are per uid and outlive their entry, so a reused uid inherits a former
 * NPC's records: skip bodies headed with another name. Headerless bodies stay.
 */
export function previousManualVersion(history, content, name) {
    const current = normalizedEntryBody(content);
    const currentHeader = headerName(current);
    const names = Object.keys(getRegistry());
    const record = history.find(item => {
        const body = normalizedEntryBody(item.content);
        if (body === current) return false;
        const header = headerName(body);
        return !header || header === currentHeader || isSameNpcByName(header, name, names);
    });
    return record ? { body: stripRelationshipBlock(record.content), ts: record.ts } : null;
}

/** Advisory only: callers must never use these warnings to veto a save. */
export function lintManualBody(body, baseline = '') {
    const text = String(body ?? '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const warnings = [];
    if (!isHeaderLine(lines[0])) warnings.push('The first line should be a Name | Species | descriptor header.');
    if (lines.some(line => /^knowledge ledger:/i.test(line.trim()))) {
        const ledger = parseLedger(text);
        if (ledger.suspectLines?.length) {
            warnings.push('The ledger is interrupted by a non-item line; later - items are excluded from ledger handling.');
        } else if (!ledger.ok || ledger.empty) {
            warnings.push('The Knowledge Ledger is empty or cannot be parsed.');
        }
    }
    // Dossier fields are optional individually; warn when all labeled fields are gone.
    const hasFields = DOSSIER_FIELDS.some(field => lines.some(line =>
        new RegExp(`^${field.label}:`, 'i').test(line)));
    if (text.includes(DOSSIER_MARKER) && !hasFields) {
        warnings.push('The dossier marker is present, but labeled dossier fields are missing.');
    }
    if (hasFields && !isDossierEntry(text)) {
        warnings.push('Dossier fields are present, but [Dossier] is not at the very start; dossier merging will not be selected.');
    }
    if (text.length - String(baseline).replace(/\r\n?/g, '\n').length >= 50000) {
        warnings.push('This draft is at least 50,000 characters larger than the loaded entry. Check for an accidental paste.');
    }
    return warnings;
}