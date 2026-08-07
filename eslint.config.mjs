// @ts-check
/**
 * ESLint flat config — CORRECTNESS RULES ONLY.
 *
 * Deliberately minimal: this config catches real bugs (undefined variables,
 * unused code, duplicate keys, unreachable statements, switch fall-through,
 * and imports of exports that don't exist) without enforcing any style
 * preferences. Style/formatting is intentionally left out so the initial
 * adoption diff stays small and reviewable.
 *
 * Environment notes:
 *  - Source type is "module" (the extension is ES modules; SillyTavern loads
 *    it via <script type="module">, and top-level await is used in index.js
 *    and knowledge/lorebook.js — ecmaVersion 'latest' covers both).
 *  - Globals: browser (the runtime) + node (for vitest.config.js and the test
 *    harness) + the four SillyTavern/jQuery globals the production code
 *    references as bare identifiers under typeof guards.
 *  - All SillyTavern-host imports (`../../../../script.js`, `world-info.js`,
 *    `scripts/macros.js`) are DYNAMIC (await import(...)), so import/named —
 *    which only checks static imports — never touches them. It therefore only
 *    verifies static imports between project files, which is exactly the gap
 *    we want closed (e.g. importing a name that core/index.js doesn't export).
 */

import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default [
    // ── Global ignores (non-JS, vendored, or gitignored reference material) ──
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'coverage/**',
            '.git/**',
            // Reference / working-doc directories (gitignored, not shipped):
            'Aikobots-4/**',
            'BUG_REPORTS/**',
            'Completed_Roadmaps/**',
            'Audit_Reports/**',
            '.claude/**',
            // JSON-only directories:
            'test_presets/**',
            'manifest.json',
        ],
    },

    // ── Project-wide configuration ──────────────────────────────────────────
    {
        files: ['**/*.js'],
        plugins: {
            import: importPlugin,
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                // SillyTavern + jQuery globals referenced as bare identifiers
                // (always under `typeof X !== 'undefined'` guards):
                SillyTavern: 'readonly',
                getContext: 'readonly',
                $: 'readonly',
                jQuery: 'readonly',
                // Additional SillyTavern globals reached via typeof guards:
                toastr: 'readonly',         // notification library (ST global)
                getTokenCount: 'readonly',  // tokenizer (some ST versions expose globally)
            },
        },
        rules: {
            // ── Core correctness (eslint:js recommended already enables these,
            //    restated here so the intent is explicit and the config is
            //    self-describing when someone reads just this file) ──────────
            'no-undef': 'error',
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
            'no-dupe-keys': 'error',
            'no-unreachable': 'error',
            'no-fallthrough': 'error',
            'eqeqeq': ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'no-prototype-builtins': 'error',
            'no-self-assign': 'error',
            'no-self-compare': 'error',
            'no-constant-binary-expression': 'error',
            'no-unsafe-negation': 'error',
            'no-cond-assign': 'error',

            // ── Import correctness ─────────────────────────────────────────
            // Flags a named import whose name is not actually exported by the
            // target module. Catches the exact "core/injection.js didn't import
            // core/prompt.js" class of bug without touching resolution of host
            // modules (those imports are all dynamic).
            'import/named': 'error',
        },
        settings: {
            // Treat SillyTavern-host modules as core (always present) so the
            // resolver does not attempt to resolve them from this repo. They
            // are only ever imported dynamically anyway, so this is belt-and-
            // braces: it keeps import/named quiet if a static import of one
            // is ever added later.
            'import/core-modules': [
                'script.js',
                'world-info.js',
                'scripts/macros.js',
                'scripts/macros/macro-system.js',
            ],
        },
    },
];
