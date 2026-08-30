/**
 * diagnostics_panel/integrity.js — Tab 7: Integrity (Diagnostics Phase 12).
 *
 * "Do my stores reference things that exist?" (phases doc §II.4 Phase 12,
 * design §I.5 Tab 7): duplicate profile entries, dangling `profileUid`
 * pointers, evidence↔profile orphans in both directions, `validateSection()`
 * results per store, and Interiority ledger reference integrity — counts and
 * a top-N sample per check, with the "copy full JSON" escape hatch on the
 * pane. Read-only by contract (design §I.1): nothing here writes chat
 * metadata, lorebooks, localStorage, or settings, and no repair action is
 * offered in v1 — the mutating console tools (`MWT.profiles.pruneDuplicates`,
 * `MWT.profiles.relink`, `MWT.evidence.clearAll`, `MWT.interiority.clearDeletions`)
 * already exist with dry-run guards.
 *
 * ── Why this tab is ON DEMAND, unlike Tabs 1–6 ────────────────────────────────
 * The other checks are O(modules) or O(ring capacity). Every check here is
 * O(entries) across lorebooks and chat metadata (the design §I.6 scale note),
 * and one of them (`listProfileEntries`) is an ASYNC lorebook read. So the
 * pane renders an idle state and a ▶ Run button; the checks only run when the
 * button is clicked (decision D2 is untouched — one button press, one collect,
 * one render; never a render loop and never on open).
 *
 * ── Store enumeration ─────────────────────────────────────────────────────────
 * The per-store validation rows are enumerated from the SCHEMA REGISTRY
 * (`schema/registry.js`, design §9.2 of the schema validation plan — never a
 * second hand-maintained list; the registry ids equal the backup section
 * names and the `METADATA_KEYS` keys). `validateSectionWithIssues()` is the
 * backup validator's registry adapter reused as-is; this collector only feeds
 * it the live section data and summarises the result. The Knowledge lorebook
 * store is validated as its own row WHEN RELIABLY HYDRATED (§9.2): its data
 * lives inside the book's [MWT:store] entry, read through the read-only cache
 * peek; an un-hydrated book renders a dim not-checked row, never a finding.
 *
 * ── Reliability guard on an empty profile book ───────────────────────────────
 * `listProfileEntries()` returns [] both for a genuinely empty book and for a
 * book it could not read (world-info.js missing, load error — it warns and
 * returns []). Against an empty entry list every `profileUid` would look
 * dangling and every evidence file orphaned — a false-finding flood. Registry
 * `profileUid` pointers are the strong contradiction (they point at entries
 * that must exist): when the list comes back empty while any pointer is set,
 * the affected checks are skipped and flagged `unreliable` instead. Evidence
 * alone does NOT trigger the guard — an empty book over pointer-less evidence
 * is the ordinary young-chat state, so evidence-without-profile stays a
 * reliable reading there.
 *
 * ── Content discipline (the Phase 5 redaction contract) ──────────────────────
 * The snapshot carries NO chat prose by construction: no profile previews, no
 * evidence quotes, no quarantined records — only names, uids, counts, and the
 * backup validators' own reason strings (module-authored, e.g. "Arc id must be
 * a non-empty string."). NPC names are identity strings (the same class the
 * Scope tab shows) and are the substance of every finding, so they stay. Both
 * surfaces still route through core/redaction.js — `redactIntegritySnapshot()`
 * is `redactForReport()` with the LIVE content flag, so every string is
 * Rule-1b secret-scrubbed and any field named like a content/error field would
 * still gate. There is nothing for the content opt-in to reveal on this tab
 * (the Last request tab's telemetry-by-construction situation).
 *
 * DOM-free by design (the Phase 6 health.js pattern): the snapshot is a plain
 * object, the markup lives in diagnostics_panel/render.js, every dependency is
 * injectable, and every accessor call is individually guarded — a throwing
 * dependency degrades its own check plus an `errors` note, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real helpers + version regardless (the barrel→stub alias trap,
 * §II.3). knowledge/* and interiority/* are imported exactly the way index.js's
 * console tools reach them, so the tab and the console view one live graph.
 */

