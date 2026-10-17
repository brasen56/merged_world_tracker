/**
 * Reusable Phase 0 fixtures for the Knowledge concision roadmap
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md, Phase 0).
 *
 * Three fixture families matching the plan's Phase 0 work items:
 *
 *   1. Field-discipline scenarios — the reported Role and Read on PC examples,
 *      an unknown Role, an enduring relationship role, a mayoral transition,
 *      and temporary tasks that must not change Role or inflate Current Agenda.
 *   2. Ledger coverage records — duplicates and overlaps, all five
 *      provenance classes, rumor, a correction pair, meaningful dates,
 *      another person's promise, legacy own-plan lines, the gate code 7314,
 *      and technical details that remain useful knowledge.
 *   3. Format/boundary documents — CRLF/LF, trailing-newline variants, the
 *      managed relationship block, the empty-ledger placeholder, compact
 *      entries, duplicate/missing ledger headings, and malformed boundaries.
 *
 * Plus deterministic builders for a representative ~15,000-token entry and a
 * deliberately oversized one (Phase 5 evidence). The reported 15,118-token
 * figure is a user report, not a measured project benchmark; sizes produced
 * here are estimates under the documented heuristic below, not measurements.
 *
 * Deliberately plain data with no imports, like the other Phase 0 fixture
 * files — later phases can use these for prompt, contract, parsing, and
 * review tests without a SillyTavern host. Entry shapes mirror
 * formatDossierEntry/formatMajorEntry in knowledge/lorebook.js; ledger items
 * render as "- fact via source — date" (em dash before the date, exactly as
 * formatLedgerLine writes it).
 */

// ─── Shared building blocks ──────────────────────────────────────────────────

/** The gate code named by the implementation plan; must survive condensation. */
export const GATE_CODE = '7314';

/** Managed relationship block markers (knowledge/state.js). */
export const RELATIONSHIP_BLOCK_START = '<!-- mwt:relationships:start -->';
export const RELATIONSHIP_BLOCK_END = '<!-- mwt:relationships:end -->';

/**
 * Render one ledger record exactly as formatLedgerLine (knowledge/lorebook.js)
 * writes it: "- <fact> via <source> — <date>", date clause omitted when absent.
 * @param {{fact: string, source?: string, date?: string}} record
 * @returns {string}
 */
export function renderLedgerLine(record) {
    return `- ${record.fact} via ${record.source || 'unknown'}${record.date ? ' — ' + record.date : ''}`;
}

/**
 * @param {Array<{fact: string, source?: string, date?: string}>} records
 * @returns {string[]}
 */
export function renderLedgerLines(records) {
    return (Array.isArray(records) ? records : []).map(renderLedgerLine);
}

/**
 * Minimal local mirror of formatDossierEntry (knowledge/lorebook.js) so these
 * fixtures stay import-free: header line, Tone/Perceived as/First seen, the
 * supplied dossier fields in the given order, blank line, ledger heading,
 * ledger items (or the empty placeholder).
 *
 * @param {object} [opts]
 * @param {string} [opts.npc] @param {string} [opts.species]
 * @param {string} [opts.descriptor] @param {string} [opts.tone]
 * @param {string} [opts.perceivedAs] @param {string} [opts.firstSeen]
 * @param {Array<[string, string]>} [opts.fields] ordered [label, value] pairs
 * @param {Array<{fact: string, source?: string, date?: string}>} [opts.records]
 * @param {boolean} [opts.emptyLedgerPlaceholder] write "- (no entries yet)"
 * @param {boolean} [opts.omitLedger] omit the ledger section entirely
 * @returns {string}
 */
export function buildDossierDocument({
    npc = 'Ezra Blackwell',
    species = 'Human',
    descriptor = 'compact harbour clerk',
    tone = 'quiet, precise',
    perceivedAs = 'unflappable paper-pusher',
    firstSeen = 'Harbour office, Day 1',
    fields = [],
    records = [],
    emptyLedgerPlaceholder = false,
    omitLedger = false,
} = {}) {
    const lines = [
        `[Dossier] ${npc} | ${species} | ${descriptor}`,
        `Tone: ${tone}`,
        `Perceived as: ${perceivedAs}`,
        `First seen: ${firstSeen}`,
    ];
    for (const [label, value] of fields) {
        if (value != null && value !== '') lines.push(`${label}: ${value}`);
    }
    if (!omitLedger) {
        lines.push('', 'Knowledge Ledger:');
        if (records.length > 0) lines.push(...renderLedgerLines(records));
        else if (emptyLedgerPlaceholder) lines.push('- (no entries yet)');
    }
    return lines.join('\n');
}

