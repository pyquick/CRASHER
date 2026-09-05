// ── Crash Report Server - Accounts page (email/2FA/accounts/API keys) ──

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
    Alpine.data('accountSecurity', () => ({
      users: [], keys: [], emails: [], currentUserId: null, isAdmin: false,
      showCreate: false, showCreateKey: false, createdKey: '', message: '', failed: false, loading: false,
      // Per-section messages: each widget shows its own prompts, not the Accounts section
      emailMsg: '', emailFailed: false, totpMsg: '', totpFailed: false, keyMsg: '', keyFailed: false,
      newKey: { name: '', tier: 'operator', minute_limit: 0, daily_limit: 0 },
      newUser: { username: '', password: '', role: 'viewer' },
      // Login email-verification preference
      hasVerifiedEmail: false, verifyEmailOnLogin: 0,
      // Server-rendered gate; defaults to false so a missing flag never shows the section.
      emailEnabled: (window.FEATURES && window.FEATURES.emailEnabled) === true,
      // TOTP
      totpEnabled: false, totpCode: '',
      totpSetup: { show: false, loading: false, secret: '', error: '' },
      totpDisable: { show: false, loading: false, error: '' },

      // Request helper: transparently handles 403 2FA challenges via the authSteps widget.
      async request(url, options = {}) { return requestWith2FA(url, options); },

      async load() {
        this.loading = true;
        this.users = [];
        this.keys = [];
        this.emails = [];
        try {
          const u = await this.request('/api/v1/auth/users');
          this.users = u.items;
        } catch (e) { this.notify(e.message, true); }
        try {
          const k = await this.request('/api/v1/auth/api-keys');
          this.keys = k.items;
        } catch (e) { this.notifyKeys(e.message, true); }
        try {
          const em = await this.request('/api/v1/auth/me/emails');
          this.emails = em.items;
        } catch (e) { this.notifyEmail(e.message, true); }
        try {
          const me = await this.request('/api/v1/auth/me');
          this.currentUserId = me.user.id;
          this.totpEnabled = !!me.user.totp_enabled;
          this.isAdmin = me.user.role === 'admin';
          this.hasVerifiedEmail = !!me.user.has_verified_email;
          this.verifyEmailOnLogin = me.user.verify_email_on_login || 0;
          if (me.user.email_verification_enabled !== undefined) this.emailEnabled = me.user.email_verification_enabled === true;
        } catch (e) { this.notify(e.message, true); }
        this.loading = false;
      },

      notify(message, failed = false) { this.message = message; this.failed = failed; },
      notifyEmail(message, failed = false) { this.emailMsg = message; this.emailFailed = failed; },
      notifyTotp(message, failed = false) { this.totpMsg = message; this.totpFailed = failed; },
      notifyKeys(message, failed = false) { this.keyMsg = message; this.keyFailed = failed; },

      // ── Email ──
      addEmail() {
        Alpine.store('authSteps').openEmail('add', { onDone: () => this.load() });
      },
      verifyEmail(e) {
        Alpine.store('authSteps').openEmail('verify', {
          emailId: e.id,
          message: 'Enter the verification code sent to ' + e.email + '.',
          onDone: () => this.load(),
        });
      },
      async toggleVerifyEmailOnLogin() {
        const enabled = this.verifyEmailOnLogin !== 1;
        try {
          await this.request('/api/v1/auth/me/verify-email-on-login', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          this.verifyEmailOnLogin = enabled ? 1 : 0;
          this.notifyEmail(enabled ? 'Email verification on login enabled' : 'Email verification on login disabled');
        } catch (e) {
          this.notifyEmail(e.message, true);
        }
      },
      async setPrimary(e) {
        try {
          await this.request('/api/v1/auth/me/emails/' + e.id + '/primary', { method: 'POST' });
          await this.load();
        } catch (err) { this.notifyEmail(err.message, true); }
      },
      async removeEmail(e) {
        if (!await Modal.confirm('Remove Email', 'Remove ' + e.email + '?', 'Remove')) return;
        try {
          await this.request('/api/v1/auth/me/emails/' + e.id, { method: 'DELETE' });
          await this.load();
        } catch (err) { this.notifyEmail(err.message, true); }
      },

      // ── 2FA (TOTP, admin only) ──
      toggleTotp() {
        if (this.totpEnabled) this.disableTotpPrompt();
        else this.setupTotp();
      },
      async setupTotp() {
        this.totpSetup = { show: true, loading: true, secret: '', error: '' };
        try {
          const r = await this.request('/api/v1/auth/me/totp/setup');
          this.totpSetup.secret = r.secret;
          this.totpCode = '';
          renderQr(r.qr_uri);
        } catch (e) {
          this.totpSetup.show = false;
          this.notifyTotp(e.message, true);
        }
        this.totpSetup.loading = false;
      },
      totpAutoVerify() {
        if (this.totpCode.replace(/\s/g, '').length === 6) this.confirmTotp();
      },
      async confirmTotp() {
        this.totpSetup.error = '';
        if (this.totpSetup.loading) return;
        this.totpSetup.loading = true;
        try {
          await this.request('/api/v1/auth/me/totp/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: this.totpCode.replace(/\s/g, ''), secret: this.totpSetup.secret }),
          });
          this.totpEnabled = true;
          this.totpSetup.show = false;
          this.totpCode = '';
          this.notifyTotp('2FA enabled');
        } catch (e) {
          this.totpSetup.error = e.message;
        }
        this.totpSetup.loading = false;
      },
      disableTotpPrompt() {
        this.totpDisable = { show: true, loading: false, error: '' };
        this.totpCode = '';
      },
      async doDisableTotp() {
        this.totpDisable.error = '';
        this.totpDisable.loading = true;
        try {
          await this.request('/api/v1/auth/me/totp/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: this.totpCode }),
          });
          this.totpEnabled = false;
          this.totpDisable.show = false;
          this.totpCode = '';
          this.notifyTotp('2FA disabled');
        } catch (e) {
          this.totpDisable.error = e.message;
        }
        this.totpDisable.loading = false;
      },

      // ── Accounts ──
      async createUser() {
        try {
          const p = { username: this.newUser.username, role: this.newUser.role };
          if (this.newUser.password) p.password = this.newUser.password;
          const r = await this.request('/api/v1/auth/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
          });
          this.newUser = { username: '', password: '', role: 'viewer' };
          this.showCreate = false;
          const pw = r.initial_password;
          this.notify(pw ? 'Account created. One-time password (copy now): ' + pw : 'Account created');
          await this.load();
        } catch (e) { this.notify(e.message, true); }
      },
      async updateUser(user) {
        try {
          await this.request('/api/v1/auth/users/' + user.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: user.role }),
          });
          this.notify('Account updated');
        } catch (e) {
          this.notify(e.message, true);
          await this.load();
        }
      },
      async toggleUser(user) {
        if (user.id === this.currentUserId) {
          this.notify('You cannot disable your own account', true);
          return;
        }
        try {
          await this.request('/api/v1/auth/users/' + user.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: !Boolean(user.is_active) }),
          });
          this.notify('Account updated');
          await this.load();
        } catch (e) { this.notify(e.message, true); }
      },

      // ── API Keys ──
      async createKeyFromForm() {
        try {
          const k = await this.request('/api/v1/auth/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.newKey),
          });
          this.createdKey = k.key;
          this.showCreateKey = false;
          this.newKey = { name: '', tier: 'operator', minute_limit: 0, daily_limit: 0 };
          await this.load();
        } catch (e) { this.notifyKeys(e.message, true); }
      },
      async editLimits(key) {
        const minuteLimit = await Modal.prompt('API Key Limits', 'Requests per minute. Enter 0 for unlimited.', 'number', String(key.minute_limit ?? 0), 'Next');
        if (minuteLimit === null) return;
        const dailyLimit = await Modal.prompt('API Key Limits', 'Requests per day. Enter 0 for unlimited.', 'number', String(key.daily_limit ?? 0), 'Save');
        if (dailyLimit === null) return;
        try {
          await this.request('/api/v1/auth/api-keys/' + key.id + '/limits', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ minute_limit: Number(minuteLimit), daily_limit: Number(dailyLimit) }),
          });
          key.minute_limit = Number(minuteLimit);
          key.daily_limit = Number(dailyLimit);
          this.notifyKeys('API key limits updated');
        } catch (e) { this.notifyKeys(e.message, true); }
      },
      async revokeKey(key) {
        if (!await Modal.confirm('Revoke API Key', 'Permanently revoke key "' + key.name + '"?', 'Revoke')) return;
        try {
          await this.request('/api/v1/auth/api-keys/' + key.id, { method: 'DELETE' });
          this.notifyKeys('API key revoked');
          await this.load();
        } catch (e) { this.notifyKeys(e.message, true); }
      },
      async updateTier(key, ev) {
        const tier = ev.target.value;
        if (!await Modal.confirm('Change Tier', 'Change "' + key.name + '" tier to ' + tier + '?', 'Change')) {
          ev.target.value = key.tier;
          return;
        }
        try {
          await this.request('/api/v1/auth/api-keys/' + key.id + '/tier', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tier }),
          });
          key.tier = tier;
          this.notifyKeys('Tier updated');
        } catch (e) {
          ev.target.value = key.tier;
          this.notifyKeys(e.message, true);
        }
      },
      tierClass(tier) {
        return { admin: 'bg-red-900/50 text-red-300', operator: 'bg-blue-900/50 text-blue-300', viewer: 'bg-gray-700 text-gray-300' }[tier] || 'bg-gray-700 text-gray-300';
      },
    }));
  });

  function renderQr(uri) {
    const el = document.getElementById('totp-qr');
    if (!el) return;
    el.innerHTML = '';
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, size, size); };
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(uri);
    el.appendChild(canvas);
  }
})();
