/**
 * knowledge/registry.js — NPC registry and State Tracker registry operations.
 *
 * Registries are flat { name: {...} } maps. They used to live in chat metadata,
 * which gave them a per-chat lifetime while the lorebook entries they point at
 * were global — so a new chat started from an empty registry and re-created
 * every entry as a duplicate. They now live inside the lorebook itself (see
 * store.js), which ties pointer and target to one file and one lifetime.
 *
 * These accessors stay synchronous: they read the store's in-memory cache,
 * which `hydrateCurrentBooks()` fills on chat change.
 */

import { getChat } from '../core/index.js';

import { getLorebookName, getStateLorebookName } from './scope.js';
import { readField, writeField } from './store.js';
import { ensureRegistryIdentityFields } from './schema.js';

// ─── NPC Registry ────────────────────────────────────────────────────────────

export function getRegistry() {
    return readField(getLorebookName(), 'registry', {});
}

export function saveRegistry(reg) {
    // Store the flat map as-is. Nothing may merge a `lastUpdated` sibling into
    // it — callers iterate this map as { npcName: info } and a stray key would
    // be read as an NPC.
    //
    // The one in-shape mutation (TODO §1 identity service): stamp the identity
    // fields (`entityId`, `aliases`) records lack. This is the registry's ONLY
    // write seam, so every creation path — registerEntry, reconcile repairs,
    // lorebook imports, the v2 migration's leftovers — converges on the full
    // shape without each caller remembering to.
    ensureRegistryIdentityFields(reg);
    writeField(getLorebookName(), 'registry', reg);
}

export function registerEntry(name, uid, type, keywords) {
    const reg = getRegistry();
    // MERGE, never replace — a wholesale `reg[name] = {...}` retired the
    // record's entityId (saveRegistry's stamper then minted a fresh one) and
    // dropped aliases, mergedFrom, and profileUid, dangling every id-keyed
    // reference (relationship edges, audit trails). See the matching notes in
    // render.js handleAccept and knowledge/index.js scanAndAccept.
    reg[name] = {
        ...(reg[name] || {}),
        uid,
        type,
        keywords: keywords || [name],
        lastUpdated: Date.now(),
    };
    saveRegistry(reg);
}

export function isKnown(name) {
    // KNOWLEDGE-03: Route through the resolver so isKnown respects case/
    // given-name matching instead of requiring an exact key hit.
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    return key != null && !!reg[key];
}

/**
 * KNOWLEDGE-03: The single accessor for looking up an NPC's registry info.
 *
 * Every boundary that needs an NPC's uid/type/keywords must go through here.
 * Direct `getRegistry()[name]` lookups silently miss when the model uses a
 * given name ("Mara") and the registry stores the full name ("Mara Vance"),
 * producing false "new NPC" proposals and duplicate lorebook entries.
 *
 * This function resolves the name through {@link resolveRegistryKey} (exact,
 * case-insensitive, then unambiguous given-name) and returns the info object
 * plus the canonical registry key it matched on.
 *
 * @param {string} name — the name to look up (model output, user input, etc.)
 * @returns {{key: string, info: object}|null} the registry entry, or null if
 *   no match (including when the name is ambiguous — fail closed)
 */
export function getRegistryEntry(name) {
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    if (key == null) return null;
    const info = reg[key];
    return info ? { key, info } : null;
}

