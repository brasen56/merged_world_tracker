/**
 * test/scope.test.js — Lorebook scope resolution.
 *
 * The behaviour worth protecting here is not "the string is formatted nicely",
 * it is "two different characters never resolve to the same book". Every test
 * below that looks cosmetic (sanitising, collisions, renames) is really
 * guarding that one property.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs, setFakeContextExtras } from './stubs/core.js';
import {
    sanitizeLorebookName, deriveBookNames, shortHash,
    getCharacterIdentity, getChatIdentity, resolveBookNames,
} from '../knowledge/scope.js';
import { getSettings, saveSettings } from '../knowledge/settings.js';

beforeEach(() => {
    resetCoreStubs();
    // Keep the console quiet — several paths warn deliberately.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ─── sanitizeLorebookName ───────────────────────────────────────────────────

describe('sanitizeLorebookName', () => {
    test('preserves ordinary names, including spaces and hyphens', () => {
        expect(sanitizeLorebookName('Mara Vance')).toBe('Mara Vance');
        expect(sanitizeLorebookName('Jean-Luc')).toBe('Jean-Luc');
    });

    test('strips characters that are illegal in filenames', () => {
        // Lorebook names become files on disk, so these would break the write.
        // ':' and '/' are removed, then the doubled space collapses to one.
        expect(sanitizeLorebookName('Mara: Book 1 / Act 2')).toBe('Mara Book 1 Act 2');
        expect(sanitizeLorebookName('what?<>|"*\\')).toBe('what');
    });

    test('strips control characters', () => {
        expect(sanitizeLorebookName('Ma\u0000ra\u001f')).toBe('Mara');
    });

    test('collapses runs of whitespace', () => {
        expect(sanitizeLorebookName('Mara    Vance')).toBe('Mara Vance');
    });

    test('trims leading and trailing dots and spaces (Windows rejects them)', () => {
        expect(sanitizeLorebookName('  ..Mara..  ')).toBe('Mara');
    });

    test('caps the length so the final filename stays reasonable', () => {
        const out = sanitizeLorebookName('M'.repeat(200));
        expect(out.length).toBe(64);
    });

    test('returns empty string when nothing usable survives', () => {
        // Callers MUST treat '' as "cannot scope" and fall back to global.
        expect(sanitizeLorebookName('///')).toBe('');
        expect(sanitizeLorebookName('   ')).toBe('');
        expect(sanitizeLorebookName(null)).toBe('');
        expect(sanitizeLorebookName(undefined)).toBe('');
    });
});

// ─── deriveBookNames ────────────────────────────────────────────────────────

describe('deriveBookNames', () => {
    test('an empty suffix yields the legacy global names', () => {
        // This is what makes scope:'global' identical to pre-scope behaviour.
        expect(deriveBookNames(null)).toEqual({
            knowledge: 'Knowledge Tracker',
            state: 'State Tracker',
            profiles: 'NPC Profiles',
        });
        expect(deriveBookNames('///')).toEqual(deriveBookNames(null));
    });

    test('a usable suffix namespaces all three books', () => {
        expect(deriveBookNames('Mara Vance')).toEqual({
            knowledge: 'Knowledge Tracker - Mara Vance',
            state: 'State Tracker - Mara Vance',
            profiles: 'NPC Profiles - Mara Vance',
        });
    });
});

describe('shortHash', () => {
    test('is deterministic', () => {
        expect(shortHash('char:mara.png')).toBe(shortHash('char:mara.png'));
    });

    test('differs for different inputs', () => {
        expect(shortHash('char:mara-a.png')).not.toBe(shortHash('char:mara-b.png'));
    });

    test('is short and filename-safe', () => {
        const h = shortHash('char:mara.png');
        // KNOWLEDGE-09: increased from 4 to 8 chars for collision resistance.
        expect(h.length).toBeLessThanOrEqual(8);
        expect(h).toMatch(/^[a-z0-9]+$/);
    });
});

// ─── Identity resolution ────────────────────────────────────────────────────

describe('getCharacterIdentity', () => {
    test('keys on the avatar filename, not the display name', () => {
        // The avatar survives a rename; the display name does not.
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara Vance', avatar: 'mara.png' }],
        });
        expect(getCharacterIdentity()).toEqual({
            key: 'char:mara.png',
            name: 'Mara Vance',
            isGroup: false,
        });
    });

    test('falls back to the name when the card has no avatar', () => {
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara' }],
        });
        expect(getCharacterIdentity().key).toBe('name:Mara');
    });

    test('identifies a group chat rather than guessing a character', () => {
        setFakeContextExtras({
            groupId: 'g7',
            groups: [{ id: 'g7', name: 'The Crew' }],
        });
        expect(getCharacterIdentity()).toEqual({
            key: 'group:g7',
            name: 'The Crew',
            isGroup: true,
        });
    });

    test('returns null when nothing identifies a character', () => {
        expect(getCharacterIdentity()).toBeNull();
    });
});

describe('getChatIdentity', () => {
    test('prefers getCurrentChatId()', () => {
        setFakeContextExtras({ getCurrentChatId: () => 'chat-42' });
        expect(getChatIdentity()).toEqual({ key: 'chat:chat-42', name: 'chat-42' });
    });

    test('falls back to ctx.chatId', () => {
        setFakeContextExtras({ chatId: 'chat-9' });
        expect(getChatIdentity().key).toBe('chat:chat-9');
    });

    test('returns null when no chat is open', () => {
        expect(getChatIdentity()).toBeNull();
    });
});

// ─── resolveBookNames ───────────────────────────────────────────────────────

describe('resolveBookNames', () => {
    test('global scope returns the legacy names and saves no binding', () => {
        saveSettings({ scope: 'global' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker');
        expect(getSettings().bookBindings).toEqual({});
    });

    test('character scope derives per-card books and records the binding', () => {
        saveSettings({ scope: 'character' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara Vance', avatar: 'mara.png' }],
        });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker - Mara Vance');
        expect(getSettings().bookBindings['char:mara.png'].knowledge)
            .toBe('Knowledge Tracker - Mara Vance');
    });

    test('a rename reuses the existing binding instead of orphaning the book', () => {
        saveSettings({ scope: 'character' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara Vance', avatar: 'mara.png' }],
        });
        const before = resolveBookNames();

        // Same card (same avatar), new display name.
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara Chen', avatar: 'mara.png' }],
        });
        expect(resolveBookNames()).toEqual(before);
    });

    test('two cards sharing a display name get different books', () => {
        // The whole point of scoping — these must never share a book.
        saveSettings({ scope: 'character' });

        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara-a.png' }],
        });
        const first = resolveBookNames().knowledge;

        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara-b.png' }],
        });
        const second = resolveBookNames().knowledge;

        expect(first).toBe('Knowledge Tracker - Mara');
        expect(second).not.toBe(first);
        expect(second).toContain('Mara');
    });

    test('long names reserve space for the discriminator and bind separate books', () => {
        saveSettings({ scope: 'character' });
        const firstName = 'A'.repeat(64);
        setFakeContextExtras({ characterId: 0, characters: [{ name: firstName, avatar: 'first.png' }] });
        const first = resolveBookNames();
        setFakeContextExtras({ characterId: 0, characters: [{ name: firstName + ' different tail', avatar: 'second.png' }] });
        const second = resolveBookNames();
        expect(second.knowledge).toBe(`Knowledge Tracker - ${'A'.repeat(64 - ` (${shortHash('char:second.png')})`.length)} (${shortHash('char:second.png')})`);
        for (const field of ['knowledge', 'state', 'profiles']) expect(second[field]).not.toBe(first[field]);
        expect(getSettings().bookBindings['char:second.png']).toEqual(second);
    });

    test('an occupied discriminator refuses visibly without binding or writing to a shared book', async () => {
        const { getRegistry, saveRegistry } = await import('../knowledge/registry.js');
        const { _clearCacheForTests } = await import('../knowledge/store.js');
        const { state } = await import('../knowledge/state.js');
        _clearCacheForTests();
        saveSettings({ scope: 'character' });
        const name = 'A'.repeat(64);
        setFakeContextExtras({ characterId: 0, characters: [{ name, avatar: 'first.png' }] });
        const first = resolveBookNames();
        const key = 'char:second.png';
        const suffix = ` (${shortHash(key)})`;
        const occupied = deriveBookNames(`${'A'.repeat(64 - suffix.length)}${suffix}`);
        saveSettings({ bookBindings: { ...getSettings().bookBindings, 'char:third.png': occupied } });
        setFakeContextExtras({ characterId: 0, characters: [{ name, avatar: 'second.png' }] });
        expect(resolveBookNames()).toBeNull();
        expect(state._lastKtStatusMsg).toMatch(/still collides/);
        expect(state._lastKtStatusLevel).toBe('error');
        expect(getSettings().bookBindings[key]).toBeUndefined();
        expect(getRegistry()).toEqual({});
        saveRegistry({ Mara: { uid: 3 } });
        expect(getRegistry()).toEqual({});
        expect(getSettings().bookBindings['char:first.png']).toEqual(first);
        _clearCacheForTests();
    });

    test('chat scope derives per-chat books', () => {
        saveSettings({ scope: 'chat' });
        setFakeContextExtras({ getCurrentChatId: () => 'chat-42' });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker - chat-42');
    });

    test('falls back to global when the scope cannot be identified', () => {
        // Safer to share the global book than to guess and write to the wrong one.
        saveSettings({ scope: 'character' });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker');
    });

    test('falls back to global when the name sanitises to nothing', () => {
        saveSettings({ scope: 'character' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: '???', avatar: '' }],
        });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker');
    });

    test('an unrecognised scope value is treated as global', () => {
        saveSettings({ scope: 'nonsense' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker');
    });
});
