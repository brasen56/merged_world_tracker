/**
 * Pure parsing, validation, patching, and projection helpers for the Markdown
 * World State document. This module deliberately has no feature-module,
 * persistence, settings, DOM, or SillyTavern dependencies.
 */

export const WORLD_STATE_SECTIONS = Object.freeze([
    'Current Scene',
    'Recent Changes',
    'Off-Screen',
    'Pending',
    'Active Threads',
    'Unresolved Threads',
    'World Pressures',
    'Key Character States',
    'Story Momentum',
    'Plot Seeds',
    'Potential Entrances',
]);

export const WORLD_STATE_FACTUAL_SECTIONS = Object.freeze(WORLD_STATE_SECTIONS.slice(0, 8));
export const WORLD_STATE_HOOK_SECTIONS = Object.freeze(WORLD_STATE_SECTIONS.slice(8));
export const CURRENT_SCENE_FIELDS = Object.freeze(['Date', 'Time', 'Location', 'Present', 'Situation']);
// A scalar field must remain present even when no character is established to
// be in the scene. This explicit value avoids treating an empty field as a
// malformed document while keeping the parsed roster unambiguous.
export const EMPTY_PRESENT_VALUE = 'None';

// This section is produced by the existing expiry feature. It is readable for
// compatibility, but intentionally excluded from every prompt projection.
export const WORLD_STATE_ARCHIVE_SECTION = 'Archive (Stale)';

const KNOWN_SECTION_SET = new Set([...WORLD_STATE_SECTIONS, WORLD_STATE_ARCHIVE_SECTION]);
const WORLD_STATE_HOOK_SECTION_SET = new Set(WORLD_STATE_HOOK_SECTIONS.map(name => name.toLowerCase()));
const FIELD_KEY_BY_LABEL = Object.freeze(Object.fromEntries(
    CURRENT_SCENE_FIELDS.map(label => [label, label.toLowerCase()]),
));

function issue(code, message, details = {}) {
    return { code, severity: 'error', message, ...details };
}

function asText(text) {
    return typeof text === 'string' ? text : '';
}

/**
 * Parse line-anchored level-two sections without changing the input.
 *
 * Known duplicate and unknown headers are reported, but all sections remain in
 * the result so legacy documents can still be inspected without being rewritten.
 */
export function parseWorldStateSections(text) {
    const source = asText(text);
    const headers = [];
    const headerRe = /^##[ \t]+([^\r\n]*?)[ \t]*(?:\r?\n|$)/gm;
    let match;
    while ((match = headerRe.exec(source)) !== null) {
        headers.push({
            name: match[1],
            header: match[0].replace(/\r?\n$/, ''),
            start: match.index,
            headerEnd: match.index + match[0].length,
        });
        if (!match[0].length) headerRe.lastIndex++;
    }

    const issues = [];
    const counts = new Map();
    const sections = headers.map((header, index) => {
        const end = headers[index + 1]?.start ?? source.length;
        const known = KNOWN_SECTION_SET.has(header.name);
        const occurrence = (counts.get(header.name) || 0) + 1;
        counts.set(header.name, occurrence);
        if (!known) {
            issues.push(issue('unknown-section', `Unknown World State section "${header.name}".`, {
                section: header.name,
            }));
        } else if (occurrence > 1) {
            issues.push(issue('duplicate-section', `Section "${header.name}" occurs more than once.`, {
                section: header.name,
            }));
        }
        return {
            ...header,
            end,
            known,
            occurrence,
            body: source.slice(header.headerEnd, end),
            raw: source.slice(header.start, end),
        };
    });

    return {
        text: source,
        lineEnding: source.includes('\r\n') ? '\r\n' : '\n',
        preamble: source.slice(0, headers[0]?.start ?? source.length),
        sections,
        issues,
    };
}

/** Return whether a section name belongs to the optional narrative-hook view. */
export function isWorldStateHookSection(name) {
    return typeof name === 'string' && WORLD_STATE_HOOK_SECTION_SET.has(name.toLowerCase());
}

