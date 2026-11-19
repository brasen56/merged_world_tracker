/** Shared guard for destructive full-history scans on sparse-chat hosts. */
import { getChat } from './context.js';

let checkerPromise;

/** Upstream has no hydration API; explicit holes still fail closed. Cache the
 * import promise so concurrent callers cannot mistake a pending load for upstream. */
export async function isChatHydrated(chat = getChat()) {
    checkerPromise ??= import('../../../../../script.js')
        .then(module => typeof module.isChatFullyHydrated === 'function' ? module.isChatFullyHydrated : null)
        .catch(() => null);
    const checker = await checkerPromise;
    if (checker) {
        try { if (!checker()) return false; } catch { return false; }
    }
    for (let index = 0; index < chat.length; index++) {
        if (!chat[index] || typeof chat[index].mes !== 'string') return false;
    }
    return true;
}