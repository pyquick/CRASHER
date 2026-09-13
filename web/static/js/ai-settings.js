// ── Crash Report Server - AI Settings page ──
// Consolidated AI configuration: DeepSeek provider keys, AI Bash policy,
// and the code-analysis self-improvement trigger + progress.

(function () {
  async function requestWith2FA(url, options = {}) {
    const requestOptions = () => ({
      ...options,
      headers: new Headers(options.headers || {}),
    });
    const response = await fetch(url, requestOptions());
    let data = {};
    try { data = await response.json(); } catch {}
    if (response.status === 403 && data.requires_2fa) {
      return new Promise((resolve, reject) => {
        Alpine.store('authSteps').open2FA({
          context: 'operation',
          method: data.method || 'email',
          available_methods: data.available_methods || [],
          tempToken: data.temp_token || '',
          hint: data.email_hint || data.phone_hint || '',
          message: data.message || '',
          onSuccess: async () => {
            try {
              const retry = await fetch(url, requestOptions());
              let retryData = {};
              try { retryData = await retry.json(); } catch {}
              if (retry.ok) resolve(retryData);
              else reject(new Error(retryData.message || 'Request failed'));
            } catch (error) { reject(error); }
          },
          onCancel: () => reject(new Error('Two-factor authentication is required')),
        });
      });
    }
    if (!response.ok) throw new Error(data.message || 'Request failed');
    return data;
  }

  document.addEventListener('alpine:init', () => {
    Alpine.data('aiProviderSettings', () => ({
      provider: 'deepseek', apiKey: '', keys: [], configured: false, serverReady: false, loading: false, message: '', failed: false,
      apply(data) {
        this.keys = data.keys || [];
        this.configured = !!data.configured;
        this.serverReady = data.server_ready !== false;
        this.provider = data.provider || 'deepseek';
      },
      async load() {
        try {
          const response = await fetch('/api/v1/auth/ai-provider/keys');
          let data = {};
          try { data = await response.json(); } catch {}
          if (!response.ok) throw new Error(data.message || 'Request failed');
          this.apply(data);
        } catch (error) { this.message = error.message; this.failed = true; }
      },
      async request(url, options = {}) { return requestWith2FA(url, options); },
      async addKey() {
        if (!this.apiKey) return;
        this.loading = true; this.message = ''; this.failed = false;
        try {
          const data = await this.request('/api/v1/auth/ai-provider/keys', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: this.apiKey }),
          });
          this.apiKey = ''; this.apply(data); this.message = 'DeepSeek API key added';
        } catch (error) { this.message = error.message; this.failed = true; }
        this.loading = false;
      },
      async replaceKey(key) {
        const value = await Modal.prompt('Replace DeepSeek API key', 'Enter the replacement key. It will not be shown again.', 'password', 'DeepSeek API key', 'Replace');
        if (value === null) return;
        if (!value) { this.message = 'Enter a replacement API key'; this.failed = true; return; }
        await this.updateKey(key, { api_key: value }, 'DeepSeek API key replaced');
      },
      async toggleKey(key) {
        await this.updateKey(key, { enabled: !key.enabled }, key.enabled ? 'DeepSeek API key disabled' : 'DeepSeek API key enabled');
      },
      async updateKey(key, body, successMessage) {
        this.loading = true; this.message = ''; this.failed = false;
        try {
          const data = await this.request('/api/v1/auth/ai-provider/keys/' + key.id, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          this.apply(data); this.message = successMessage;
        } catch (error) { this.message = error.message; this.failed = true; }
        this.loading = false;
      },
      async removeKey(key) {
        if (!await Modal.confirm('Remove DeepSeek API key', 'Remove ' + (key.masked_api_key || 'this key') + '?', 'Remove')) return;
        this.loading = true; this.message = ''; this.failed = false;
        try {
          const data = await this.request('/api/v1/auth/ai-provider/keys/' + key.id, { method: 'DELETE' });
          this.apply(data); this.message = 'DeepSeek API key removed';
        } catch (error) { this.message = error.message; this.failed = true; }
        this.loading = false;
      },
      keyStatus(key) {
        if (!key.enabled) return 'disabled';
        if (key.last_failure_code === 'AI_PROVIDER_AUTH') return 'authentication failed';
        if (key.last_failure_code === 'AI_PROVIDER_QUOTA') return 'quota exhausted';
        if (key.retry_after_at) return 'cooling down until ' + formatDate(key.retry_after_at);
        return 'ready';
      },
    }));
    Alpine.data('aiBashSettings', () => ({
      enabled: false, policy: { default: 'deny', allow: [], deny: [] }, allowText: '[]', denyText: '[]', loading: false, message: '', failed: false,
      async load() {
        try { const data = await this.request('/api/v1/auth/ai-bash'); this.apply(data); }
        catch (error) { this.message = error.message; this.failed = true; }
      },
      apply(data) { this.enabled = !!data.enabled; this.policy = data.policy || this.policy; this.allowText = JSON.stringify(this.policy.allow || [], null, 2); this.denyText = JSON.stringify(this.policy.deny || [], null, 2); },
      // No 2FA for Bash policy saves: the global fetch wrapper injects CSRF.
      async request(url, options = {}) {
        const response = await fetch(url, options);
        let data = {};
        try { data = await response.json(); } catch {}
        if (!response.ok) throw new Error(data.message || 'Request failed');
        return data;
      },
      async save() {
        this.loading = true; this.message = ''; this.failed = false;
        try {
          const allow = JSON.parse(this.allowText || '[]'); const deny = JSON.parse(this.denyText || '[]');
          if (!Array.isArray(allow) || !Array.isArray(deny)) throw new Error('Allow and deny rules must be JSON arrays');
          const data = await this.request('/api/v1/auth/ai-bash', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: this.enabled, policy: { default: this.policy.default, allow, deny } }) });
          this.apply(data); this.message = 'Bash policy saved';
        } catch (error) { this.message = error.message; this.failed = true; }
        this.loading = false;
      },
    }));
    Alpine.data('aiSelfImprove', () => ({
      job: null, active: false, selectedModel: '', models: [],
      message: '',
      failed: false,
      loading: false,
      pollTimer: null,
      logs: [],
      async init() { await this.load(); try { const r = await fetch('/api/v1/ai/models'); const d = await r.json(); this.models = (d.items || d.data?.items || d.data?.models || []).map(item => typeof item === 'string' ? { id: item, value: item, label: item } : { id: item.value || item.id, value: item.value || item.id, label: item.label || item.value || item.id }); this.selectedModel = this.models[0]?.value || ''; } catch {} },
      async load() {
        try {
          const res = await fetch('/api/v1/analysis-self-improve');
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'Request failed');
          this.job = data.data?.job ?? data.job ?? null;
          this.active = data.data?.active ?? data.active ?? false;
          this.logs = data.data?.logs ?? data.logs ?? [];
        } catch {}
      },
      async start() {
        if (!await Modal.confirm('Start self-improvement', 'The AI will iterate over every crash not yet learned, read the crash code, and distill knowledge into the internal code-analysis knowledge base. This may take a while and consumes provider quota.', 'Start')) return;
        this.loading = true; this.message = ''; this.failed = false;
        try {
          const res = await fetch('/api/v1/analysis-self-improve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.selectedModel || undefined }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'Request failed');
          this.job = data.data?.job ?? data.job;
          this.active = true;
          this.startPolling();
        } catch (error) { this.message = error.message; this.failed = true; }
        this.loading = false;
      },
      async cancel() {
        if (!await Modal.confirm('Cancel self-improvement', 'Stop the running self-improvement job? Already processed crashes stay learned.', 'Cancel job')) return;
        this.loading = true;
        try {
          const res = await fetch('/api/v1/analysis-self-improve/cancel', { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'Request failed');
          this.job = data.data?.job ?? data.job;
          this.active = false;
          this.stopPolling();
        } catch (error) { this.message = error.message; this.failed = true; }
        this.loading = false;
      },
      startPolling() {
        this.stopPolling();
        this.pollTimer = setInterval(() => {
          this.load();
          if (this.job && !this.active && !['running'].includes(this.job.status)) this.stopPolling();
        }, 2000);
      },
      stopPolling() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      },
      progressPercent() {
        if (!this.job || !this.job.total_count) return 0;
        return Math.min(100, Math.round((this.job.processed_count / this.job.total_count) * 100));
      },
    }));
  });
})();