function splitPresentNames(value, { splitBareConjunctions = false } = {}) {
    if (String(value ?? '').trim().toLowerCase() === EMPTY_PRESENT_VALUE.toLowerCase()) return [];
    const seen = new Set();
    const names = [];
    const separator = splitBareConjunctions ? /[,;]|\band\b/i : /[,;]/;
    for (const part of String(value ?? '').split(separator)) {
        // A conjunction at the start of a comma/semicolon-delimited item is
        // list grammar (including the Oxford-comma form), not part of a name.
        // A bare conjunction inside an item may be part of a real name, so
        // write normalization preserves it unless this is a tolerant read.
        const name = part.trim().replace(/^(?:and|&)\s+/i, '').replace(/\s+/g, ' ');
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

function inspectPresentValue(value, options = {}) {
    const source = Array.isArray(value) ? value.join(', ') : asText(value);
    let cleaned = '';
    const stack = [];
    let delimiterIssue = null;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char === '(' || char === '[') {
            stack.push({ char, index });
        } else if (char === ')' || char === ']') {
            const expected = char === ')' ? '(' : '[';
            const opener = stack.at(-1);
            if (!opener || opener.char !== expected) {
                delimiterIssue = {
                    kind: opener ? 'mismatched' : 'unmatched-closer',
                    index,
                    delimiter: char,
                    opener: opener?.char,
                };
                break;
            }
            stack.pop();
        } else if (stack.length === 0) {
            cleaned += char;
        }
    }

    if (!delimiterIssue && stack.length) {
        const opener = stack.at(-1);
        delimiterIssue = {
            kind: 'unmatched-opener',
            index: opener.index,
            delimiter: opener.char,
        };
    }

    // Never return the partially stripped value when delimiters are malformed:
    // doing so can erase every roster entry after an unmatched opener.
    return {
        names: splitPresentNames(delimiterIssue ? source : cleaned, options),
        delimiterIssue,
    };
}

/**
 * Remove parenthetical/bracketed annotations before splitting on commas.
 * Nested annotations are supported. Exact duplicate names are removed while
 * source order and linguistically unusual names are preserved. Malformed
 * annotations are retained conservatively; parseCurrentScene reports them.
 */
export function normalizePresentValue(value, options = {}) {
    return inspectPresentValue(value, options).names;
}

const QUALITATIVE_TIMES = [
    'late afternoon', 'early afternoon', 'late morning', 'early morning',
    'dawn', 'morning', 'noon', 'afternoon', 'evening', 'dusk', 'night', 'midnight',
];
// A 24-hour clock never has a meridiem suffix. Keeping the formats separate
// prevents contradictory values such as "14:30pm" from being normalized.
const CLOCK_AT_END_RE = /(?:^|[\s,]+)((?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?(?:m\.?)?))$/i;
// Check this only after CLOCK_AT_END_RE: it identifies clock-shaped suffixes
// which look date-like because of their digits but are not valid clocks.
const INVALID_CLOCK_AT_END_RE = /(?:^|[\s,]+)(?:\d{1,2}:\d{2}(?:\s*[ap]\.?(?:m\.?)?)?|\d{1,2}\s*[ap]\.?(?:m\.?)?)$/i;
const ANCHOR_TAIL_CHARS = 64;
const AMBIGUOUS_TIME_PROSE_RE = /\b(?:about|around|approximately|approx\.?|roughly|nearly|circa|after|before)\b/i;

function looksLikeDate(value) {
    return /\d/.test(value)
        || /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|yesterday|year|eve|day)\b/i.test(value);
}

