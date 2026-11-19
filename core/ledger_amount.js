/** Exact amount boundary shared by Ledger and the report resolver. */
export const MAX_CURRENCY_DECIMALS = 15;
const safeBound = BigInt(Number.MAX_SAFE_INTEGER);

export function requireDecimals(decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_CURRENCY_DECIMALS) {
        throw new RangeError(`Currency decimals must be an integer from 0 to ${MAX_CURRENCY_DECIMALS}.`);
    }
}

export function safeNumber(value) {
    if (value > safeBound || value < -safeBound) throw new RangeError('Amount exceeds the safe integer range.');
    return Number(value);
}

export function parseAmount(input, decimals = 0) {
    requireDecimals(decimals);
    if (typeof input !== 'string') throw new TypeError('Enter an amount as decimal text.');
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
    if (!match || (match[3]?.length ?? 0) > decimals) throw new TypeError('Invalid amount or too many fractional digits.');
    const magnitude = BigInt(match[2] + (match[3] ?? '').padEnd(decimals, '0'));
    return safeNumber(match[1] === '-' ? -magnitude : magnitude);
}