// ─── 1. Field-discipline scenarios ───────────────────────────────────────────
//
// Each scenario pairs a stored entry (`entryContent`, the state before a scan
// or update runs) with a model-shaped `scanUpdate` record (update_major shape:
// { name, fields, new_knowledge }). The `intent` strings document the
// discipline question the pair exists to answer; assertions belong to the
// Phase 1+ suites, not to the fixture file.

/** The reported Role line, verbatim from docs/KNOWLEDGE_CONCISION_SCOPE.md §1. */
export const REPORTED_ROLE_LINE =
    'Alex\'s boyfriend; Braun transmittal sent; co-signer of the amended weekend law; ' +
    'chock duty and photo-hanging at today\'s Kovach unload';

/** The reported Read on PC line, verbatim (doubled space included) from user
 * reporting 2026-10-16 — the same drift pattern aimed at Read on PC: events
 * involving the player instead of the NPC's assessment of the player. */
export const REPORTED_READ_ON_PC_LINE =
    'Kissed Alex for the fourth time; confessed the full wants list and the ugly fog-keeping detail aloud; ' +
    'Alex agreed to all terms without hesitation; Alex  went red to the collar from the kiss';

const REPORTED_ROLE_ENTRY_FIELDS = [
    ['Role', REPORTED_ROLE_LINE],
    ['Where to Find', 'The harbour office on Customs Row, weekdays'],
    ['Current Agenda', 'Keeping the harbour office running while Derek recovers'],
    ['Read on PC', 'Warm and a little protective; trusts Alex with the paperwork'],
];

const REPORTED_ROLE_LEDGER = [
    { fact: 'sent the Braun transmittal to the guild archive', source: 'witness', date: 'Day 203' },
    { fact: 'co-signed the amended weekend law', source: 'document', date: 'Day 210' },
];

const UNKNOWN_ROLE_LEDGER = [
    { fact: 'knows which quay crane needs a new cable', source: 'witness', date: 'Day 5' },
];

const ENDURING_RELATIONSHIP_LEDGER = [
    { fact: 'moved in with Alex above the chandlery', source: 'witness', date: 'Day 88' },
    { fact: 'introduced Alex to his mother at the harvest supper', source: 'witness', date: 'Day 120' },
];

const MAYOR_ENTRY_LEDGER = [
    { fact: 'kept the Greyrock quay ledgers for nine years', source: 'document', date: 'Day 1' },
];

const TEMPORARY_TASK_LEDGER = [
    { fact: 'holds a spare key to the harbour office', source: 'witness', date: 'Day 12' },
];