/**
 * The registry accessor's name normalization: lowercase + trim.
 *
 * Single source of truth for "do these two NPC names refer to the same entity
 * after the accessor normalizes them?" resolveRegistryKey() compares
 * normalized forms for its case-insensitive step, and the lorebook identity
 * check (KNOWLEDGE-01) must compare the same way — otherwise a case or
 * leading/trailing-whitespace difference between a lorebook entry's comment
 * and the registry key reads as a stale uid, detaches a *valid* uid, and
 * creates the exact duplicate the guard exists to prevent.
 *
 * Internal whitespace is intentionally not collapsed here; that is a separate
 * matching concern handled by the given-name step of resolveRegistryKey().
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeRegistryName(name) {
    return String(name ?? '').toLowerCase().trim();
}

/**
 * Resolve an NPC name to its registry key.
 *
 * Registry keys and the names other modules hold are written by different
 * systems and do not agree on form. The world state `Present:` line is free
 * text from the world-state model and routinely uses given names ("Mara"),
 * while the registry is keyed on whatever the knowledge tracker first
 * recorded, often fuller ("Mara Vance"). An exact lookup silently returns
 * null for every such NPC — and callers read that as "this NPC has no entry",
 * which is a legitimate state for a genuinely new NPC, so nothing warns.
 *
 * Matching runs strictest-first:
 *   1. exact key
 *   2. case-insensitive exact
 *   3. explicit alias (TODO §1 identity service) — the wanted name matches a
 *      record's user-approved `aliases` exactly (same normalization). One hit
 *      resolves; more than one is genuinely ambiguous and fails closed
 *   4. {@link isUnambiguousNpcAlias} alias match, both directions — but ONLY
 *      when unambiguous in the context of every same-given-name registry key
 *
 * Step 3 is the user-authored form of "these spellings are one entity" — it
 * resolves titles and nicknames ("The Vixen") the heuristic could never prove.
 * Step 4 refuses to choose between two NPCs sharing a given name ("Mara
 * Vance" / "Mara Chen") — and, since it uses the shared identity rule rather
 * than a first-token comparison, it also refuses when only ONE of them is on
 * file. Registry entries gate access to a character's dossier and secrets, so
 * a wrong match would hand one character's private material to another. No
 * entry is always safer than the wrong entry.
 *
 * @param {object} reg — the registry map ({ [npcName]: info })
 * @param {string} name — the name to resolve
 * @returns {string|null} the matching registry key, or null
 */
export function resolveRegistryKey(reg, name) {
    if (!reg) return null;
    const wanted = normalizeRegistryName(name);
    if (!wanted) return null;

    // 1. Exact hit — cheap path. hasOwnProperty, not `reg[name] !== undefined`:
    // a bare lookup would match inherited keys ("constructor", "toString").
    if (Object.prototype.hasOwnProperty.call(reg, name)) return name;

    const keys = Object.keys(reg);

    // 2. Case-insensitive exact match (same normalization as the lorebook
    // identity check — see normalizeRegistryName).
    for (const key of keys) {
        if (normalizeRegistryName(key) === wanted) return key;
    }

    // 3. Explicit aliases (TODO §1 identity service): the user-approved
    // identity links stored on each record. Exact (normalized) match only —
    // aliases never enter the shorthand heuristic below, because a nickname
    // like "The Vixen" shares no token with "Mara Vance" and a heuristic hit
    // would be a coincidence, not a proof. More than one record claiming the
    // alias is genuinely ambiguous (imported data the validator could not
    // see) — fail closed exactly like step 4.
    const aliasHits = keys.filter(key => Array.isArray(reg[key]?.aliases)
        && reg[key].aliases.some(alias => normalizeRegistryName(alias) === wanted));
    if (aliasHits.length === 1) return aliasHits[0];
    if (aliasHits.length > 1) {
        console.warn(
            `[MWT:Knowledge] NPC name "${name}" is an ambiguous alias — claimed by registry ` +
            `entries: ${aliasHits.join(', ')}. Using no entry rather than risk exposing ` +
            `another character's dossier. Remove the duplicate alias to disambiguate.`
        );
        return null;
    }

    // 4. Alias match, both directions — with the full same-given-name context:
    //      "Mara"       → registry "Mara Vance"
    //      "Mara Vance" → registry "Mara"
    //
    // NOT a bare first-token comparison. That older rule resolved "Mara Chen"
    // to registry "Mara Vance" whenever Vance was the only "Mara" on file —
    // one full name silently answering for a DIFFERENT full name, which is the
    // wrong-NPC failure this resolver exists to prevent. isSameNpcIdentity
    // requires equality or single-token ↔ full-name, so two multi-token names
    // that merely share a given name never match. Pairwise validity alone is
    // insufficient, though: with "Mara", "Mara Vance", and "Mara Chen" on
    // file, "Mara Vance" ↔ "Mara" is valid pairwise but the shorthand cannot
    // safely be attributed to Vance. The contextual clique check catches that.
    const candidates = keys.filter(k => isUnambiguousNpcAlias(k, wanted, keys));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
        console.warn(
            `[MWT:Knowledge] NPC name "${name}" is ambiguous — matches registry entries: ` +
            `${candidates.join(', ')}. Using no entry rather than risk exposing another ` +
            `character's dossier. Rename one to disambiguate.`
        );
    }
    return null;
}

