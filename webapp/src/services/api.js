/**
 * API Service
 * Centralized API client using fetch
 * Handles authentication, error handling, and request/response formatting
 */

const API_BASE_URL = window.location.origin;

class ApiClient {
    constructor() {
        this.baseURL = API_BASE_URL;
    }

    /**
     * Make an API request
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;

        const defaultOptions = {
            credentials: 'include', // Include cookies for session auth
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        };

        const config = {
            ...defaultOptions,
            ...options
        };

        try {
            const response = await fetch(url, config);

            // Handle non-JSON responses
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || `Request failed with status ${response.status}`);
                }

                return data;
            } else {
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(text || `Request failed with status ${response.status}`);
                }
                return response;
            }
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    }

    // GET request
    get(endpoint, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'GET'
        });
    }

    // POST request
    post(endpoint, data, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    // PUT request
    put(endpoint, data, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    // DELETE request
    delete(endpoint, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'DELETE'
        });
    }

    // Authentication APIs
    auth = {
        register: (userData) => this.post('/api/auth/register', userData),
        login: (credentials) => this.post('/api/auth/login', credentials),
        logout: () => this.post('/api/auth/logout'),
        getCurrentUser: () => this.get('/api/auth/me'),
        changePassword: (passwords) => this.put('/api/auth/password', passwords)
    };

    // Models APIs
    models = {
        list: () => this.get('/api/models'),
        get: (modelName) => this.get(`/api/models/${encodeURIComponent(modelName)}`),
        load: (modelName, config) => this.post(`/api/models/${encodeURIComponent(modelName)}/load`, config),
        delete: (modelName) => this.delete(`/api/models/${encodeURIComponent(modelName)}`),
        pull: (repoId, filename) => this.post('/api/models/pull', { repoId, filename }),
        search: (query) => this.get(`/api/huggingface/search?query=${encodeURIComponent(query)}`)
    };

    // Instances APIs
    instances = {
        list: () => this.get('/api/vllm/instances'),
        get: (modelName) => this.get(`/api/vllm/instances/${encodeURIComponent(modelName)}`),
        stop: (modelName) => this.delete(`/api/vllm/instances/${encodeURIComponent(modelName)}`)
    };

    // Agents APIs
    agents = {
        list: () => this.get('/api/agents'),
        get: (id) => this.get(`/api/agents/${id}`),
        create: (agentData) => this.post('/api/agents', agentData),
        update: (id, agentData) => this.put(`/api/agents/${id}`, agentData),
        delete: (id) => this.delete(`/api/agents/${id}`)
    };

    // Skills APIs
    skills = {
        list: () => this.get('/api/skills'),
        get: (id) => this.get(`/api/skills/${id}`),
        create: (skillData) => this.post('/api/skills', skillData),
        update: (id, skillData) => this.put(`/api/skills/${id}`, skillData),
        delete: (id) => this.delete(`/api/skills/${id}`)
    };

    // Tasks APIs
    tasks = {
        list: () => this.get('/api/tasks'),
        get: (id) => this.get(`/api/tasks/${id}`),
        create: (taskData) => this.post('/api/tasks', taskData),
        update: (id, taskData) => this.put(`/api/tasks/${id}`, taskData),
        delete: (id) => this.delete(`/api/tasks/${id}`)
    };

    // API Keys APIs
    apiKeys = {
        list: () => this.get('/api/api-keys'),
        create: (keyData) => this.post('/api/api-keys', keyData),
        update: (id, keyData) => this.put(`/api/api-keys/${id}`, keyData),
        delete: (id) => this.delete(`/api/api-keys/${id}`)
    };

    // System Prompts APIs
    systemPrompts = {
        list: () => this.get('/api/system-prompts'),
        get: (modelName) => this.get(`/api/system-prompts/${encodeURIComponent(modelName)}`),
        update: (modelName, prompt) => this.put(`/api/system-prompts/${encodeURIComponent(modelName)}`, { systemPrompt: prompt }),
        delete: (modelName) => this.delete(`/api/system-prompts/${encodeURIComponent(modelName)}`)
    };

    // Model Configs APIs
    modelConfigs = {
        list: () => this.get('/api/model-configs'),
        get: (modelName) => this.get(`/api/model-configs/${encodeURIComponent(modelName)}`),
        update: (modelName, config) => this.put(`/api/model-configs/${encodeURIComponent(modelName)}`, { config })
    };

    // Apps APIs
    apps = {
        list: () => this.get('/api/apps'),
        start: (appId) => this.post(`/api/apps/${appId}/start`),
        stop: (appId) => this.post(`/api/apps/${appId}/stop`),
        restart: (appId) => this.post(`/api/apps/${appId}/restart`)
    };

    // Chat APIs
    chat = {
        send: (message, options) => this.post('/api/chat', { message, ...options }),
        complete: (prompt, options) => this.post('/api/complete', { prompt, ...options })
    };
}

// Export singleton instance
export const api = new ApiClient();
export default api;