export const ROLE_SCENARIOS = Object.freeze({

    /** The reported case: a stored Role that has become a task/event inventory. */
    reportedRoleDrift: Object.freeze({
        npc: 'Ezra Blackwell',
        entryContent: buildDossierDocument({
            fields: REPORTED_ROLE_ENTRY_FIELDS,
            records: REPORTED_ROLE_LEDGER,
        }),
        scanUpdate: Object.freeze({
            name: 'Ezra Blackwell',
            fields: Object.freeze({
                tone: null,
                perceived_as: null,
                descriptor: null,
                role: 'Alex\'s boyfriend; manifest stamping and chock duty at today\'s Braun dock shift',
            }),
            new_knowledge: Object.freeze([
                Object.freeze({ fact: 'stamped the Braun dock manifests for the night shift', source: 'witness', date: 'Day 214' }),
            ]),
        }),
        intent: 'Stored example of Role drift (the reported case); the scan offers a FRESH drift instance. '
            + 'Prevention must not reproduce the pattern, and must not rewrite the stored value either.',
    }),

    /** The same drift pattern aimed at Read on PC: a log of interactions with
     * the player (and the player's reactions), not the NPC's stance. */
    readOnPcDrift: Object.freeze({
        npc: 'Ezra Blackwell',
        entryContent: buildDossierDocument({
            fields: [
                ['Role', 'Alex\'s boyfriend'],
                ['Read on PC', REPORTED_READ_ON_PC_LINE],
                ['Current Agenda', 'Saving for the chandlery lease renewal'],
            ],
            records: ENDURING_RELATIONSHIP_LEDGER,
        }),
        scanUpdate: Object.freeze({
            name: 'Ezra Blackwell',
            fields: Object.freeze({
                tone: null,
                perceived_as: null,
                descriptor: null,
                role: null,
                // Fresh drift: interaction events and the player's reaction —
                // none of it the NPC's assessment of the player.
                read_on_pc: 'Held Alex through the fog-bell ringing; Alex whispered the harbour secret against his collar; Alex squeezed his hand at the gate',
            }),
            new_knowledge: Object.freeze([
                Object.freeze({ fact: 'kissed Alex at the fog-bell ringing, the fourth time', source: 'witness', date: 'Day 216' }),
            ]),
        }),
        intent: 'Read on PC holds the NPC\'s current stance toward the player, never an interaction log — '
            + 'the events belong in the ledger as facts, and only the resulting view belongs here.',
    }),

    /** No established role: preserve the unknown/missing convention, invent nothing. */
    unknownRolePreserved: Object.freeze({
        npc: 'New Quayhand',
        entryContent: buildDossierDocument({
            npc: 'New Quayhand',
            descriptor: 'unnamed dock worker',
            fields: [['Role', 'unknown']],
            records: UNKNOWN_ROLE_LEDGER,
        }),
        // Variant where the scan left the field out entirely on creation, so
        // the entry never grew a Role line at all.
        entryContentWithoutRoleLine: buildDossierDocument({
            npc: 'New Quayhand',
            descriptor: 'unnamed dock worker',
            fields: [],
            records: UNKNOWN_ROLE_LEDGER,
        }),
        scanUpdate: Object.freeze({
            name: 'New Quayhand',
            fields: Object.freeze({
                tone: null,
                perceived_as: null,
                descriptor: null,
                // Today's chore is the only "role evidence" available — it is not one.
                role: 'helping unload the Kovach barge today',
            }),
            new_knowledge: Object.freeze([
                Object.freeze({ fact: 'spliced the Kovach barge mooring lines without being asked', source: 'witness', date: 'Day 6' }),
            ]),
        }),
        intent: 'A temporary chore is not role evidence. Role stays unknown/missing rather than being '
            + 'invented from the only available activity.',
    }),

    /** "Alex's boyfriend" alone is a legitimate primary story function. */
    enduringRelationshipRole: Object.freeze({
        npc: 'Ezra Blackwell',
        entryContent: buildDossierDocument({
            fields: [
                ['Role', 'Alex\'s boyfriend'],
                ['Current Agenda', 'Saving for the chandlery lease renewal'],
            ],
            records: ENDURING_RELATIONSHIP_LEDGER,
        }),
        scanUpdate: Object.freeze({
            name: 'Ezra Blackwell',
            fields: Object.freeze({
                tone: null,
                perceived_as: null,
                descriptor: null,
                // Legitimate role, but the model keeps appending event clauses to it.
                role: 'Alex\'s boyfriend; attended the Kovach picnic with Alex',
            }),
            new_knowledge: Object.freeze([
                Object.freeze({ fact: 'won the picnic raffle\'s second prize, a brass compass', source: 'witness', date: 'Day 128' }),
            ]),
        }),
        intent: 'A relationship-only Role is legitimate and stable. Append-clause drift on a legitimate '
            + 'role is still drift: prefer the current concise value, not accumulated clauses.',
    }),

    /** A meaningful change: winning the mayoral election updates Role. */
    mayorTransition: Object.freeze({
        npc: 'Mara Voss',
        entryContent: buildDossierDocument({
            npc: 'Mara Voss',
            descriptor: 'weathered harbourmaster',
            tone: 'brine-rough, direct',
            perceivedAs: 'the quay\'s unofficial law',
            firstSeen: 'Greyrock quay, Day 1',
            fields: [
                ['Role', 'harbourmaster of Greyrock quay'],
                ['Current Agenda', 'Clearing the backlog of quay maintenance orders'],
            ],
            records: MAYOR_ENTRY_LEDGER,
        }),
        scanUpdate: Object.freeze({
            name: 'Mara Voss',
            fields: Object.freeze({
                tone: null,
                perceived_as: null,
                descriptor: null,
                role: 'Mayor of Greyrock',
            }),
            new_knowledge: Object.freeze([
                Object.freeze({ fact: 'won the Greyrock mayoral election by sixty votes', source: 'institutional', date: 'Day 412' }),
                Object.freeze({ fact: 'was sworn in at the guild hall', source: 'witness', date: 'Day 414' }),
            ]),
        }),
        intent: 'Role is stable until a MEANINGFUL change, not permanent: an established new office is a '
            + 'legitimate Role update; hanging pictures for an afternoon is not.',
    }),

    /** Today's chores must not change Role or inflate Current Agenda. */
    temporaryTasks: Object.freeze({
        npc: 'Ezra Blackwell',
        entryContent: buildDossierDocument({
            fields: [
                ['Role', 'Alex\'s boyfriend'],
                ['Current Agenda', 'Keeping the harbour office running while Derek recovers'],
            ],
            records: TEMPORARY_TASK_LEDGER,
        }),
        scanUpdate: Object.freeze({
            name: 'Ezra Blackwell',
            fields: Object.freeze({
                tone: null,
                perceived_as: null,
                descriptor: null,
                role: 'chock duty and photo-hanging at today\'s Kovach unload',
                agenda: 'hang the crew photos, then chock duty until the Kovach unload finishes',
            }),
            new_knowledge: Object.freeze([
                Object.freeze({ fact: 'hung the recovered crew photos in the harbour office', source: 'witness', date: 'Day 215' }),
            ]),
        }),
        intent: 'Temporary tasks are neither Role nor Current Agenda material; only the completed fact '
            + 'belongs, as one durable ledger line.',
    }),
});