function compactLocationWins(current, offered) {
    if (!current || !offered || offered.length <= current.length) return false;
    const compact = value => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
        .filter(word => word && !['a', 'an', 'the', 'at', 'in', 'on', 'of'].includes(word));
    const currentWords = compact(current);
    const offeredWords = compact(offered);
    if (!currentWords.length || currentWords.length > offeredWords.length) return false;
    return offeredWords.some((_, start) => currentWords.every(
        (word, offset) => offeredWords[start + offset] === word,
    ));
}

/**
 * Normalize Chronicle's combined Time Anchor into a safe Current Scene patch.
 * Ambiguous values fail closed: the current Date/Time are retained and a
 * warning is returned instead of manufacturing precision.
 */
export function normalizeSceneAnchor({ dateTime, location, current = {} } = {}) {
    const patch = {};
    const warnings = [];
    const anchor = typeof dateTime === 'string' ? dateTime.trim() : '';
    if (anchor) {
        if (/^unknown$/i.test(anchor)) {
            patch.date = 'Unknown';
        } else if (AMBIGUOUS_TIME_PROSE_RE.test(anchor)) {
            warnings.push({ code: 'ambiguous-date-time', message: `Could not safely split approximate Chronicle anchor "${anchor}".` });
        } else {
            // Bound the end-anchored clock search. Running a leading `\s+`
            // alternative over a model-produced 200k-space line is quadratic.
            const tail = anchor.length > ANCHOR_TAIL_CHARS ? anchor.slice(-ANCHOR_TAIL_CHARS) : anchor;
            const clock = tail.match(CLOCK_AT_END_RE);
            const qualitative = QUALITATIVE_TIMES.find(value =>
                anchor.toLowerCase() === value || anchor.toLowerCase().endsWith(` ${value}`));
            if (clock) {
                const time = clock[1].trim();
                const clockStart = anchor.length - tail.length + clock.index;
                const date = anchor.slice(0, clockStart).replace(/[\s,]+$/, '').trim();
                if (date) patch.date = date;
                patch.time = time;
            } else if (INVALID_CLOCK_AT_END_RE.test(tail)) {
                warnings.push({ code: 'invalid-clock', message: `Chronicle anchor "${anchor}" ends with an invalid or contradictory clock.` });
            } else if (qualitative) {
                const date = anchor.slice(0, anchor.length - qualitative.length).replace(/[\s,]+$/, '').trim();
                if (date) patch.date = date;
                patch.time = qualitative[0].toUpperCase() + qualitative.slice(1);
            } else if (looksLikeDate(anchor)) {
                patch.date = anchor;
            } else {
                warnings.push({ code: 'ambiguous-date-time', message: `Could not safely split Chronicle anchor "${anchor}".` });
            }
        }
    }

    const offeredLocation = typeof location === 'string' ? location.trim() : '';
    if (offeredLocation) {
        if (/\r|\n/.test(offeredLocation)) {
            warnings.push({ code: 'invalid-location', message: 'Chronicle location was not a single line.' });
        } else if (!compactLocationWins(current.location, offeredLocation)) {
            patch.location = offeredLocation;
        }
    }
    return { ok: Object.keys(patch).length > 0, patch, warnings };
}

function parseSceneFields(section) {
    const fields = Object.fromEntries(CURRENT_SCENE_FIELDS.map(label => [label.toLowerCase(), []]));
    const issues = [];
    if (!section) return { fields, issues };

    const bodyStart = section.headerEnd;
    const body = section.body;
    const lineRe = /([^\r\n]*)(\r?\n|$)/g;
    let lineMatch;
    while ((lineMatch = lineRe.exec(body)) !== null) {
        const line = lineMatch[1];
        const lineStart = bodyStart + lineMatch.index;
        const fieldMatch = line.match(/^(\s*)(Date|Time|Location|Present|Situation)(\s*:\s*)(.*)$/);
        if (fieldMatch) {
            const label = fieldMatch[2];
            const key = FIELD_KEY_BY_LABEL[label];
            const value = fieldMatch[4];
            const valueOffset = fieldMatch[1].length + label.length + fieldMatch[3].length;
            fields[key].push({
                label,
                value,
                line,
                lineStart,
                lineEnd: lineStart + line.length,
                valueStart: lineStart + valueOffset,
            });
        } else if (line.trim()) {
            issues.push(issue('unexpected-scene-content', 'Current Scene contains content outside its scalar field lines.', {
                section: 'Current Scene',
                line: line.trim(),
            }));
        }
        if (lineMatch[2] === '') break;
    }
    return { fields, issues };
}