import { MWT_VERSION } from '../core/version.js';
import { getChatMeta } from '../core/context.js';
import { redactForReport } from '../core/redaction.js';
// Live secret VALUES for the scrub list. report.js is a sibling collector
// that (since Phase 13) imports this module for the report's Integrity
// section, so there IS a module cycle — safe because both sides only
// reference the other's bindings inside function bodies (hoisted function
// declarations), never at module-init time. The guarded
// collectKnownSecrets() returns [] with no SillyTavern runtime, keeping this
// unit-testable in Node (the last_request.js / log.js precedent).
import { collectKnownSecrets } from './report.js';

// Store enumeration — THE schema registry (schema plan Part 5, design §9.2:
// "Enumerate schemas from schema/registry.js, not a second list"). The
// registry ids intentionally equal the backup section names AND the
// METADATA_KEYS keys, so deriving here changes no behaviour today while
// making the registry the single owner of the list. The Knowledge lorebook
// store is validated as its own row below (it is not a chat-metadata
// section). Labels are presentation-only decoration carried WITH the derived
// entries so renderers never need their own mapping.
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from '../schema/registry.js';
import { validateSectionWithIssues } from '../backup/validate.js';
import { resolveKnowledgeBooks } from './schema_status.js';
import { peekStore, peekStoreData } from '../knowledge/store.js';

import { listProfileEntries } from '../knowledge/lorebook.js';
import { getRegistry, resolveRegistryKey, normalizeRegistryName } from '../knowledge/registry.js';
import { getLedger, getDeletedIntentions, isIntentionDeleted } from '../interiority/data.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How many sample rows each check keeps in the snapshot. Everything beyond
 * the limit is folded into a `more` count — the "copy full JSON" button on
 * the pane is the escape hatch for the complete lists (the phases doc's
 * "counts + top-N sample" shape).
 */
export const INTEGRITY_SAMPLE_LIMIT = 5;

/**
 * The per-store validation rows, enumerated from the schema registry
 * (`CHAT_METADATA_SCHEMA_IDS`, keyed by each descriptor's `metadataKey`) at
 * module load — design §9.2's "not a second list" rule, one owner
 * (schema/registry.js) for backup, runtime, and Diagnostics. If a store is
 * ever registered, it appears here automatically; the labels below only
 * decorate the derived list and carry no enumeration meaning of their own.
 */
export const INTEGRITY_STORE_SPECS = Object.freeze(CHAT_METADATA_SCHEMA_IDS.map((id) => ({
    id,
    key: STORE_SCHEMAS[id].metadataKey,
    label: {
        worldState: '🌍 World State',
        chronicle: '📜 Chronicle',
        knowledgeEvidence: '🧠 Knowledge evidence',
        knowledgeCounters: '🧠 Knowledge counters',
        storyPlanner: '🗺️ Story Planner',
        interiority: '🎭 Interiority',
    }[id] ?? id,
})));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Keep the first INTEGRITY_SAMPLE_LIMIT rows of a finding list and fold the
 * rest into a `more` count — the shared tail of every check's output shape.
 *
 * @template T
 * @param {T[]} items — the full finding list
 * @returns {{sample: T[], more: number}}
 */
export function integritySample(items) {
    const list = Array.isArray(items) ? items : [];
    const sample = list.slice(0, INTEGRITY_SAMPLE_LIMIT);
    return { sample, more: Math.max(0, list.length - sample.length) };
}

/**
 * The canonical form of an NPC name for cross-store joins: the registry key
 * it resolves to (so "Mara" and "Mara Vance" join through the registry's
 * exact → case-insensitive → unambiguous-alias rules), falling back to the
 * normalised name itself when the registry does not know it. Pure string
 * work — never mutates the registry.
 *
 * @param {object} reg — the registry map ({} when the store is empty)
 * @param {string} name
 * @returns {string}
 */
function canonicalNpcName(reg, name) {
    try {
        const key = resolveRegistryKey(reg, name);
        if (key != null) return normalizeRegistryName(key);
    } catch { /* a throwing resolver degrades to plain normalisation */ }
    return normalizeRegistryName(name);
}

