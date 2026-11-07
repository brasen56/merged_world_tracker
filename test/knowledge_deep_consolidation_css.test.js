import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

it('scopes readable field/popup colors and shrinkable layout to the preview', () => {
    // Inspect CSS contracts; native popup rendering still needs a host-browser check.
    const css = readFileSync(new URL('../knowledge/style.css', import.meta.url), 'utf8');
    const dom = new JSDOM('<!doctype html><head></head><body></body>');
    try {
        const style = dom.window.document.createElement('style');
        style.textContent = css;
        dom.window.document.head.appendChild(style);
        const rules = [...style.sheet.cssRules];
        const fields = rules.find(rule => rule.selectorText === '.kt-deep-preview .mwt-input, .kt-deep-preview .mwt-textarea');
        expect(fields.style.background).toBe('var(--mwt-bg-light)');
        expect(fields.style.color).toBe('var(--mwt-text)');
        expect(fields.style.width).toBe('100%');
        expect(fields.style.getPropertyValue('min-width')).toBe('0');
        expect(fields.style.getPropertyValue('text-align')).toBe('start');
        const options = rules.find(rule => rule.selectorText === '.kt-deep-preview select option');
        expect(options.style.background).toBe('var(--mwt-bg-light)');
        expect(options.style.color).toBe('var(--mwt-text)');
        const description = rules.find(rule => rule.selectorText === '.kt-deep-preview .kt-deep-group-description');
        expect(description.style.getPropertyValue('overflow-wrap')).toBe('anywhere');
    } finally { dom.window.close(); }
});