/** Read Current Scene fields only from the Current Scene block. */
export function parseCurrentScene(text) {
    const parsed = parseWorldStateSections(text);
    const sceneSections = parsed.sections.filter(section => section.name === 'Current Scene');
    const section = sceneSections[0] || null;
    const parsedFields = parseSceneFields(section);
    const issues = [...parsed.issues, ...parsedFields.issues];

    if (sceneSections.length === 0) {
        issues.push(issue('missing-current-scene', 'The document must contain a Current Scene section.', {
            section: 'Current Scene',
        }));
    }

    const raw = {};
    for (const label of CURRENT_SCENE_FIELDS) {
        const key = label.toLowerCase();
        const occurrences = parsedFields.fields[key];
        raw[key] = occurrences[0]?.value;
        if (occurrences.length === 0) {
            issues.push(issue('missing-scene-field', `Current Scene is missing the ${label} field.`, {
                section: 'Current Scene', field: key,
            }));
        } else if (occurrences.length > 1) {
            issues.push(issue('duplicate-scene-field', `Current Scene contains more than one ${label} field.`, {
                section: 'Current Scene', field: key,
            }));
        }
    }

    const inspectedPresent = inspectPresentValue(raw.present);
    if (raw.present !== undefined && inspectedPresent.delimiterIssue) {
        issues.push(issue('malformed-present-annotations', 'Present contains unmatched or mismatched annotation delimiters.', {
            section: 'Current Scene',
            field: 'present',
            delimiter: inspectedPresent.delimiterIssue,
        }));
    }

    return {
        date: raw.date,
        time: raw.time,
        location: raw.location,
        present: inspectedPresent.names,
        situation: raw.situation,
        raw,
        section,
        issues,
    };
}

/**
 * Read a scene tolerantly without rebuilding a second document. Generated
 * documents use canonical field casing, while imported and hand-edited
 * documents may use casing variants. In both cases the returned section and
 * parser issues refer to the original saved text.
 */
export function readCurrentScene(text) {
    const parsed = parseCurrentScene(text);
    if (!parsed.section) {
        const source = asText(text);
        if (!source.trim() || parseWorldStateSections(source).sections.some(section => section.known)) return parsed;
        const legacy = {};
        for (const label of CURRENT_SCENE_FIELDS) {
            const value = source.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*)$`, 'im'))?.[1]?.trim();
            if (value !== undefined) legacy[label.toLowerCase()] = value;
        }
        return Object.keys(legacy).length ? {
            ...parsed,
            ...legacy,
            raw: { ...parsed.raw, ...legacy },
            present: normalizePresentValue(legacy.present, { splitBareConjunctions: true }),
            legacy: true,
        } : parsed;
    }

    const values = {};
    for (const label of CURRENT_SCENE_FIELDS) {
        const key = label.toLowerCase();
        // Canonical fields have already been parsed line-by-line (including
        // indentation). Only use the tolerant regex when that strict value is
        // absent, so a stale case variant cannot override a real field.
        const strictValue = parsed.raw[key];
        const value = strictValue !== undefined
            ? strictValue.trim()
            : parsed.section.body.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*)$`, 'im'))?.[1]?.trim();
        if (value !== undefined) values[label.toLowerCase()] = value;
    }
    return {
        ...parsed,
        date: values.date,
        time: values.time,
        location: values.location,
        present: values.present === undefined
            ? []
            : normalizePresentValue(values.present, { splitBareConjunctions: true }),
        situation: values.situation,
        raw: { ...parsed.raw, ...values },
    };
}