/** Total row count of a check output ({ count, sample, more }) or 0. */
const countOf = (block) => (block && typeof block.count === 'number' ? block.count : 0);

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect the Integrity snapshot (Tab 7). ASYNC — the duplicate-profile and
 * dangling-pointer checks read the NPC Profiles lorebook through
 * `listProfileEntries()`, which loads the book; the store-validation rows
 * read live chat metadata. Everything is read-only.
 *
 * Every dependency is injectable and every check is individually guarded: a
 * throwing dependency degrades its own check to an empty result plus an
 * `errors` note (and a `check-degraded` warning), never the whole snapshot.
 *
 * @param {object} [deps]
 * @param {function(): number} [deps.now] — clock (default Date.now)
 * @param {string} [deps.version] — reported MWT version
 * @param {function(): Promise<Array<{uid:number, name:string, chars:number}>>} [deps.listProfileEntries]
 * @param {function(): object} [deps.getRegistry]
 * @param {function(): object} [deps.getChatMeta] — chat metadata (raw section
 *        data for the validateSection rows; evidence names)
 * @param {function(): Array} [deps.getLedger] — Interiority intentions ledger
 * @param {function(): Array} [deps.getDeletedIntentions] — Interiority tombstones
 * @param {function(string, string): boolean} [deps.isIntentionDeleted] — the
 *        live npc+action tombstone match rule (reused, not mirrored)
 * @param {function(string, *): object} [deps.validateSection] — reused as-is
 *        from backup/validate.js (validateSectionWithIssues: { summary,
 *        issues })
 * @param {Array<{id: string, key: string, label: string}>} [deps.stores] — the
 *        store rows to validate (default INTEGRITY_STORE_SPECS, derived from
 *        the schema registry)
 * @param {function(): { books: Array<{ name: string, role: 'knowledge'|'state' }>, mode: string }|null} [deps.knowledgeBooks] —
 *        read-only resolution of BOTH Knowledge-store books (default
 *        resolveKnowledgeBooks)
 * @param {function(string): object|null} [deps.knowledgePeek] — peekStore
 * @param {function(string): object|null} [deps.knowledgePeekData] — peekStoreData
 * @returns {Promise<object>} the snapshot (see the field docs below)
 */