/**
 * Do two names denote the SAME NPC — the pairwise (1:1) form of the matching
 * {@link resolveRegistryKey} and {@link auditRegistryAliases} already use.
 *
 * True when, after normalization, the names are equal, OR one is a single
 * token that is the other's first token ("Sophie" ↔ "Sophie Simpson"). Two
 * multi-token names that merely share a given name ("Mara Vance" / "Mara
 * Chen") are DIFFERENT people and return false. An empty name matches nothing.
 *
 * This is the pairwise primitive behind the lorebook label checks; their
 * shorthand decisions additionally use {@link isUnambiguousNpcAlias}. The
 * registry's own repair paths — e.g.
 * importFromLorebooks — legitimately link a canonical key to a physical entry
 * labelled with an alias spelling ("Sophie" → an entry commented "Sophie
 * Simpson"). An exact-only label check refused that valid link, and on the
 * next write detached the uid and re-created the very duplicate the guard
 * exists to prevent. The Mikhail/Marcus protection is unchanged: names that
 * are neither equal nor a single-token alias do not match.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameNpcIdentity(a, b) {
    const an = normalizeRegistryName(a);
    const bn = normalizeRegistryName(b);
    if (!an || !bn) return false;
    if (an === bn) return true;
    const aTokens = an.split(/\s+/);
    const bTokens = bn.split(/\s+/);
    return (aTokens.length === 1 && bTokens.length > 1 && bn.startsWith(an + ' '))
        || (bTokens.length === 1 && aTokens.length > 1 && an.startsWith(bn + ' '));
}

/**
 * Is a non-exact alias safe to use within a population of known names?
 *
 * {@link isSameNpcIdentity} intentionally answers only the pairwise question.
 * A single-token shorthand can therefore bridge distinct full names: "Mara"
 * aliases both "Mara Vance" and "Mara Chen" pairwise, even though Vance and
 * Chen are strangers. Before resolving such a shorthand, every name sharing
 * its given name must form a complete pairwise-alias clique. Exact normalized
 * matches stay authoritative and do not need this contextual test.
 *
 * @param {string} a
 * @param {string} b
 * @param {Iterable<string>} [population] — registry keys, roster names, or
 *   lorebook labels visible to the caller
 * @returns {boolean}
 */
export function isUnambiguousNpcAlias(a, b, population = []) {
    const an = normalizeRegistryName(a);
    const bn = normalizeRegistryName(b);
    if (!an || !bn || !isSameNpcIdentity(an, bn)) return false;
    if (an === bn) return true;

    const givenName = an.split(/\s+/)[0];
    const names = [a, b, ...population]
        .filter(name => normalizeRegistryName(name).split(/\s+/)[0] === givenName);
    return names.every(left => names.every(right => isSameNpcIdentity(left, right)));
}

