/** Keep every source needed to undo a live consolidation, plus recent ordinary trash. */
export function retainChronicleTrash(bin, snapshots, limit) {
    const protectedIds = new Set();
    const byId = new Map(bin.map(entry => [entry.id, entry]));
    const pending = snapshots.flatMap(snapshot => snapshot._consolidatedFrom || []);
    while (pending.length) {
        const id = pending.pop();
        if (protectedIds.has(id)) continue;
        protectedIds.add(id);
        // A source can itself be a consolidated entry. Preserve its own sources
        // so undoing the outer merge does not strand the inner undo operation.
        pending.push(...(byId.get(id)?._consolidatedFrom || []));
    }
    let ordinarySlots = Math.max(0, limit - bin.filter(entry => protectedIds.has(entry.id)).length);
    const kept = [];
    for (let i = bin.length - 1; i >= 0; i--) {
        const entry = bin[i];
        if (protectedIds.has(entry.id) || ordinarySlots-- > 0) kept.push(entry);
    }
    return kept.reverse();
}