/**
 * @param {string} id one of the ROLE_SCENARIOS keys
 * @returns {object} a detached structuredClone the caller may mutate
 */
export function cloneRoleScenario(id) {
    const scenario = ROLE_SCENARIOS[id];
    if (!scenario) throw new Error(`unknown role scenario: ${id}`);
    return structuredClone(scenario);
}

// ─── 2. Ledger coverage records ──────────────────────────────────────────────
//
// One record per knowledge-preservation case the plan calls out. Stable `id`s
// so later suites can cite cases by name. Order is significant: it exercises
// chronology (an old belief before its correction, duplicates spread out).
// Dates are load-bearing: the duplicate pairs share their observation date
// (whole-record duplicates — merging them loses nothing), while the overlap
// pair and the correction pair deliberately carry DIVERGENT dates (Day 30
// told vs Day 31 witness). A merge must preserve those distinct dates and
// attributions, not flatten them into a timeless assertion.
export const LEDGER_COVERAGE_RECORDS = Object.freeze([
    Object.freeze({ id: 'witness-ferry', fact: 'saw the Ash Fox board the night ferry without a ticket', source: 'witness', date: 'Day 12' }),
    Object.freeze({ id: 'duplicate-key-1', fact: 'keeps a spare key taped under the harbour office drawer', source: 'witness', date: 'Day 12' }),
    Object.freeze({ id: 'duplicate-key-2', fact: 'keeps a spare key taped under the harbour office drawer', source: 'witness', date: 'Day 12' }),
    Object.freeze({ id: 'duplicate-debt-1', fact: 'Derek still owes the guild forty crowns', source: 'told', date: 'Day 15' }),
    Object.freeze({ id: 'duplicate-debt-2', fact: 'Derek\'s debt to the guild stands at 40 crowns', source: 'told', date: 'Day 15' }),
    Object.freeze({ id: 'overlap-gate-code', fact: `knows the east gate code is ${GATE_CODE}`, source: 'told', date: 'Day 30' }),
    Object.freeze({ id: 'overlap-gate-code-rich', fact: `knows the east gate code is ${GATE_CODE} and that the guard changes at dusk`, source: 'witness', date: 'Day 31' }),
    Object.freeze({ id: 'correction-west-gate-old', fact: 'heard the west gate code was 1402', source: 'told', date: 'Day 30' }),
    Object.freeze({ id: 'correction-west-gate-new', fact: `saw the west gate code punched in is ${GATE_CODE}`, source: 'witness', date: 'Day 31' }),
    Object.freeze({ id: 'told-reliquary', fact: 'heard from Sister Vale that the reliquary on display is a replica', source: 'told', date: 'Day 40' }),
    Object.freeze({ id: 'document-manifest', fact: 'read the customs manifest listing Braun as consignee of the Kovach crates', source: 'document', date: 'Day 41' }),
    Object.freeze({ id: 'rumor-warden', fact: 'rumour says Warden Cole takes coin from the smugglers', source: 'rumor', date: 'Day 42' }),
    Object.freeze({ id: 'institutional-journeyman', fact: 'the guild registered Alex as a journeyman locksmith', source: 'institutional', date: 'Day 45' }),
    Object.freeze({ id: 'promise-dorothy', fact: 'Dorothy promised to arrive Monday', source: 'told', date: 'Day 46' }),
    // Legacy own-plan lines: rejected by today's prompts, but older entries
    // still carry them. Cleanup must keep them represented and flag them, not
    // silently drop them (scope §4.3).
    Object.freeze({ id: 'legacy-plan-repaint', fact: 'plans to repaint the harbour office next week', source: '', date: '' }),
    Object.freeze({ id: 'legacy-plan-informant', fact: 'will meet the informant at the docks after dark', source: '', date: '' }),
    Object.freeze({ id: 'legacy-commitment-cosign', fact: 'agreed to co-sign the amended weekend law', source: '', date: '' }),
    // Technical details that remain useful knowledge, and the automotive case
    // the scope condensed by hand (§4.2) — three specific originals plus the
    // scope's proposed merged record, for detail-retention warning tests.
    Object.freeze({ id: 'technical-gnx', fact: 'can recite the GNX stage-2 chip and 4.1L stroker specifications from memory', source: 'witness', date: 'July 2, 2000' }),
    Object.freeze({ id: 'technical-ls1', fact: 'quoted the LS1/Trans Am WS6 ram-air intake and head-port specs unprompted', source: 'witness', date: 'July 2, 2000' }),
    Object.freeze({ id: 'technical-20b', fact: 'explained the 20B rotary swap\'s port timing and adapter-plate choices for the Braun coupe', source: 'witness', date: 'July 2, 2000' }),
    Object.freeze({ id: 'uncertainty-ferry', fact: 'thinks the night ferry may stop running after harvest, but is not sure', source: 'told', date: 'Day 48' }),
    Object.freeze({ id: 'date-quay-deed', fact: 'signed the quay deed over to the harbour guild', source: 'witness', date: 'March 3, 2026' }),
]);

