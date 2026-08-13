/** Minimal Connection Manager host-module seam for Node/Vitest. */
export const ConnectionManagerRequestService = {
    constructPrompt(messages) {
        return messages;
    },
    async sendRequest() {
        return {
            content: 'stub response',
            finish_reason: 'stop',
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        };
    },
};