/**
 * Do two NPC spellings resolve to the SAME registry record through an
 * EXPLICIT link — the record's own key or its user-approved aliases?
 *
 * Explicit links are: an exact key, a case-insensitive key hit, or a
 * user-approved explicit alias ("The Vixen" for "Mara Vance"). The resolver's
 * given-name heuristic tier is deliberately NOT part of this: that tier's
 * population is the registry alone, while the lorebook label checks must also
 * weigh the BOOK's labels ("Mara Vance" heuristic-resolves to registry "Mara"
 * when she is the only Mara on file — but a book also holding "Mara Chen"
 * makes the pair ambiguous, and that ambiguity is the caller's
 * population-aware heuristic's to judge, not the registry's).
 *
 * This is the registry-backed half of the lorebook label checks (see
 * {@link isSameNpcByName}): after a rename like "Mara" → "The Vixen", the
 * lorebook entry is relabelled "The Vixen" while a staged update can still
 * spell the NPC "Mara" — the spellings share no token, but the registry's
 * alias links both to one record, and that is the proof the label check
 * needs to keep the uid instead of minting a duplicate entry.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function resolvesToSameRegistryRecord(a, b) {
    const reg = getRegistry();
    const aKey = resolveRegistryKey(reg, a);
    if (aKey === null) return false;
    const bKey = resolveRegistryKey(reg, b);
    if (bKey === null || aKey !== bKey) return false;
    // Both spellings landed on one record — but only count it when each got
    // there by an EXPLICIT link (key or alias), not the given-name heuristic.
    return isExplicitRegistryLink(reg, a, aKey) && isExplicitRegistryLink(reg, b, bKey);
}

/**
 * Did `name` reach `key` through the record's own key or an explicit alias?
 * @param {object} reg @param {string} name @param {string} key @returns {boolean}
 */
function isExplicitRegistryLink(reg, name, key) {
    const wanted = normalizeRegistryName(name);
    if (wanted && normalizeRegistryName(key) === wanted) return true;
    return Array.isArray(reg?.[key]?.aliases)
        && reg[key].aliases.some(alias => normalizeRegistryName(alias) === wanted);
}

/**
 * Do two NPC spellings denote the same NPC — the label-verification form of
 * the resolver used by the lorebook identity checks (writeToLorebook's
 * KNOWLEDGE-01, writeProfileToLorebook, relabelLorebookEntry,
 * loadEntryContent, and findEntryUidByNpcIdentity)?
 *
 * Two tiers, strongest evidence first:
 *   1. registry-proven — {@link resolvesToSameRegistryRecord}: both spellings
 *      reach one record through an EXPLICIT link (its key or a user-approved
 *      alias). This is what recognizes an arbitrary rename whose spellings
 *      share no token ("Mara" ↔ "The Vixen").
 *   2. the shared contextual heuristic — {@link isUnambiguousNpcAlias} with
 *      the caller's population, for spellings the registry cannot relate (a
 *      not-yet-registered NPC, a book label that predates the registry) and
 *      for given-name matches, whose ambiguity is judged against the caller's
 *      population — the registry alone cannot see it.
 *
 * Tier 2 deliberately still runs when the registry knows both spellings as
 * DIFFERENT records: that is exactly the audit's known-duplicate state
 * ("Sophie" and "Sophie Simpson" both on file), and the registry's repair
 * paths legitimately link a canonical key to an entry labelled with the
 * other's spelling — which copy is authoritative is a human decision, so
 * this check must not newly refuse it. The Mikhail/Marcus protection is
 * unchanged: names that are neither registry-linked nor heuristic aliases
 * never match.
 *
 * @param {string} a — the label as written (e.g. a lorebook entry comment)
 * @param {string} b — the expected NPC name
 * @param {Iterable<string>} [population] — labels/keys visible to the caller,
 *   feeding the heuristic's ambiguity clique check
 * @returns {boolean}
 */
export function isSameNpcByName(a, b, population = []) {
    if (resolvesToSameRegistryRecord(a, b)) return true;
    return isUnambiguousNpcAlias(a, b, population);
}

