import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const coreCss = readFileSync(fileURLToPath(new URL('../core/style.css', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

describe('Settings workspace responsive CSS', () => {
    test('keeps Save in normal flow rather than covering section content', () => {
        const actions = coreCss.match(/\.mwt-settings-workspace \.mwt-settings-actions\s*\{([^}]+)\}/)[1];
        expect(actions).toMatch(/position:\s*static;/);
        expect(actions).not.toMatch(/position:\s*sticky;|bottom:|z-index:/);
    });

    test('keeps main modal size stable without changing secondary dialog height', () => {
        const panel = coreCss.match(/#mwt-modal \.mwt-modal-panel\s*\{([^}]+)\}/)[1];
        expect(panel).toMatch(/height:\s*85vh;/);
        expect(panel).toMatch(/height:\s*85dvh;/);
        expect(panel).toMatch(/box-sizing:\s*border-box;/);
        expect(coreCss).toMatch(/#mwt-modal \.mwt-modal-panel\s*\{\s*height:\s*95vh;\s*height:\s*95dvh;/);
        const body = coreCss.match(/#mwt-modal \.mwt-modal-body\s*\{([^}]+)\}/)[1];
        expect(body).toMatch(/min-width:\s*0;/);
        expect(body).toMatch(/min-height:\s*0;/);
        expect(body).toMatch(/box-sizing:\s*border-box;/);
        expect(body).toMatch(/scrollbar-gutter:\s*stable;/);
    });

    test('contains wide main navigation and includes field padding in widths', () => {
        expect(coreCss.match(/\.mwt-tab-bar\s*\{([^}]+)\}/)[1]).toMatch(/overflow-x:\s*auto;/);
        expect(coreCss).toMatch(/\.mwt-settings-workspace :is\(input, select, textarea\)\s*\{\s*box-sizing:\s*border-box;/);
    });

    test('keeps the two-column workspace layout outside the narrow-screen breakpoint', () => {
        expect(coreCss).toMatch(/\.mwt-settings-workspace \.mwt-settings-grid\s*\{\s*grid-template-columns:\s*minmax\(100px, 120px\) minmax\(0, 1fr\);\s*\}/);
    });

    test('stacks workspace and standalone grids at 480px with matching workspace specificity', () => {
        const narrow = coreCss.match(/@media\s*\(max-width:\s*480px\)\s*\{([\s\S]*?)\n\}/);
        expect(narrow).not.toBeNull();
        const stacked = narrow[1].match(/([^{}]+)\{\s*grid-template-columns:\s*1fr;\s*\}/);
        expect(stacked).not.toBeNull();
        const selectors = stacked[1].split(',').map(selector => selector.trim());
        expect(selectors).toContain('.mwt-settings-grid');
        expect(selectors).toContain('.mwt-settings-workspace .mwt-settings-grid');
        // Equal specificity needs later source order to beat the desktop rule.
        expect(narrow.index).toBeGreaterThan(coreCss.indexOf('.mwt-settings-workspace .mwt-settings-grid'));
        expect(narrow[1]).toMatch(/\.mwt-settings-grid \.mwt-label\s*\{\s*text-align:\s*left;/);
    });
});