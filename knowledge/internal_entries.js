/** Internal containers must never be mistaken for NPCs or tracker entries. */
export function isInternalEntry(entry) {
    return typeof entry?.comment === 'string' && [
        '[MWT:store]', '[MWT:cleanup-recovery]', '[MWT:growth-history]',
    ].some(prefix => entry.comment.startsWith(prefix));
}