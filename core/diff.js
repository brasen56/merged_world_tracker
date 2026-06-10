/**
 * core/diff.js — Shared diff computation and HTML rendering
 *
 * Consolidates the three independent diff implementations:
 * - Knowledge Tracker: LCS line diff → kt-diff-row HTML
 * - Session Chronicle: LCS word-level diff → <ins>/<del> inline HTML
 * - WorldState: LCS line diff → ws-diff-line HTML
 *
 * This module provides the raw algorithms plus neutral rendering helpers.
 * Each module's UI layer can wrap the output in its own CSS classes.
 */

// ─── HTML escaping ────────────────────────────────────────────────────────────

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── LCS line diff ────────────────────────────────────────────────────────────

/**
 * Compute an LCS-based line diff between two texts.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [maxLines=500] — fallback to simple diff if total lines exceed this
 * @returns {Array<{type:'same'|'added'|'removed', text:string}>|null}
 */
export function computeLcsDiff(oldText, newText, maxLines = 500) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    const m = oldLines.length;
    const n = newLines.length;

    if (m + n > maxLines * 2) return null; // too large for LCS

    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const diff = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            diff.push({ type: 'same', text: oldLines[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.push({ type: 'added', text: newLines[j - 1] });
            j--;
        } else {
            diff.push({ type: 'removed', text: oldLines[i - 1] });
            i--;
        }
    }
    diff.reverse();
    return diff;
}

// ─── LCS word-level inline diff ───────────────────────────────────────────────

/**
 * Compute a word-level diff for side-by-side inline display.
 *
 * @param {string} originalText
 * @param {string} newText
 * @returns {{ originalHtml: string, newHtml: string }}
 */
export function buildInlineDiff(originalText, newText, maxWords = 2000) {
    const origWords = (originalText || '').split(/(\s+)/);
    const newWords = (newText || '').split(/(\s+)/);

    const m = origWords.length;
    const n = newWords.length;

    // Word-level LCS is O(n²); cap to avoid freezing the tab on huge entries.
    // Fall back to simple side-by-side (no markup) when the input is too large.
    if (m + n > maxWords * 2) {
        return {
            originalHtml: '<pre style="white-space:pre-wrap">' + escapeHtml(originalText || '') + '</pre>',
            newHtml: '<pre style="white-space:pre-wrap">' + escapeHtml(newText || '') + '</pre>',
        };
    }

    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (origWords[i - 1] === newWords[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const diff = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && origWords[i - 1] === newWords[j - 1]) {
            diff.unshift({ type: 'equal', value: origWords[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift({ type: 'added', value: newWords[j - 1] });
            j--;
        } else {
            diff.unshift({ type: 'removed', value: origWords[i - 1] });
            i--;
        }
    }

    let originalHtml = '';
    let newHtml = '';
    for (const d of diff) {
        const escaped = escapeHtml(d.value);
        if (d.type === 'equal') {
            originalHtml += escaped;
            newHtml += escaped;
        } else if (d.type === 'removed') {
            originalHtml += '<del>' + escaped + '</del>';
        } else if (d.type === 'added') {
            newHtml += '<ins>' + escaped + '</ins>';
        }
    }
    return { originalHtml, newHtml };
}

// ─── Diff → HTML rendering ────────────────────────────────────────────────────

/**
 * Render an LCS diff array as a unified diff block with customisable CSS classes.
 *
 * @param {Array<{type, text}>} diff — output of computeLcsDiff
 * @param {object} [css]
 * @param {string} [css.wrapper='mwt-diff']
 * @param {string} [css.same='mwt-diff-same']
 * @param {string} [css.added='mwt-diff-new']
 * @param {string} [css.removed='mwt-diff-old']
 * @returns {string} HTML string
 */
export function renderDiffHtml(diff, {
    wrapper = 'mwt-diff',
    same = 'mwt-diff-same',
    added = 'mwt-diff-new',
    removed = 'mwt-diff-old',
} = {}) {
    if (!diff) return '';
    const rows = diff.map(d => {
        const escaped = escapeHtml(d.text || ' ');
        if (d.type === 'added') return `<div class="${added}">+ ${escaped}</div>`;
        if (d.type === 'removed') return `<div class="${removed}">- ${escaped}</div>`;
        return `<div class="${same}">&nbsp; ${escaped}</div>`;
    });
    return `<div class="${wrapper}">${rows.join('')}</div>`;
}

/**
 * Convenience: compute + render a line diff in one call.
 */
export function renderLineDiff(oldText, newText, cssOpts) {
    const diff = computeLcsDiff(oldText, newText);
    return renderDiffHtml(diff, cssOpts);
}