function serializePatchValue(key, value) {
    let serialized;
    if (key === 'present') {
        const inspected = inspectPresentValue(value);
        if (inspected.delimiterIssue) {
            throw new TypeError('Current Scene patch field "present" contains malformed annotation delimiters.');
        }
        serialized = inspected.names.join(', ') || EMPTY_PRESENT_VALUE;
    } else {
        serialized = String(value ?? '').trim();
    }
    if (/\r|\n/.test(serialized)) throw new TypeError(`Current Scene patch field "${key}" must be single-line.`);
    return serialized;
}

/**
 * Patch only explicitly supplied Current Scene scalar fields. Existing field
 * lines not named by the patch remain byte-for-byte unchanged.
 */
export function patchCurrentScene(text, patch = {}) {
    const source = asText(text);
    const parsed = parseWorldStateSections(source);
    const sceneSections = parsed.sections.filter(section => section.name === 'Current Scene');
    if (sceneSections.length !== 1) {
        throw new TypeError(`Cannot patch Current Scene: expected exactly one section, found ${sceneSections.length}.`);
    }
    const section = sceneSections[0];
    const { fields } = parseSceneFields(section);
    const entries = [];
    for (const label of CURRENT_SCENE_FIELDS) {
        const key = label.toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        if (fields[key].length > 1) {
            throw new TypeError(`Cannot patch Current Scene: field "${label}" is duplicated.`);
        }
        entries.push({ key, label, value: serializePatchValue(key, patch[key]), field: fields[key][0] });
    }
    if (entries.length === 0) return source;

    const replacements = entries.filter(entry => entry.field).map(entry => ({
        start: entry.field.valueStart,
        end: entry.field.lineEnd,
        value: entry.value,
    }));

    // Missing fields are inserted at the end of the scene body, before its
    // trailing whitespace. Existing valid documents never take this branch,
    // but it makes partial legacy documents repairable by an explicit patch.
    const missing = entries.filter(entry => !entry.field);
    if (missing.length) {
        let insertAt = section.end;
        while (insertAt > section.headerEnd && /\s/.test(source[insertAt - 1])) insertAt--;
        const eol = parsed.lineEnding;
        const needsLeadingEol = insertAt > 0 && source[insertAt - 1] !== '\n';
        replacements.push({
            start: insertAt,
            end: insertAt,
            value: `${needsLeadingEol ? eol : ''}${missing.map(entry => `${entry.label}: ${entry.value}`).join(eol)}`,
        });
    }

    let result = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
    }
    return result;
}

