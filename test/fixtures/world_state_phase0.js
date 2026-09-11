/**
 * Reusable Phase 0 fixtures for the World State reliability roadmap.
 *
 * These are intentionally plain strings/objects. Later phases can reuse them
 * for parser, validator, projection, grounding, and chronology tests without
 * importing a SillyTavern-dependent module.
 */

export const MINIMAL_SCENE = [
    '## Current Scene',
    'Date: Unknown',
    'Time: Late afternoon',
    'Location: Harbour office',
    'Present: Alex, Derek',
    'Situation: The group is waiting for the missing manifest.',
].join('\n');

export const CROWDED_SCENE = [
    '## Current Scene',
    'Date: June 4, 2026',
    'Time: Evening',
    'Location: Guild assembly hall',
    'Present: Alex, Derek, Mara, Captain Ilyan, Sister Vale, The Ash Fox, Warden Cole, Dr. Sen',
    'Situation: Rival delegations are negotiating access to the sealed archive.',
    '',
    '## Key Character States',
    '- **Alex**:',
    '  - Mood: guarded',
    '- **Captain Ilyan**:',
    '  - Notable status: left arm remains in a sling',
    '- **The Ash Fox**:',
    '  - Current goal: identify who forged the archive seal',
].join('\n');

export const ANNOTATED_PRESENT_SCENE = [
    '## Current Scene',
    'Date: Unknown',
    'Time: Evening',
    'Location: Simon’s living room',
    'Present: Simon (living room, unpacking), Charlotte [bedroom, asleep], Sophie (in bed), The Ash Fox',
    'Situation: The household is settling in after the move.',
].join('\n');

export const PERSISTENT_INJURY_SCENE = [
    '## Current Scene',
    'Date: June 5, 2026',
    'Time: Morning',
    'Location: Harbour clinic',
    'Present: Mara, Dr. Sen',
    'Situation: Mara is asking whether she can travel today.',
    '',
    '## Key Character States',
    '- **Mara**:',
    '  - Notable status: fractured left wrist remains splinted',
    '  - Key constraint: cannot safely climb or carry weight with her left hand',
].join('\n');

export const OVERDUE_OBLIGATION_SCENE = [
    '## Current Scene',
    'Date: June 8, 2026',
    'Time: 09:00',
    'Location: Harbour office',
    'Present: Alex, Derek',
    'Situation: Derek is reviewing the incomplete customs file.',
    '',
    '## Pending',
    '- OVERDUE — Alex still owes Derek the manifest report that was due June 6.',
].join('\n');

export const UNCHANGED_SCENE_BEFORE = [
    '## Current Scene',
    'Date: March 3, 2026',
    'Time: Late afternoon',
    'Location: Harbour office',
    'Present: Alex, Derek',
    'Situation: The group is waiting for the missing manifest.',
    '',
    '## Recent Changes',
    '- The courier confirmed that the manifest left customs.',
    '',
    '## Pending',
    '- Alex still owes Derek a report by Friday.',
].join('\n');

export const UNCHANGED_SCENE_REFRESH = [
    '## Current Scene',
    'Date: March 3, 2026',
    'Time: Late afternoon',
    'Location: The harbour office on Customs Row',
    'Present: Alex, Derek',
    'Situation: Alex and Derek continue waiting for the missing manifest.',
    '',
    '## Recent Changes',
    '- The courier confirmed that the manifest left customs.',
    '',
    '## Pending',
    '- Alex still owes Derek a report by Friday.',
].join('\n');

export const HOOK_BEARING_SCENE = [
    UNCHANGED_SCENE_BEFORE,
    '',
    '## Story Momentum',
    '- Pressure is building around the delayed manifest.',
    '',
    '## Plot Seeds',
    '- [contact] The courier sends a warning that the seal was replaced in transit.',
    '',
    '## Potential Entrances',
    '- **Captain Ilyan** [institutional]: may arrive to demand the customs file.',
].join('\n');

export const WORLD_STATE_DOCUMENTS = Object.freeze({
    minimal: MINIMAL_SCENE,
    crowded: CROWDED_SCENE,
    annotatedPresent: ANNOTATED_PRESENT_SCENE,
    persistentInjury: PERSISTENT_INJURY_SCENE,
    overdueObligation: OVERDUE_OBLIGATION_SCENE,
    unchangedBefore: UNCHANGED_SCENE_BEFORE,
    unchangedRefresh: UNCHANGED_SCENE_REFRESH,
    hookBearing: HOOK_BEARING_SCENE,
});

export const CHRONICLE_ANCHOR_VALUES = Object.freeze([
    'June 4, 2026 2:30pm',
    'June 4, 2026 2pm',
    'June 4, 2026 late afternoon',
    'June 4, 2026 evening',
    'Unknown',
]);

export function chronicleOutput(anchor, location = 'Harbour office', summary = 'The harbour record is updated.') {
    return [
        '## Summary',
        `- ${summary}`,
        '',
        '## Time Anchor',
        `In-world date and time at end of this period: ${anchor}`,
        `Location at end of this period: ${location}`,
    ].join('\n');
}

export function makeChronicleSnapshot({
    id,
    createdAt,
    fromIndex,
    toIndex,
    anchorValue,
    location = 'Harbour office',
}) {
    return {
        id,
        createdAt,
        worldDate: anchorValue,
        anchor: { msgIndex: toIndex, messageId: `m${toIndex}` },
        fromIndex,
        toIndex,
        text: chronicleOutput(anchorValue, location),
        characters: ['Mara'],
        note: '',
    };
}