export async function collectIntegritySnapshot(deps = {}) {
    const {
        now = Date.now,
        version = MWT_VERSION,
        listProfileEntries: listProfiles = listProfileEntries,
        getRegistry: registry = getRegistry,
        getChatMeta: chatMeta = getChatMeta,
        getLedger: ledger = getLedger,
        getDeletedIntentions: deletions = getDeletedIntentions,
        isIntentionDeleted: isDeleted = isIntentionDeleted,
        // §9.2: { summary, issues } per store — validateSectionWithIssues(),
        // one validation pass feeding the historical summary AND the
        // structured codes/paths. An old-shape validateSection() return (a
        // bare summary) still works: `issues` reads as [] and the codes
        // columns render empty rather than breaking the tab.
        validateSection: validate = validateSectionWithIssues,
        stores = INTEGRITY_STORE_SPECS,
        // The Knowledge lorebook-store rows (§9.2: "include it when reliably
        // hydrated") — one per book, since the store spans BOTH the Knowledge
        // and the State Tracker book. All read-only; null resolution or a
        // null peek degrades to a dim "not checked" row, never an error.
        knowledgeBooks = resolveKnowledgeBooks,
        knowledgePeek = peekStore,
        knowledgePeekData = peekStoreData,
    } = deps;

    const errors = [];
    /**
     * Run one check; a throw degrades to `fallback` plus an `errors` entry —
     * the health.js guard pattern, applied per check instead of per field
     * because each check here owns a whole block of the snapshot.
     */
    const guard = async (id, fn, fallback) => {
        try {
            return await fn();
        } catch (err) {
            errors.push(`${id}: ${err?.message || err}`);
            return fallback;
        }
    };

    // ── Inputs (each guarded) ────────────────────────────────────────────────
    const profileEntries = await guard('listProfileEntries', async () => await listProfiles(), []);
    const reg = await guard('getRegistry', () => registry(), {});
    const meta = await guard('getChatMeta', () => chatMeta(), {});
    const ledgerEntries = await guard('getLedger', () => ledger(), []);
    const tombstones = await guard('getDeletedIntentions', () => deletions(), []);

    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const regEntries = isObj(reg) ? Object.entries(reg) : [];
    // The evidence section's metadata key comes from the registry descriptor —
    // the same single owner the store rows use (§9.2).
    const evidenceKey = STORE_SCHEMAS.knowledgeEvidence.metadataKey;
    const evidenceMap = isObj(meta[evidenceKey]) ? meta[evidenceKey] : {};
    const evidenceEntries = Object.entries(evidenceMap).filter(([, file]) => isObj(file));
    const profileUids = new Set(profileEntries.map((e) => e?.uid));
    // The reliability guard: an empty entry list is indistinguishable from a
    // failed book read (listProfileEntries swallows its own errors), and
    // against it every `profileUid` would look dangling and every evidence
    // file orphaned. Registry profileUid pointers are the STRONG contradiction
    // (they point at entries that must exist); evidence alone is not — an
    // empty book over evidence with no pointers is the ordinary young-chat
    // state (capture ran, no profile generated yet), so evidence-without-
    // profile stays a reliable reading there.
    const bookUnreliable = profileEntries.length === 0
        && regEntries.some(([, info]) => info?.profileUid != null);

    // ── Check 1: duplicate profile entries ──────────────────────────────────
    // Mirrors MWT.profiles.duplicates() / auditProfiles: group the book by
    // normalised entry name; every group with more than one entry is the
    // visible half of a lost `profileUid` pointer. Counts are ENTRIES (the
    // duplicates() row count), samples are per GROUP. No previews — content
    // discipline (see the module header).
    const duplicateProfiles = await guard('duplicateProfiles', () => {
        const groups = new Map();
        let unnamed = 0;
        for (const e of profileEntries) {
            const name = String(e?.name ?? '').trim();
            if (!name) { unnamed++; continue; }
            const key = normalizeRegistryName(name);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ npc: name, uid: e?.uid, chars: e?.chars, referenced: false });
        }
        const registryProfileUids = new Set(
            regEntries.map(([, info]) => info?.profileUid).filter((u) => u != null),
        );
        const findings = [];
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            for (const row of list) row.referenced = registryProfileUids.has(row.uid);
            findings.push({ npc: list[0].npc, count: list.length, entries: list });
        }
        findings.sort((a, b) => b.count - a.count || a.npc.localeCompare(b.npc));
        const count = findings.reduce((sum, g) => sum + g.count, 0);
        return { count, groups: findings.length, unnamed, ...integritySample(findings) };
    }, { count: 0, groups: 0, unnamed: 0, sample: [], more: 0 });

    // ── Check 2: dangling profileUid pointers ───────────────────────────────
    // A registry `profileUid` that no longer matches any entry in the NPC
    // Profiles book: the next profile save creates a duplicate entry instead
    // of overwriting (the bug class MWT.profiles.relink recovers from).
    const danglingProfileUids = bookUnreliable
        ? { count: 0, unreliable: true, sample: [], more: 0 }
        : await guard('danglingProfileUids', () => {
            const findings = regEntries
                .filter(([, info]) => info?.profileUid != null && !profileUids.has(info.profileUid))
                .map(([npc, info]) => ({
                    npc,
                    registryKey: npc,
                    profileUid: info.profileUid,
                    registryUid: info?.uid ?? null,
                }))
                .sort((a, b) => a.npc.localeCompare(b.npc));
            return { count: findings.length, ...integritySample(findings) };
        }, { count: 0, sample: [], more: 0 });

    // ── Check 3: evidence ↔ profile orphans, both directions ────────────────
    // Joins go through canonicalNpcName() so an NPC known to the registry
    // matches under its alias spellings (the resolveRegistryKey rules), not
    // just under exact normalised equality. Unnamed profile entries cannot be
    // joined (the pruneDuplicates rationale) — they are counted by check 1.
    // evidenceWithoutProfile is an ordinary mid-pipeline READING (capture
    // ran, the profile has not been generated yet) and raises no warning;
    // profilesWithoutEvidence is the warn-worthy "unfalsifiable profile"
    // state the growth feature exists to prevent (see warnOrphanedProfiles).
    const evidenceJoin = bookUnreliable
        ? {
            evidenceWithoutProfile: { count: 0, unreliable: true, sample: [], more: 0 },
            profilesWithoutEvidence: { count: 0, unreliable: true, sample: [], more: 0 },
        }
        : await guard('evidenceJoin', () => {
            const profileCanon = new Map();
            for (const e of profileEntries) {
                const name = String(e?.name ?? '').trim();
                if (!name) continue;
                const canon = canonicalNpcName(reg, name);
                if (!profileCanon.has(canon)) profileCanon.set(canon, []);
                profileCanon.get(canon).push(e);
            }
            const evidenceCanon = new Set(
                evidenceEntries.map(([name]) => canonicalNpcName(reg, name)),
            );

            const evidenceFindings = evidenceEntries
                .filter(([name]) => !profileCanon.has(canonicalNpcName(reg, name)))
                .map(([name, file]) => ({
                    npc: name,
                    raw: Array.isArray(file.raw) ? file.raw.length : 0,
                    consolidated: Array.isArray(file.consolidated) ? file.consolidated.length : 0,
                    archivedRaw: Array.isArray(file.archivedRaw) ? file.archivedRaw.length : 0,
                }))
                .sort((a, b) => a.npc.localeCompare(b.npc));

            const profileFindings = [];
            for (const [canon, list] of profileCanon) {
                if (evidenceCanon.has(canon)) continue;
                for (const e of list) {
                    profileFindings.push({ npc: String(e?.name ?? ''), uid: e?.uid, chars: e?.chars });
                }
            }
            profileFindings.sort((a, b) => a.npc.localeCompare(b.npc) || (a.uid ?? 0) - (b.uid ?? 0));

            return {
                evidenceWithoutProfile: { count: evidenceFindings.length, ...integritySample(evidenceFindings) },
                profilesWithoutEvidence: { count: profileFindings.length, ...integritySample(profileFindings) },
            };
        }, {
            evidenceWithoutProfile: { count: 0, sample: [], more: 0 },
            profilesWithoutEvidence: { count: 0, sample: [], more: 0 },
        });
    const { evidenceWithoutProfile, profilesWithoutEvidence } = evidenceJoin;

    // ── Check 4: validateSection() per store ────────────────────────────────
    // Reused as-is from backup/validate.js over the live chat-metadata
    // sections enumerated from METADATA_KEYS. Absent sections are ordinary
    // (a store that has never written this chat) — reported `present: false`,
    // never a warning. Quarantined RECORDS are never copied into the
    // snapshot (they can quote the chat); only the validators' own reason
    // strings are kept, capped like any sample.
    //
    // DEFERRALS (a store paused pending a one-time, chat-dependent
    // compatibility update) are a PREPARING state, not findings: the entries
    // they describe were retained — an import accepts them — so they never
    // inflate skippedCount/skippedTotal or the findings count. They surface
    // as `preparing` rows with their own sampled reasons and one
    // store-preparing warning (design §7.5: a pause must be visible, but
    // never read as quarantined or corrupt).
    const sampleReasons = (entries) => {
        const reasons = [];
        const seenReason = new Set();
        for (const entry of Array.isArray(entries) ? entries : []) {
            const reason = entry && typeof entry === 'object' ? String(entry.reason ?? '') : '';
            if (!reason || seenReason.has(reason)) continue;
            seenReason.add(reason);
            reasons.push(reason);
            if (reasons.length >= INTEGRITY_SAMPLE_LIMIT) break;
        }
        return reasons;
    };
    // §9.2 structured codes: aggregate the finding issues by `code`, keeping
    // each code's count and first path — the machine-readable half of the
    // per-store report (reason strings are the human half, above). Raw issue
    // RECORDS never enter the snapshot.
    const issueCodeSample = (issues) => {
        const byCode = new Map();
        for (const issue of Array.isArray(issues) ? issues : []) {
            if (!issue || typeof issue !== 'object') continue;
            const code = String(issue.code ?? 'unknown');
            const entry = byCode.get(code) ?? {
                code,
                count: 0,
                path: Array.isArray(issue.path) ? issue.path.join('.') : '',
            };
            entry.count += 1;
            byCode.set(code, entry);
        }
        return [...byCode.values()]
            .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
            .slice(0, INTEGRITY_SAMPLE_LIMIT);
    };
    // One row from one { summary, issues } validation result.
    const storeRow = (spec, raw, extra = {}) => {
        const checked = validate(spec.id, raw);
        const summary = checked && typeof checked === 'object' && 'summary' in checked
            ? (checked.summary ?? {})
            : (checked ?? {});
        const issues = Array.isArray(checked?.issues) ? checked.issues : [];
        const deferred = Array.isArray(summary.deferred) ? summary.deferred : [];
        return {
            id: spec.id,
            label: spec.label,
            key: spec.key,
            present: true,
            added: summary.added ?? 0,
            updated: summary.updated ?? 0,
            skippedCount: Array.isArray(summary.skipped) ? summary.skipped.length : 0,
            conflicts: summary.conflicts ?? 0,
            reasons: sampleReasons(summary.skipped),
            preparing: deferred.length > 0,
            deferredCount: deferred.length,
            deferredReasons: sampleReasons(deferred),
            warning: typeof summary.warning === 'string' ? summary.warning : null,
            issueCodes: issueCodeSample(issues),
            ...extra,
        };
    };
    const storeValidations = await guard('storeValidations', () => {
        const rows = stores.map((spec) => {
            const raw = meta[spec.key];
            const present = raw !== undefined && raw !== null;
            if (!present) {
                return { id: spec.id, label: spec.label, key: spec.key, present: false };
            }
            return storeRow(spec, raw);
        });

        // The Knowledge lorebook store (§9.2: "include it when reliably
        // hydrated"). Its data lives inside each book's [MWT:store] entry,
        // not chat metadata — and the store spans BOTH books (Knowledge +
        // State Tracker): each resolved book gets its own row, validated
        // from the read-only cache copy when that book is hydrated and
        // rendered as a dim NOT-CHECKED row otherwise (an un-hydrated book
        // is the ordinary early/async state, never a finding: nothing was
        // validated, so nothing is counted).
        const lorebookSpec = (role) => role === 'state'
            ? { id: 'knowledgeStore', label: '🧠 State Tracker lorebook store', key: '(lorebook [MWT:store] entry)' }
            : { id: 'knowledgeStore', label: '🧠 Knowledge lorebook store', key: '(lorebook [MWT:store] entry)' };
        const notCheckedRow = (spec, book, reason, warning = null) => ({
            id: spec.id, label: spec.label, key: spec.key,
            present: false, lorebook: true, book, checked: false,
            reason,
            added: 0, updated: 0, skippedCount: 0, conflicts: 0,
            reasons: [], preparing: false, deferredCount: 0, deferredReasons: [],
            warning, issueCodes: [],
        });
        const resolution = knowledgeBooks?.() ?? null;
        const books = (Array.isArray(resolution?.books) ? resolution.books : [])
            .filter((b) => typeof b?.name === 'string' && b.name);
        if (books.length === 0) {
            // Resolution degraded: one anonymous not-checked row — never an
            // error (the legacy single-row shape).
            rows.push(notCheckedRow(lorebookSpec('knowledge'), null, 'not-hydrated'));
        } else {
            for (const book of books) {
                const role = book.role === 'state' ? 'state' : 'knowledge';
                const spec = lorebookSpec(role);
                const peek = knowledgePeek?.(book.name) ?? null;
                if (peek?.hydrated === true) {
                    const data = knowledgePeekData?.(book.name);
                    if (data && data.__unserializable !== true) {
                        rows.push(storeRow(spec, data, {
                            lorebook: true,
                            book: book.name,
                            role,
                            storeVersion: typeof peek.version === 'number' ? peek.version : null,
                        }));
                    } else {
                        rows.push({
                            ...notCheckedRow(
                                spec,
                                book.name,
                                'store-unserializable',
                                'The book\'s cached store data could not be serialised for validation.',
                            ),
                            present: true,
                        });
                    }
                } else {
                    rows.push(notCheckedRow(spec, book.name, 'not-hydrated'));
                }
            }
        }

        const skippedTotal = rows.reduce((sum, r) => sum + (r.skippedCount || 0), 0);
        const conflictsTotal = rows.reduce((sum, r) => sum + (r.conflicts || 0), 0);
        const deferredTotal = rows.reduce((sum, r) => sum + (r.deferredCount || 0), 0);
        return { sections: rows, skippedTotal, conflictsTotal, deferredTotal };
    }, { sections: [], skippedTotal: 0, conflictsTotal: 0, deferredTotal: 0 });

    // ── Check 5: Interiority ledger reference integrity ─────────────────────
    // Built on the tombstones MWT.interiority.deletions() exposes:
    //   • duplicate ledger ids — two live entries sharing an id break every
    //     by-id edit/remove path;
    //   • a LIVE entry matching a tombstone (the isIntentionDeleted npc+action
    //     rule, reused not mirrored) — the swipe-restore bug class the
    //     tombstones exist to prevent; the entry should not exist;
    //   • duplicate tombstone ids — restore merges dedupe on id, but
    //     hand-edited or restored chats can carry two.
    const interiority = await guard('interiorityIntegrity', () => {
        const ledgerIds = new Map();
        for (const entry of ledgerEntries) {
            const id = entry?.id;
            if (id == null) continue;
            ledgerIds.set(id, (ledgerIds.get(id) || 0) + 1);
        }
        const dupLedgerIds = [...ledgerIds.entries()]
            .filter(([, n]) => n > 1)
            .map(([id]) => ({ id, occurrences: ledgerIds.get(id) }))
            .sort((a, b) => a.id.localeCompare(b.id));

        const tombstonedStillLive = ledgerEntries
            .filter((entry) => {
                try {
                    return isDeleted(String(entry?.npc ?? ''), String(entry?.action ?? ''));
                } catch { return false; }
            })
            .map((entry) => ({ id: entry?.id ?? null, npc: entry?.npc ?? '', action: entry?.action ?? '' }));

        const tombstoneIds = new Map();
        for (const t of tombstones) {
            const id = t?.id;
            if (id == null) continue;
            tombstoneIds.set(id, (tombstoneIds.get(id) || 0) + 1);
        }
        const dupTombstoneIds = [...tombstoneIds.entries()]
            .filter(([, n]) => n > 1)
            .map(([id]) => ({ id, occurrences: tombstoneIds.get(id) }))
            .sort((a, b) => a.id.localeCompare(b.id));

        return {
            ledgerEntries: ledgerEntries.length,
            tombstones: tombstones.length,
            duplicateLedgerIds: { count: dupLedgerIds.length, ...integritySample(dupLedgerIds) },
            tombstonedStillInLedger: { count: tombstonedStillLive.length, ...integritySample(tombstonedStillLive) },
            duplicateTombstoneIds: { count: dupTombstoneIds.length, ...integritySample(dupTombstoneIds) },
        };
    }, {
        ledgerEntries: 0,
        tombstones: 0,
        duplicateLedgerIds: { count: 0, sample: [], more: 0 },
        tombstonedStillInLedger: { count: 0, sample: [], more: 0 },
        duplicateTombstoneIds: { count: 0, sample: [], more: 0 },
    });

    // ── Warnings + banner ───────────────────────────────────────────────────
    const warnings = [];
    const warn = (id, level, text) => warnings.push({ id, level, text });
    if (duplicateProfiles.count > 0) {
        warn('duplicate-profiles', 'warn',
            `${duplicateProfiles.count} profile entries share names across ${duplicateProfiles.groups} NPC group(s) — the visible half of lost profileUid pointers. `
            + 'Read-only preview: MWT.profiles.duplicates() / pruneDuplicates().');
    }
    if (danglingProfileUids.count > 0) {
        warn('dangling-profile-uids', 'warn',
            `${danglingProfileUids.count} registry profileUid pointer(s) point at entries that no longer exist — the next profile save will duplicate instead of overwriting. `
            + 'Recovery (dry-run first): MWT.profiles.relink().');
    }
    if (profilesWithoutEvidence.count > 0) {
        warn('profiles-without-evidence', 'warn',
            `${profilesWithoutEvidence.count} profile entries have no evidence file behind them — unfalsifiable state: nothing can confirm or regenerate them. `
            + 'Re-capture evidence, or delete the entries by hand.');
    }
    if (storeValidations.skippedTotal > 0) {
        warn('store-validation-skipped', 'warn',
            `${storeValidations.skippedTotal} quarantined record(s) across the chat-metadata stores — records a backup import would refuse. Reasons are sampled per store in storeValidations.sections.`);
    }
    if (storeValidations.deferredTotal > 0) {
        // A preparation pause (design §7.5/§5.4): visible, store-local, and
        // worded as preparing — never as quarantined or corrupt records. The
        // deferred stores' own reasons (sampled in storeValidations.sections)
        // carry the module-specific wording.
        warn('store-preparing', 'warn',
            `${storeValidations.deferredTotal} store section(s) are preparing — a one-time, chat-dependent compatibility update is pending; the saved data was left unchanged and nothing was quarantined.`);
    }
    if (storeValidations.conflictsTotal > 0) {
        warn('store-validation-conflicts', 'warn',
            `${storeValidations.conflictsTotal} duplicate-id conflict(s) across the chat-metadata stores.`);
    }
    if (interiority.duplicateLedgerIds.count > 0) {
        warn('duplicate-ledger-ids', 'warn', `${interiority.duplicateLedgerIds.count} Interiority ledger id(s) are shared by more than one live entry — every by-id edit/remove path targets one of them arbitrarily.`);
    }
    if (interiority.tombstonedStillInLedger.count > 0) {
        warn('tombstoned-intention-live', 'warn',
            `${interiority.tombstonedStillInLedger.count} live ledger entry/entries match a deletion tombstone (npc + action) — deleted intentions that came back (swipe/restore of an older snapshot). `
            + 'MWT.interiority.deletions() lists the tombstones.');
    }
    if (interiority.duplicateTombstoneIds.count > 0) {
        warn('duplicate-tombstone-ids', 'warn', `${interiority.duplicateTombstoneIds.count} tombstone id(s) appear more than once.`);
    }
    if (bookUnreliable) {
        warn('profile-book-unreadable', 'warn',
            'The NPC Profiles lorebook read came back empty while registry profileUid pointers are set — the dangling-pointer and evidence-join checks were skipped rather than flood false findings. '
            + 'Check MWT.scope.diagnose() for which book this chat resolves to, and the console for a load error.');
    }
    for (const err of errors) {
        warn('check-degraded', 'warn', `A check could not run and its counts are unreliable: ${err}`);
    }
    // evidenceWithoutProfile stays a READING (ordinary mid-pipeline), not a
    // warning — the same "readings stay rows, not verdicts" rule the Log tab
    // applies to warn-level events. Absent metadata sections likewise.

    const bannerLevel = warnings.length > 0 ? 'warn' : 'ok';
    const findings = countOf(duplicateProfiles)
        + countOf(danglingProfileUids)
        + countOf(profilesWithoutEvidence)
        + (storeValidations.skippedTotal || 0)
        + (storeValidations.conflictsTotal || 0)
        + countOf(interiority.duplicateLedgerIds)
        + countOf(interiority.tombstonedStillInLedger)
        + countOf(interiority.duplicateTombstoneIds);

    return {
        generatedAt: now(),
        mwtVersion: version,
        bannerLevel,
        warnings,
        totals: {
            // Warn-worthy findings only; evidenceWithoutProfile is a reading.
            findings,
            profileEntries: profileEntries.length,
            registryRecords: regEntries.length,
            evidenceFiles: evidenceEntries.length,
            ledgerEntries: interiority.ledgerEntries,
            tombstones: interiority.tombstones,
            sectionsPresent: storeValidations.sections.filter((r) => r.present).length,
        },
        duplicateProfiles,
        danglingProfileUids,
        evidenceWithoutProfile,
        profilesWithoutEvidence,
        storeValidations,
        interiority,
        ...(errors.length ? { errors } : {}),
    };
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Normalise an Integrity snapshot for SAFE return/render — what
 * `MWT.diagnostics.integrity()` returns and what the 🛡️ Integrity pane renders
 * (the Phase 5 contract: every surface routes through core/redaction.js; no
 * hand-rolled redaction).
 *
 * The snapshot carries no chat prose by construction (no previews, no
 * records), so both content modes look identical here — but every string is
 * still Rule-1b secret-scrubbed (this install's live secret values, embedded
 * URLs → scheme+host, key/bearer shapes): an NPC name or validator reason
 * that happens to contain a key-shaped token is struck out before anything is
 * pasted. The input is never mutated; the output shares no references with it.
 *
 * @param {object} snapshot — collectIntegritySnapshot() output
 * @param {object} [opts]
 * @param {boolean} [opts.includeContent=false] — the live opt-in state
 *        (accepted for signature parity; nothing on this tab is content)
 * @param {string[]} [opts.knownSecrets] — live secret VALUES; defaults to
 *        collectKnownSecrets() (guarded; [] with no SillyTavern runtime)
 * @returns {object} a redacted deep copy
 */
export function redactIntegritySnapshot(snapshot, { includeContent = false, knownSecrets } = {}) {
    return redactForReport(snapshot, {
        includeContent,
        knownSecrets: knownSecrets ?? collectKnownSecrets(),
    });
}