/**
 * The scope §4.2 worked example: a proposed merged record for the three
 * automotive `technical-*` originals, verbatim in substance. "Expert" is a
 * STRONGER claim than the originals make — detail-warning tests should be
 * able to surface that distinction, not just missing model names.
 */
export const CONDENSATION_EXAMPLE = Object.freeze({
    sourceIds: Object.freeze(['technical-gnx', 'technical-ls1', 'technical-20b']),
    proposed: Object.freeze({
        fact: 'demonstrated expert automotive knowledge, recalling detailed performance and tuning '
            + 'specifications for the GNX, LS1/Trans Am WS6, and 20B rotary swaps',
        source: 'witness',
        date: 'July 2, 2000',
    }),
});

/** @returns {object[]} detached copies of LEDGER_COVERAGE_RECORDS */
export function cloneLedgerCoverageRecords() {
    return structuredClone(LEDGER_COVERAGE_RECORDS.map(({ id, ...record }) => record));
}

// ─── 3. Format and boundary documents ────────────────────────────────────────

const CANONICAL_FIELDS = [
    ['Role', 'harbour office clerk'],
    ['Where to Find', 'The harbour office on Customs Row, weekdays'],
    ['Appearance', 'Compact build, ink-stained cuffs, reading glasses on a chain.'],
    ['Voice', 'Dry and exact; punctuates with ledger references.'],
    ['Background', 'Nine years keeping the Greyrock quay ledgers. Took over the office when Derek was injured.'],
    ['Read on PC', 'Warm and a little protective; trusts Alex with the paperwork.'],
    ['Current Agenda', 'Keeping the harbour office running while Derek recovers'],
];

const CANONICAL_RECORDS = [
    { fact: 'holds a spare key to the harbour office', source: 'witness', date: 'Day 12' },
    { fact: `knows the east gate code is ${GATE_CODE}`, source: 'told', date: 'Day 30' },
    { fact: 'Dorothy promised to arrive Monday', source: 'told', date: 'Day 46' },
];

