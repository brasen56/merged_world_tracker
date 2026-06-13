/**
 * core/file.js — Shared browser file helpers.
 */

export function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename, data) {
    downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

export async function pickTextFile(accept) {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = async () => {
            try {
                const file = input.files?.[0];
                resolve(file ? await file.text() : '');
            } catch (err) {
                reject(err);
            } finally {
                input.remove();
            }
        };
        input.click();
    });
}