// World State details are structured as scalar fields or bullets. A
// free-standing sentence is therefore prose leakage; deliberately do not match
// bullets, so factual entries such as "- Alex entered..." remain valid.
const UNSTRUCTURED_PROSE_RE = /^\s*(?![-+*#>`]|(?:Date|Time|Location|Present|Situation|Mood|Goal|Status|Notable|Current|Immediate|Key|Worn)\b[^\r\n]*:)[A-Z][^\r\n]*[.!?]\s*$/m;

const RP_MARKERS = Object.freeze([
    { pattern: /^\s*(?:[-+]\s+)?\*(?!\*)[^*\r\n]+\*(?!\*)\s*$/m, label: 'asterisk-formatted action' },
    { pattern: /^\s*(?:```|~~~)/m, label: 'fenced prose' },
    {
        pattern: /^\s*(?:[-+]\s+)?["“][^\r\n"”]+["”][.!?]?\s*$/m,
        label: 'standalone dialogue',
    },
    {
        pattern: /^(?!(?:Date|Time|Location|Present|Situation|Mood|Goal|Status|Notable|Current|Immediate|Key|Worn)\b)[A-Z][a-z]+:\s*["“”]/m,
        label: 'dialogue formatting (Name: "...)',
    },
    {
        pattern: /^\s*(?:[-+]\s+)?(?:[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3}|(?:he|she|they))\s+(?:asked|said|replied|answered|whispered|shouted|called|murmured|muttered|exclaimed),?\s*["“]/im,
        label: 'attributed dialogue',
    },
    {
        pattern: /^\s*(?:[-+]\s+)?["“][^\r\n"”]+["”][,]?\s+(?:[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3}|(?:he|she|they))\s+(?:asked|said|replied|answered|whispered|shouted|called|murmured|muttered|exclaimed)\b/im,
        label: 'dialogue followed by attribution',
    },
    { pattern: /\b(?:you see|you notice|you feel)\b/i, label: 'second-person narration' },
    { pattern: /^(?:Meanwhile|Suddenly|As you|The (?:air|room|silence|darkness))\b/im, label: 'narrative prose opener' },
    {
        pattern: UNSTRUCTURED_PROSE_RE,
        label: 'unstructured narrative prose',
        hint: 'Write each entry as its own "- " bullet line.',
    },
]);

// Enough located lines for a retry to fix every offending entry, without one
// bad section turning the retry reminder into a wall of quoted text.
const MAX_MARKER_LINES = 3;
const MARKER_LINE_PREVIEW_CHARS = 120;

/** Find the lines (and their sections) a roleplay marker matched. */
function locateMarkerLines(pattern, parsed) {
    const source = parsed.text;
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const located = [];
    const seenLineStarts = new Set();
    let match;
    while (located.length < MAX_MARKER_LINES && (match = re.exec(source)) !== null) {
        if (!match[0]) {
            re.lastIndex++;
            continue;
        }
        // A leading `^\s*` can start on a blank line above the offending text,
        // so anchor on the first non-whitespace character the marker matched.
        const offset = match.index + match[0].length - match[0].trimStart().length;
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
        if (seenLineStarts.has(lineStart)) continue;
        seenLineStarts.add(lineStart);
        const lineEnd = source.indexOf('\n', offset);
        const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
        const section = parsed.sections.filter(entry => entry.start <= offset).at(-1)?.name ?? null;
        located.push({ section, line });
    }
    return located;
}

// A bare placeholder where the prompt asks for the section to be omitted.
const PLACEHOLDER_LINE_RE = /^\(?(?:none|n\/a|nothing)(?:\s+(?:currently|yet|so far|at (?:this|the) (?:time|moment)))?\)?[.!]?$/i;
// Titles and initials end in a period without ending the sentence.
const NON_TERMINAL_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'lt', 'capt', 'sgt', 'prof', 'mt', 'vs']);

function isSingleSentence(line) {
    const boundary = /(\p{L}+)?[.!?]+["”’')\]]*\s+(?=["“(]?\p{Lu})/gu;
    let match;
    while ((match = boundary.exec(line)) !== null) {
        const word = match[1] || '';
        if (!NON_TERMINAL_ABBREVIATIONS.has(word.toLowerCase()) && !/^\p{Lu}$/u.test(word)) return false;
    }
    return true;
}

/**
 * Repair objective formatting slips in GENERATED output before validation.
 *
 * Outside Current Scene, a one-sentence line that is not a bullet gains a
 * `- ` at its own indentation, and a bare placeholder line ("None.", "N/A") is
 * dropped — along with its section when nothing else remains. A line is only
 * bulleted when the unstructured-prose check is the ONLY marker it trips, so
 * dialogue, asterisk actions, second-person narration, and narrative openers
 * still reject, as do multi-sentence paragraphs. Bulleting costs no real
 * protection: the validator already accepts narration written as a bullet.
 *
 * This changes saved bytes, so editor and import writes must never use it.
 *
 * @returns {{ text: string, changes: Array<{ kind: 'bulleted'|'dropped-placeholder'|'dropped-empty-section', section: string, line?: string }> }}
 */
export function normalizeGeneratedDocument(text) {
    const source = asText(text);
    const parsed = parseWorldStateSections(source);
    const otherMarkers = RP_MARKERS.filter(marker => marker.pattern !== UNSTRUCTURED_PROSE_RE);
    const changes = [];
    let result = source;
    let droppedFinalSection = false;
    // Splice from the last section back so earlier offsets stay valid.
    for (const section of [...parsed.sections].reverse()) {
        if (section.name === 'Current Scene') continue;
        const sectionChanges = [];
        const parts = section.body.split(/(\r?\n)/);
        const kept = [];
        let droppedPlaceholder = false;
        for (let index = 0; index < parts.length; index += 2) {
            const line = parts[index];
            const eol = parts[index + 1] ?? '';
            const trimmed = line.trim();
            if (PLACEHOLDER_LINE_RE.test(trimmed)) {
                droppedPlaceholder = true;
                sectionChanges.push({ kind: 'dropped-placeholder', section: section.name, line: trimmed });
                continue;
            }
            if (UNSTRUCTURED_PROSE_RE.test(line)
                && isSingleSentence(trimmed)
                && !otherMarkers.some(marker => marker.pattern.test(trimmed))) {
                const indent = line.slice(0, line.length - line.trimStart().length);
                kept.push(`${indent}- ${trimmed}`, eol);
                sectionChanges.push({ kind: 'bulleted', section: section.name, line: trimmed });
                continue;
            }
            kept.push(line, eol);
        }
        if (!sectionChanges.length) continue;

        const body = kept.join('');
        let replacement = source.slice(section.start, section.headerEnd) + body;
        if (droppedPlaceholder && !body.trim()) {
            replacement = '';
            sectionChanges.push({ kind: 'dropped-empty-section', section: section.name });
            if (section.end === source.length) droppedFinalSection = true;
        }
        result = result.slice(0, section.start) + replacement + result.slice(section.end);
        changes.unshift(...sectionChanges);
    }
    // Dropping the final section leaves the separator that belonged to the
    // section before it; remove only those orphaned line breaks.
    if (droppedFinalSection) result = result.replace(/(?:\r?\n[ \t]*)+$/, '');
    return { text: result, changes };
}

/**
 * Validate a document without mutating it.
 *
 * Modes are `structural`, `default-contract`, and `custom-prompt`. Structural
 * failures are errors in every mode. Safe-normalization findings are objective
 * contract errors for the built-in prompt and warnings for custom prompts.
 * Optional compactness targets always produce warnings; they never discard
 * necessary complexity here.
 */
export function validateWorldStateDocument(text, options = {}) {
    const mode = options.mode || 'structural';
    if (!['structural', 'default-contract', 'custom-prompt'].includes(mode)) {
        throw new TypeError(`Unknown World State validation mode "${mode}".`);
    }
    const source = asText(text);
    const parsed = parseWorldStateSections(source);
    const scene = parseCurrentScene(source);
    const issues = [...scene.issues];

    if (!source.trim()) issues.push(issue('empty-document', 'World State document is empty.'));
    // parseCurrentScene() intentionally owns its own parse result, so compare
    // the outer parse structurally rather than relying on section identity.
    if (scene.section && (parsed.sections[0]?.name !== 'Current Scene' || parsed.preamble.trim())) {
        issues.push(issue('document-preamble', 'Content appears before Current Scene.'));
    }
    for (const label of CURRENT_SCENE_FIELDS) {
        const key = label.toLowerCase();
        if (scene.raw[key] !== undefined && !scene.raw[key].trim()) {
            issues.push(issue('empty-scene-field', `Current Scene ${label} must not be empty.`, {
                section: 'Current Scene', field: key,
            }));
        }
    }
    // Name the section and line: a bare marker label gives a validation retry
    // nothing to fix, so the model repeats the same mistake.
    for (const marker of RP_MARKERS) {
        for (const { section, line } of locateMarkerLines(marker.pattern, parsed)) {
            const where = section ? `in ## ${section}` : 'before the first section';
            const preview = line.length > MARKER_LINE_PREVIEW_CHARS
                ? `${line.slice(0, MARKER_LINE_PREVIEW_CHARS - 1)}…`
                : line;
            const hint = marker.hint ? ` ${marker.hint}` : '';
            issues.push(issue('roleplay-leakage', `Roleplay marker detected: ${marker.label} ${where}: "${preview}".${hint}`, {
                marker: marker.label, section, line,
            }));
        }
    }

    let normalizedText = source;
    const presentIsMalformed = scene.issues.some(entry => entry.code === 'malformed-present-annotations');
    if (scene.raw.present !== undefined && !presentIsMalformed) {
        const normalizedPresent = scene.present.join(', ') || EMPTY_PRESENT_VALUE;
        if (normalizedPresent !== scene.raw.present.trim()) {
            const severity = mode === 'default-contract' ? 'error' : 'warning';
            issues.push({
                code: 'present-needs-normalization',
                severity,
                message: 'Present contains annotations, duplicates, or non-canonical spacing.',
                section: 'Current Scene',
                field: 'present',
            });
            try { normalizedText = patchCurrentScene(source, { present: normalizedPresent }); } catch (_) { /* structural issues already report why */ }
        }
    }

    const targets = options.compactness || {};
    for (const [key, maximum] of Object.entries(targets)) {
        const value = scene.raw[key];
        if (!Number.isFinite(maximum) || maximum < 0 || value === undefined) continue;
        if (value.length > maximum) {
            issues.push({
                code: 'compactness-target-exceeded',
                severity: 'warning',
                message: `Current Scene ${key} exceeds the measured target of ${maximum} characters.`,
                section: 'Current Scene', field: key, actual: value.length, target: maximum,
            });
        }
    }

    const errors = issues.filter(entry => entry.severity === 'error');
    const warnings = issues.filter(entry => entry.severity === 'warning');
    return { ok: errors.length === 0, mode, issues, errors, warnings, normalizedText, parsed, scene };
}

/** Build a consumer view while leaving the saved Markdown untouched. */
export function projectWorldState(text, options = {}) {
    const parsed = parseWorldStateSections(text);
    const view = options.view || 'all';
    if (!['all', 'factual', 'hooks'].includes(view)) {
        throw new TypeError(`Unknown World State projection view "${view}".`);
    }
    // Legacy World State documents may contain the old field-only format with
    // no level-two section headers. Preserve that readable content rather than
    // silently injecting an empty projection; once a document has recognized
    // sections, the normal factual/hook filtering below applies. A field-only
    // legacy document is all factual scene data — it has no hook sections, so
    // the hooks view must return '' rather than duplicating the full text
    // (which would otherwise be injected a second time under the hook header).
    if (parsed.sections.length === 0) return view === 'hooks' ? '' : asText(text).trim();
    const isArchive = name => WORLD_STATE_ARCHIVE_SECTION.toLowerCase() === name.toLowerCase();

    const selected = Array.isArray(options.sections)
        ? new Set(options.sections.map(name => String(name).toLowerCase()))
        : null;
    const excluded = new Set((options.excludeSections || []).map(name => String(name).toLowerCase()));
    const sections = parsed.sections
        .filter(section => !isArchive(section.name))
        .filter(section => view === 'all'
            || (view === 'hooks' ? isWorldStateHookSection(section.name) : !isWorldStateHookSection(section.name)))
        .filter(section => !selected || selected.has(section.name.toLowerCase()))
        .filter(section => !excluded.has(section.name.toLowerCase()))
        .map(section => section.raw.trim())
        .filter(Boolean);
    // Preamble is factual hand-edited context. Keep it in factual/all views
    // unless an explicit section allow-list asks for sections only.
    if (view !== 'hooks' && !selected && parsed.preamble.trim()) sections.unshift(parsed.preamble.trim());
    return sections.join(parsed.lineEnding + parsed.lineEnding);
}