const RELATIONSHIP_BLOCK = [
    RELATIONSHIP_BLOCK_START,
    'Stance toward {{user}}: friendly.',
    'Relationships: employee of Derek Sandhorn; friend of Mara Voss.',
    RELATIONSHIP_BLOCK_END,
].join('\n');

/** Convert a document's LF line endings to CRLF, leaving a trailing newline intact. */
export function toCRLF(text) {
    return text.replace(/\r?\n/g, '\r\n');
}

/** Append (or remove) exactly one trailing newline. */
export function withTrailingNewline(text, enabled = true) {
    const base = text.replace(/\r?\n$/, '');
    return enabled ? `${base}\n` : base;
}

/**
 * The format/boundary corpus. Keys ending in `Entry` are full entry contents.
 * The supported/unsupported classification for cleanup is recorded in
 * docs/KNOWLEDGE_CONCISION_DECISIONS.md (D6); these documents are the inputs
 * that decision (and the Phase 2 boundary parser) must handle.
 */
export const KNOWLEDGE_CONCISION_DOCUMENTS = Object.freeze({

    /** Well-formed dossier entry, LF endings, no trailing newline (what the formatters write). */
    canonicalDossierEntry: buildDossierDocument({ fields: CANONICAL_FIELDS, records: CANONICAL_RECORDS }),

    /** Same entry with CRLF endings — cleanup must preserve them on rewrite. */
    crlfDossierEntry: toCRLF(buildDossierDocument({ fields: CANONICAL_FIELDS, records: CANONICAL_RECORDS })),

    /** Same entry with a trailing final newline. */
    trailingNewlineDossierEntry: withTrailingNewline(buildDossierDocument({ fields: CANONICAL_FIELDS, records: CANONICAL_RECORDS })),

    /** Ledger section present but empty: the placeholder written on creation/promotion. */
    emptyLedgerPlaceholderEntry: buildDossierDocument({ fields: CANONICAL_FIELDS, records: [], emptyLedgerPlaceholder: true }),

    /** Compact (non-dossier) major entry — ledger condensation is header-agnostic. */
    compactMajorEntry: [
        'Ezra Blackwell | Human | compact harbour clerk',
        'Tone: quiet, precise',
        'Perceived as: unflappable paper-pusher',
        'First seen: Harbour office, Day 1',
        '',
        'Knowledge Ledger:',
        ...renderLedgerLines(CANONICAL_RECORDS),
    ].join('\n'),

    /** Ledger followed by a managed relationship block: the block ends the section and must stay byte-identical. */
    relationshipBlockDossierEntry: [
        buildDossierDocument({ fields: CANONICAL_FIELDS, records: CANONICAL_RECORDS }),
        '',
        RELATIONSHIP_BLOCK,
    ].join('\n'),

    /** Lowercase heading — supported, the header matches case-insensitively. */
    lowercaseHeadingEntry: buildDossierDocument({ fields: CANONICAL_FIELDS, records: CANONICAL_RECORDS })
        .replace('Knowledge Ledger:', 'knowledge ledger:'),

    /** AMBIGUOUS: two ledger headings — which section is the ledger? */
    duplicateLedgerHeadingsEntry: [
        buildDossierDocument({
            fields: CANONICAL_FIELDS.slice(0, 2),
            records: CANONICAL_RECORDS.slice(0, 1),
        }),
        '',
        'Knowledge Ledger:',
        ...renderLedgerLines(CANONICAL_RECORDS.slice(1)),
    ].join('\n'),

    /** AMBIGUOUS: item-shaped lines exist but no heading marks the section. */
    missingLedgerHeadingEntry: [
        buildDossierDocument({ fields: CANONICAL_FIELDS.slice(0, 2), records: [], omitLedger: true }),
        '',
        ...renderLedgerLines(CANONICAL_RECORDS),
    ].join('\n'),

    /** AMBIGUOUS: the heading line carries extra text after the colon. */
    headingWithTrailingTextEntry: buildDossierDocument({ fields: CANONICAL_FIELDS, records: CANONICAL_RECORDS })
        .replace('Knowledge Ledger:', 'Knowledge Ledger: (older entries below)'),

    /** AMBIGUOUS: prose inside the section splits the item run; items after it fall outside the parseable section. */
    proseInsideSectionEntry: [
        buildDossierDocument({ fields: CANONICAL_FIELDS.slice(0, 2), records: [], omitLedger: true }),
        '',
        'Knowledge Ledger:',
        ...renderLedgerLines(CANONICAL_RECORDS.slice(0, 1)),
        'The following entries were copied from Derek\'s old notebook.',
        ...renderLedgerLines(CANONICAL_RECORDS.slice(1)),
    ].join('\n'),
});

