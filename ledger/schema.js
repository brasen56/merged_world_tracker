/** Ledger descriptor, shared by runtime preparation, backup and Diagnostics. */
import {
    defineIssuePolicy, defineStoreSchema, emptyStats, fatalIssue,
    isObject, ISSUE_SEVERITIES, makeIssue,
} from '../core/schema.js';
import { createLedger, validateLedgerRecord, validateLedgerAudit } from './data.js';

/** Keep readable user data intact; invalid records must not drive arithmetic. */
export function validateLedgerData(data) {
    const stats = emptyStats();
    if (!isObject(data)) {
        return { data: {}, stats, issues: [fatalIssue('root-not-object', [], 'Ledger data must be an object.', data, 'ledger')] };
    }
    const validation = validateLedgerRecord(data);
    const issues = validation.errors.map(({ path, message }) => makeIssue({
        code: 'ledger-invalid', path, severity: ISSUE_SEVERITIES.REFERENCE,
        message: `Ledger kept but inactive until fixed: ${message}`, identity: 'ledger',
    }));
    issues.push(...validateLedgerAudit(data).errors.map(({ path, message }) => makeIssue({
        code: 'ledger-audit-invalid', path, severity: ISSUE_SEVERITIES.REFERENCE,
        message, identity: 'ledger',
    })));
    stats.added = 1;
    return { data: { ...data }, issues, stats };
}

/** Unstamped v1 records already have the v1 shape; never invent missing money. */
export function migrateLedgerV0ToV1(data) {
    return { data: isObject(data) ? { ...data } : data, issues: [] };
}

export function migrateLedgerV1ToV2(data) {
    return { data: isObject(data) ? { itemLog: [], proposals: [], ...data, version: 2 } : data, issues: [] };
}

export const ledgerSchema = defineStoreSchema({
    id: 'ledger',
    metadataKey: 'mwt_ledger',
    currentVersion: 2,
    createDefault: createLedger,
    migrations: { 0: migrateLedgerV0ToV1, 1: migrateLedgerV1ToV2 },
    validate: validateLedgerData,
    policy: defineIssuePolicy({ fatal: ['root-not-object'], reference: ['ledger-invalid', 'ledger-audit-invalid'] }),
});