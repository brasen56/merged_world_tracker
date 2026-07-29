/**
 * vitest.config.js — Test runner configuration.
 *
 * Vitest is the test runner. It understands the ES-module import/export
 * syntax used throughout this extension natively, so almost no config is
 * needed. The one important setting is `alias`: it lets us swap out the
 * SillyTavern-dependent `core/index.js` barrel for a lightweight fake
 * (`test/stubs/core.js`) when running tests. See the comment in
 * `test/stubs/core.js` for why that's necessary.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    test: {
        // Look for files ending in .test.js anywhere under the project root.
        include: ['**/*.test.js'],
        // Never run tests against installed dependencies or build output.
        exclude: ['node_modules/**', 'dist/**', 'coverage/**'],
        // Run tests in the Node environment (not the browser). Most of the
        // testable code in this extension is pure logic that doesn't need a
        // DOM; when a test does need browser globals, we stub them locally.
        environment: 'node',
    },
    resolve: {
        alias: {
            // Any import of '../core/index.js' (or './core/index.js') resolves
            // to the stub instead. This is what lets us test modules that
            // normally depend on SillyTavern's runtime (getChatMeta, etc.)
            // without launching SillyTavern.
            //
            // Note: we alias by the resolved absolute path of the real barrel
            // file so both relative forms ('./core/index.js' and
            // '../core/index.js') match.
            './core/index.js': fileURLToPath(new URL('./test/stubs/core.js', import.meta.url)),
            '../core/index.js': fileURLToPath(new URL('./test/stubs/core.js', import.meta.url)),
        },
    },
});