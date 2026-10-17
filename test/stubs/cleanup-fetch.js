import { vi } from 'vitest';
import { setFakeContextExtras } from './core.js';

/** Exercise the actual checked HTTP path while keeping existing disk/failure hooks. */
export function installCleanupFetch(fake) {
    setFakeContextExtras({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) });
    vi.stubGlobal('fetch', vi.fn(async (path, options) => {
        const { name, data } = JSON.parse(options.body);
        if (path === '/api/worldinfo/edit') {
            await fake.saveWorldInfo(name, data, true);
            return { ok: true, status: 200 };
        }
        if (path === '/api/worldinfo/get') {
            const wi = await fake.loadWorldInfo(name);
            return { ok: true, status: 200, json: async () => wi || { entries: {} } };
        }
        throw new Error(`Unexpected request: ${path}`);
    }));
}