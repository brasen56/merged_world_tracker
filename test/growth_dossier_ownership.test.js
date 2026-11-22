import { beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resetCoreStubs, setFakeContextExtras } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getEvidenceFile, saveEvidenceMap } from '../knowledge/evidence.js';
import { applyFieldOwnership, growthOwnsField } from '../knowledge/field_ownership.js';
import { getRegistry, registerEntry, setGrowthDossierSettings, getGrowthDossierSettings } from '../knowledge/registry.js';
import { saveSettings } from '../knowledge/settings.js';
import { getLorebookName } from '../knowledge/scope.js';
import { validateKnowledgeStoreData } from '../knowledge/schema.js';
import { sanitizeDossierRefreshFields } from '../knowledge/lorebook.js';

beforeEach(() => { resetCoreStubs(); _clearCacheForTests(); saveSettings({ scope: 'global' }); });

describe('Growth ownership, upgrade and scope', () => {
    for (const enabled of [undefined, true, false]) {
        for (const evidence of [true, false]) {
            test(`switch=${enabled}, evidence=${evidence}`, () => {
                _setCacheForTests(getLorebookName(), { registry: { Mara: { uid: 7, growthDossier: { enabled } } } });
                if (evidence) { getEvidenceFile('Mara').enrolled = true; saveEvidenceMap(); }
                const personality = enabled === undefined ? evidence : enabled;
                const voice = enabled === true;
                expect(growthOwnsField('Mara', 'personality')).toBe(personality);
                expect(growthOwnsField('Mara', 'voice')).toBe(voice);
                expect(growthOwnsField('Mara', 'background')).toBe(false);
                expect(applyFieldOwnership('Mara', { personality: 'P', voice: 'V', role: 'R' }))
                    .toEqual({ personality: personality ? null : 'P', voice: voice ? null : 'V', role: 'R' });
                expect(sanitizeDossierRefreshFields(['personality', 'voice'], 'Mara').requested)
                    .toEqual(['voice', 'personality'].filter(key => !growthOwnsField('Mara', key)));
            });
        }
    }
    for (const scope of ['chat', 'character']) {
        test(`no-evidence chapter uses persisted ${scope} book settings`, () => {
            setFakeContextExtras({ characterId: 0, characters: [{ name: 'Mara', avatar: 'mara.png' }], getCurrentChatId: () => 'chapter-2' });
            saveSettings({ scope });
            _setCacheForTests(getLorebookName(), { registry: { Mara: { uid: 7, entityId: 'mara', aliases: [], profileUid: 9 } } });
            expect(growthOwnsField('Mara', 'personality')).toBe(false);
            setGrowthDossierSettings('Mara', { enabled: true, limits: { personality: 1200 } });
            setGrowthDossierSettings('Mara', { limits: { voice: 800 } });
            registerEntry('Mara', 8, 'major', ['Mara']);
            expect(getRegistry().Mara).toMatchObject({ entityId: 'mara', profileUid: 9, growthDossier: { enabled: true, limits: { personality: 1200, voice: 800 } } });
            expect(growthOwnsField('Mara', 'personality')).toBe(true);
            expect(growthOwnsField('Mara', 'voice')).toBe(true);
            setGrowthDossierSettings('Mara', { enabled: false });
            expect(growthOwnsField('Mara', 'personality')).toBe(false);
            expect(getGrowthDossierSettings('Mara').limits.voice).toBe(800);
        });
    }
    test('all ownership boundaries use the shared helper, not raw evidence checks', () => {
        for (const name of ['lorebook', 'render', 'staging']) {
            const source = readFileSync(new URL(`../knowledge/${name}.js`, import.meta.url), 'utf8');
            expect(source.replace(/\/\*[^]*?\*\//g, '')).not.toMatch(/hasEvidenceFile\s*\(/);
        }
    });
    test('every former cleanup-container walk uses the shared internal-entry predicate', () => {
        for (const file of ['knowledge/lorebook.js', 'knowledge/staging.js', 'knowledge/manual_edit.js', 'knowledge/reconcile.js', 'backup/index.js']) {
            const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(source).toContain('isInternalEntry(');
            expect(source).not.toContain('isCleanupRecoveryEntry(');
        }
    });
    test.each([null, true, { enabled: 'false' }, { limits: [] }])('malformed settings repair keeps NPC live: %j', growthDossier => {
        const checked = validateKnowledgeStoreData({ registry: { Mara: { uid: 7, growthDossier } } });
        expect(checked.data.registry.Mara).toEqual({ uid: 7 });
        expect(checked.issues.some(issue => issue.code === 'registry-growth-dossier-repaired')).toBe(true);
    });
    test('bad limits drop independently, retaining the explicit switch', () => {
        const checked = validateKnowledgeStoreData({ registry: { Mara: { uid: 7,
            growthDossier: { enabled: false, limits: { personality: 1501, voice: 750 } } } } });
        expect(checked.data.registry.Mara.growthDossier).toEqual({ enabled: false, limits: { voice: 750 } });
    });
});