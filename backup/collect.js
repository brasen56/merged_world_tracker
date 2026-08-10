/**
 * backup/collect.js — Runtime collection for unified chat backups.
 *
 * Collection is intentionally separate from the pure envelope/validation code.
 * It is the only backup module that knows about SillyTavern chat metadata and
 * the Knowledge lorebook-store cache. It never writes either location.
 */

import {
    buildBackupEnvelope,
    METADATA_KEYS,
} from './data.js';
import {
    getChat,
    getChatMeta,
    getContextSafe,
    getChatIdentity,
    captureScope,
    assertSameScope,
} from '../core/index.js';
// Imported from version.js directly (not the barrel): it is a pure constant,
// and the test stub replaces the barrel wholesale.
import { MWT_VERSION } from '../core/version.js';
import {
    getRegistry,
    getStateRegistry,
} from '../knowledge/registry.js';
import { getRelationships, getStances, getStanceSources } from '../knowledge/relationships.js';
import {
    getLorebookName,
    getStateLorebookName,
} from '../knowledge/scope.js';
import {
    hydrateCurrentBooks,
    isHydrated,
    STORE_VERSION,
} from '../knowledge/store.js';

/**
 * Resolve a human-readable label without assuming one particular ST fork's
 * context field. Chat IDs remain in `_meta.identity`; this is only a filename-
 * friendly label for a user looking at a backup months later.
 */
export function getBackupChatName(ctx, identity = getChatIdentity(ctx)) {
    const candidates = [
        ctx?.chatName,
        ctx?.chat_name,
        ctx?.chatFileName,
        ctx?.chat_file_name,
        ctx?.chatFile,
        identity?.chatId,
        ctx?.name2,
    ];
    const name = candidates.find(value => typeof value === 'string' && value.trim());
    return name ? name.trim() : null;
}

function assertExportScope(scope) {
    // An unknown identity cannot be compared safely because the shared scope
    // helper deliberately gives each unknown identity a different nonce. An
    // export has no commit point, so it is safe to continue in that case; known
    // identities still receive the full async scope guard.
    if (scope?.identity?.isUnknown === true) return;
    const result = assertSameScope(scope);
    if (!result.ok) {
        throw new Error(`Backup export cancelled because the chat changed (${result.reason}).`);
    }
}

/**
 * Collect every Phase 2a section from the current chat.
 *
 * The six chat-metadata sections are explicitly whitelisted. The Knowledge
 * section is read from the hydrated lorebook cache and never from the legacy
 * metadata pointers. The returned envelope is detached from live state.
 */
export async function collectBackup({
    identity = null,
    chatName = null,
    messageCount = null,
    mwtVersion = MWT_VERSION,
    source = 'manual',
    includeKnowledgeStore = true,
} = {}) {
    const ctx = getContextSafe();
    const scope = captureScope(ctx);
    const resolvedIdentity = identity || getChatIdentity(ctx);
    const chat = getChat() || [];
    const meta = getChatMeta() || {};
    const metadata = {};

    for (const [sectionName, metadataKey] of Object.entries(METADATA_KEYS)) {
        if (Object.prototype.hasOwnProperty.call(meta, metadataKey)
            && meta[metadataKey] !== undefined
            && meta[metadataKey] !== null) {
            metadata[sectionName] = meta[metadataKey];
        }
    }

    let knowledgeStore;
    if (includeKnowledgeStore) {
        const knowledgeBook = getLorebookName();
        const stateBook = getStateLorebookName();
        if (!isHydrated(knowledgeBook) || !isHydrated(stateBook)) {
            await hydrateCurrentBooks();
        }
        if (!isHydrated(knowledgeBook) || !isHydrated(stateBook)) {
            throw new Error(
                'Backup export cancelled because the Knowledge lorebook store is not fully hydrated. '
                + 'Reopen the chat and resolve the earlier store-load error before exporting.'
            );
        }
        assertExportScope(scope);

        knowledgeStore = {
            // This is the existing store shape's version, carried by the
            // backup section wrapper as `storeVersion` by data.js.
            version: STORE_VERSION,
            registry: getRegistry(),
            relationships: getRelationships(),
            stances: getStances(),
            stanceSources: getStanceSources(),
            stateRegistry: getStateRegistry(),
        };
    }

    return buildBackupEnvelope({
        metadata,
        knowledgeStore,
        identity: resolvedIdentity,
        createdAt: new Date().toISOString(),
        mwtVersion,
        source,
        chatName: chatName || getBackupChatName(ctx, resolvedIdentity),
        messageCount: messageCount ?? chat.length,
    });
}
