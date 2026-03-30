/**
 * PanelMaster API Client
 * Requires Node.js 18+ for native fetch support.
 */

class PanelMasterClient {
    constructor() {
        // Environment variables များမှတဆင့် URL နှင့် Key ကို ယူမည် (Hardcode မလုပ်ပါ)
        this.baseUrl = process.env.PANELMASTER_BASE_URL;
        this.apiKey = process.env.PANELMASTER_API_KEY;
        this.timeoutMs = parseInt(process.env.PANELMASTER_TIMEOUT_MS, 10) || 15000;

        if (!this.baseUrl || !this.apiKey) {
            console.warn('⚠️ Warning: PANELMASTER_BASE_URL or PANELMASTER_API_KEY is missing in .env');
        }
    }

    /**
     * Internal Core Request Handler (Timeout နှင့် Error Handling များပါဝင်သည်)
     */
    async _request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers = {
            'Content-Type': 'application/json',
            ...(options.requireApiKey !== false && { 'x-api-key': this.apiKey }),
            ...options.headers
        };

        try {
            const response = await fetch(url, {
                ...options,
                headers,
                signal: controller.signal
            });

            if (!response.ok) {
                let errorMsg = `HTTP Error ${response.status} - ${response.statusText}`;
                try {
                    const errorBody = await response.json();
                    errorMsg = errorBody.message || errorBody.error || errorMsg;
                } catch {
                    const textBody = await response.text();
                    if (textBody) errorMsg = textBody;
                }
                throw new Error(`PanelMaster API Error: ${errorMsg}`);
            }

            // JSON Response ဖြစ်လျှင် Parse လုပ်မည်
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            }
            return {};
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`PanelMaster Request timed out after ${this.timeoutMs}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async getActiveGroups() {
        return this._request('/api/active-groups', { method: 'GET' });
    }

    async createUser({ masterGroupId, userName, totalGB, expireDate }) {
        return this._request('/api/generate-keys', {
            method: 'POST',
            body: JSON.stringify({ masterGroupId, userName, totalGB, expireDate })
        });
    }

    async switchServer({ token, activeServer }) {
        return this._request('/api/webhook/switch', {
            method: 'POST',
            body: JSON.stringify({ token, activeServer })
        });
    }

    async userAction({ token, action }) {
        const validActions = ['suspend', 'resume', 'delete'];
        if (!validActions.includes(action)) {
            throw new Error(`Invalid action: ${action}. Allowed: ${validActions.join(', ')}`);
        }
        return this._request('/api/user-action', {
            method: 'POST',
            body: JSON.stringify({ token, action })
        });
    }

    async suspendUser(token) {
        return this.userAction({ token, action: 'suspend' });
    }

    async resumeUser(token) {
        return this.userAction({ token, action: 'resume' });
    }

    async deleteUser(token) {
        return this.userAction({ token, action: 'delete' });
    }

    async getUserConfig(token) {
        // ဤ Endpoint သည် API Key မလိုပါ
        return this._request(`/conf/${token}.json`, { 
            method: 'GET',
            requireApiKey: false 
        });
    }
}

module.exports = new PanelMasterClient();