// ─── Profile UID (NPC Profiles lorebook cross-reference) ─────────────────────
//
// The registry gains a `profileUid` field (parallel to `uid`) pointing at the
// NPC's entry in the "NPC Profiles" lorebook. This lets the editor cross-
// reference both entries. See NPC_GROWTH_BLUEPRINT.md §"How the two entries
// relate".

/**
 * Get the profile lorebook UID for an NPC, or null if none.
 * @param {string} name — NPC name
 * @returns {number|null}
 */
export function getProfileUid(name) {
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    const info = key != null ? reg[key] : null;
    const uid = info?.profileUid;
    return (uid === null || uid === undefined) ? null : uid;
}

/**
 * Set the profile lorebook UID for an NPC (after writing the profile entry).
 *
 * Returns whether the uid was actually recorded. This used to fail silently
 * (`if (!reg[name]) return;`), which let a profile save report success while
 * recording nothing: the lorebook entry existed, the registry never pointed at
 * it, and the next save created a duplicate entry instead of overwriting.
 * A miss is now a loud, actionable warning.
 *
 * @param {string} name — NPC name
 * @param {number} uid — profile lorebook UID
 * @returns {boolean} true if recorded, false if no registry entry matched
 */
export function setProfileUid(name, uid) {
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    if (key == null) {
        console.warn(
            `[MWT:Knowledge] Could not record profileUid ${uid} for "${name}" — no matching ` +
            `registry entry. The profile IS saved in the "NPC Profiles" lorebook, but nothing ` +
            `points at it, so the next save would create a duplicate. Known entries: ` +
            `${Object.keys(reg).join(', ') || '(none)'}.`
        );
        return false;
    }
    reg[key].profileUid = uid;
    saveRegistry(reg);
    return true;
}

export function findOrphans() {
    const reg = getRegistry();
    return Object.keys(reg).filter(name => reg[name].uid === null || reg[name].uid === undefined);
}

export function getAllNpcNames() { return Object.keys(getRegistry()); }

/**
 * Find registry identities that unambiguously alias the SAME NPC (read-only).
 *
 * History: the scan/import/staging paths used to accept the model's spelling
 * verbatim, so one character could accumulate several registry identities
 * ("Sophie" and "Sophie Simpson"), each with its own lorebook entry. Those
 * paths now canonicalize through {@link resolveRegistryKey}, which stops NEW
 * duplicates — but existing ones are deliberately NOT auto-merged here: two
 * entries under alias spellings may contain different facts, so which copy is
 * authoritative is a human decision. This function only reports.
 *
 * Two names are aliases when, after normalization, they are equal, or when one
 * is a single token that equals the other's FIRST token (the same rule
 * resolveRegistryKey uses). Two multi-token names that merely share a given
 * name ("Mara Vance" / "Mara Chen") are DIFFERENT people.
 *
 * Each reported group is a connected component under that rule, CLASSIFIED —
 * grouping alone would lie. A short name bridges two full names it cannot
 * choose between: {"Mara", "Mara Vance", "Mara Chen"} is one component, but
 * calling it one NPC contradicts resolveRegistryKey, which refuses that match
 * outright, and could talk someone into deleting a real character. So:
 *   - kind 'alias': every pair in the component aliases every other — these
 *     really are one NPC under several spellings;
 *   - kind 'ambiguous': the component is bridged by a shorthand. Which full
 *     name it belongs to is unknowable from the registry; the fix is to rename
 *     the short record, not to merge.
 *
 * @param {object} reg — the registry map ({ [npcName]: info })
 * @returns {Array<{kind: string, names: string[], entries: Array<{name: string, uid: number|null, type: string, lastUpdated: number|null}>}>}
 *   groups with 2+ identities; empty array when the registry is clean
 */