/** @returns {string} detached copy of a document (strings are immutable; kept for API symmetry). */
export function cloneDocument(id) {
    const doc = KNOWLEDGE_CONCISION_DOCUMENTS[id];
    if (doc === undefined) throw new Error(`unknown document fixture: ${id}`);
    return doc;
}

// ─── 4. Representative-size builders ─────────────────────────────────────────
//
// Deterministic synthetic entries for Phase 5's representative-size evidence.
// Sizes are ESTIMATES under the same chars-per-token fallback
// core/context.js uses (FALLBACK_CHARS_PER_TOKEN = 4.5); the host tokenizer,
// when present, will disagree, which is exactly why every size shown to users
// must be labelled an estimate. Nothing here is a provider measurement.

/** Mirrors core/context.js FALLBACK_CHARS_PER_TOKEN. */
export const FIXTURE_CHARS_PER_TOKEN = 4.5;

/**
 * Estimate tokens for fixture sizing — the same arithmetic as
 * core/context.js estimateTokens when no tokenizer is available.
 * @param {string} text
 * @returns {number}
 */
export function estimateFixtureTokens(text) {
    return (!text || typeof text !== 'string') ? 0 : Math.ceil(text.length / FIXTURE_CHARS_PER_TOKEN);
}

export const REPRESENTATIVE_TARGET_TOKENS = 15000;
export const REPRESENTATIVE_TOKEN_TOLERANCE = 500;
export const OVERSIZE_TARGET_TOKENS = 30000;
/** Any entry estimated above this must be refused by cleanup preflight in tests. */
export const OVERSIZE_REFUSAL_FLOOR_TOKENS = 25000;

/**
 * Deterministic fact generator. Two phrasings per kind produce reworded
 * duplicates (same fact, different wording) when `variant` alternates. Every
 * kind embeds a number, code, name, or date so Phase 2's detail-retention
 * heuristics (numbers/codes/dates/names) have signal on every line.
 *
 * @param {number} i zero-based ledger line index
 * @param {number} [variant] 0 or 1 — alternate phrasing of the same fact
 * @returns {string}
 */
function representativeFact(i, variant = 0) {
    const code = 7000 + ((i * 17) % 900);
    const crowns = 100 + ((i * 37) % 900);
    const day = 100 + i;
    switch (i % 6) {
        case 0: return variant === 0
            ? `memorised the tariff schedule for quay ${i}: ${crowns} crowns per crate`
            : `can recite quay ${i}'s tariff schedule of ${crowns} crowns per crate from memory`;
        case 1: return variant === 0
            ? `knows the access code for gate sector ${i} is ${code}`
            : `is aware that gate sector ${i}'s access code is ${code}`;
        case 2: return variant === 0
            ? `logged pilot R. Kellam's berth-${i} assignment on the Day ${day} rotation`
            : `recorded that pilot R. Kellam was assigned berth ${i} in the Day ${day} rotation`;
        case 3: return variant === 0
            ? `witnessed the Harrow & Sons barge ${i} discharge its ballast before dusk`
            : `saw barge ${i} of Harrow & Sons pump out its ballast before dusk`;
        case 4: return variant === 0
            ? `filed the insurance claim for winch ${i} citing ${crowns} crowns of damage`
            : `submitted winch ${i}'s damage claim of ${crowns} crowns to the insurers`;
        default: return variant === 0
            ? `checked the tide table entry for slip ${i} against the almanac of Day ${day}`
            : `verified slip ${i}'s almanac tide entry for Day ${day}`;
    }
}

/**
 * Build a deterministic synthetic dossier whose ledger is sized to an
 * estimated token target.
 *
 * Duplicate semantics: a duplicate slot rewords an ORIGINAL record that was
 * actually emitted earlier — `records[i].duplicateOf` gives that original's
 * slot — and keeps that original's observation date, so each pair is a
 * whole-record duplicate (same fact, same date, different wording; merging
 * the two loses nothing). Date-divergent re-reports (the same fact observed
 * on different days) are a different, deliberate case, covered by the
 * `overlap-*` records in LEDGER_COVERAGE_RECORDS.
 *
 * @param {object} [opts]
 * @param {number} [opts.targetTokens] estimated size to reach
 * @param {number} [opts.duplicateEvery] every Nth line rewords an earlier
 *   emitted original (0 disables — the "high distinct fact" mode that cannot
 *   safely shrink much). Default 17 for a realistic duplicate density.
 * @returns {{content: string, estimatedTokens: number, ledgerLineCount: number,
 *   duplicateLineCount: number, records: Array<{fact: string, source: string,
 *   date: string, slot: number, duplicateOf: number|null}>}}
 */
export function buildRepresentativeLedgerEntry({
    targetTokens = REPRESENTATIVE_TARGET_TOKENS,
    duplicateEvery = 17,
} = {}) {
    const lines = [
        '[Dossier] Ilyan Petrov | Human | gravel-voiced harbour bailiff',
        'Tone: clipped, formal',
        'Perceived as: the quay\'s long memory',
        'First seen: Greyrock customs house, Day 1',
        'Role: harbour bailiff for the Greyrock customs house',
        'Where to Find: The customs house counter, dawn to dusk',
        'Appearance: Grey-streaked beard, brass-buttoned coat, a limp in the left knee.',
        'Voice: Naval cadence; cites ordinance numbers mid-sentence.',
        'Background: Thirty years a customs bailiff. Survived the ferrycrash of \'98. Keeps the quay\'s oldest records.',
        'Read on PC: Respectful, slightly suspicious of landlubbers.',
        'Current Agenda: Auditing the quay\'s oldest records',
        '',
        'Knowledge Ledger:',
    ];
    const records = [];
    const originals = [];
    let lengthSoFar = lines.join('\n').length;
    const tokensFromLength = (n) => Math.ceil(n / FIXTURE_CHARS_PER_TOKEN);
    for (let slot = 0; ; slot++) {
        const isDuplicateSlot = duplicateEvery > 0 && slot >= duplicateEvery && slot % duplicateEvery === 0;
        let fact;
        let date;
        let duplicateOf = null;
        if (isDuplicateSlot) {
            // Reword an ORIGINAL that was actually emitted — the k-th
            // duplicate slot targets original #(k * 7 mod originals), so the
            // targets scatter instead of clustering on the newest lines, and
            // every target is an already-emitted, earlier record.
            const k = slot / duplicateEvery;
            const target = originals[(k * 7) % originals.length];
            fact = representativeFact(target.template, 1);
            date = target.record.date;
            duplicateOf = target.record.slot;
        } else {
            fact = representativeFact(slot);
            date = `Day ${100 + slot}`;
        }
        const line = renderLedgerLine({ fact, source: 'witness', date });
        // Stop before overshooting the target band; a header-only entry is the floor.
        if (tokensFromLength(lengthSoFar + 1 + line.length) > targetTokens + REPRESENTATIVE_TOKEN_TOLERANCE) break;
        const record = { fact, source: 'witness', date, slot, duplicateOf };
        records.push(record);
        if (duplicateOf === null) originals.push({ record, template: slot });
        lines.push(line);
        lengthSoFar += 1 + line.length;
        if (tokensFromLength(lengthSoFar) >= targetTokens) break;
    }
    const content = lines.join('\n');
    return {
        content,
        estimatedTokens: estimateFixtureTokens(content),
        ledgerLineCount: records.length,
        duplicateLineCount: records.filter(r => r.duplicateOf !== null).length,
        records,
    };
}

/**
 * The Phase 5 "cannot safely shrink much" case: every line is a distinct fact
 * with its own number/code/date, so no merge is safe and detail warnings fire
 * on any summary.
 * @param {number} [targetTokens]
 */
export function buildHighDistinctFactEntry(targetTokens = REPRESENTATIVE_TARGET_TOKENS) {
    return buildRepresentativeLedgerEntry({ targetTokens, duplicateEvery: 0 });
}

/** The deliberately oversized case: cleanup preflight must refuse it. */
export function buildOversizedLedgerEntry() {
    return buildRepresentativeLedgerEntry({ targetTokens: OVERSIZE_TARGET_TOKENS });
}