export function auditRegistryAliases(reg) {
    const components = [];
    // Same pairwise rule the lorebook label checks use — one source of truth
    // for "same NPC" across the registry and the lorebook (see isSameNpcIdentity).
    const areAliases = (a, b) => isSameNpcIdentity(a, b);

    for (const key of Object.keys(reg || {})) {
        // Merge every component this key touches: transitive reachability is
        // what makes the result independent of key order (seeding from "Mara
        // Vance" must produce the same components as seeding from "Mara").
        const touched = components.filter(group => group.some(member => areAliases(member, key)));
        if (touched.length === 0) { components.push([key]); continue; }
        const [first, ...rest] = touched;
        first.push(key);
        for (const other of rest) {
            first.push(...other);
            components.splice(components.indexOf(other), 1);
        }
    }

    return components
        .filter(names => names.length > 1)
        .map(names => ({
            // A clique is one NPC; anything looser is a shorthand collision.
            kind: names.every(a => names.every(b => a === b || areAliases(a, b)))
                ? 'alias'
                : 'ambiguous',
            names,
            entries: names.map(n => ({
                name: n,
                uid: reg[n]?.uid ?? null,
                type: reg[n]?.type ?? 'minor',
                lastUpdated: reg[n]?.lastUpdated ?? null,
            })),
        }));
}

// ─── State Registry ──────────────────────────────────────────────────────────

export function getStateRegistry() {
    // Lives in the State Tracker book, alongside the entries it points at.
    return readField(getStateLorebookName(), 'stateRegistry', {});
}

export function saveStateRegistry(reg) {
    // Store the flat map as-is — same rationale as saveRegistry().
    writeField(getStateLorebookName(), 'stateRegistry', reg);
}

export function registerStateTracker(name, uid) {
    const reg = getStateRegistry();
    reg[name] = { uid, lastUpdatedMsg: 0, lastUpdatedAt: 0, enabled: true, alwaysUpdate: false };
    saveStateRegistry(reg);
}

export function unregisterStateTracker(name) {
    const reg = getStateRegistry();
    delete reg[name];
    saveStateRegistry(reg);
}

export function setStateTrackerEnabled(name, enabled) {
    const reg = getStateRegistry();
    if (reg[name]) { reg[name].enabled = enabled; saveStateRegistry(reg); }
}

export function setStateTrackerAlwaysUpdate(name, always) {
    const reg = getStateRegistry();
    if (reg[name]) { reg[name].alwaysUpdate = always; saveStateRegistry(reg); }
}

export function bumpStateTrackerTimestamp(name) {
    const reg = getStateRegistry();
    if (reg[name]) {
        reg[name].lastUpdatedMsg = getChat()?.length || 0;
        reg[name].lastUpdatedAt = Date.now();
        saveStateRegistry(reg);
    }
}

/**
 * Decrement every state tracker's `lastUpdatedMsg` by `removed`, clamped to >= 0.
 *
 * `lastUpdatedMsg` is stored as a raw chat length (`getChat()?.length`) at the
 * time of the last update. After a bulk delete shrinks the chat, that stored
 * length points past the end of the new (shorter) chat. The cooldown check
 * (`currentMsgIdx - lastUpdatedMsg < cooldownMsgs`) then keeps skipping the
 * tracker forever — the chat has to re-grow past the stale length before the
 * tracker runs again. This keeps the stored watermark aligned with the
 * shorter chat so the cooldown math stays meaningful.
 *
 * @param {number} removed — how many messages were deleted
 */
export function adjustStateTrackerLastUpdatedMsg(removed) {
    if (!Number.isFinite(removed) || removed <= 0) return;
    const reg = getStateRegistry();
    let changed = false;
    for (const name of Object.keys(reg)) {
        const cur = reg[name]?.lastUpdatedMsg;
        if (typeof cur === 'number' && cur > 0) {
            reg[name].lastUpdatedMsg = Math.max(0, cur - removed);
            changed = true;
        }
    }
    if (changed) saveStateRegistry(reg);
}
