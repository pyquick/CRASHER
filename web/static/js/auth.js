// ── Crash Report Server - Auth steps (email verification + 2FA widgets) ──
// Shared by the login page (standalone) and the accounts page (layout).
// Self-contained: does not depend on app.js.

(function () {
  function readCookie(name) {
    const prefix = encodeURIComponent(name) + '=';
    const item = document.cookie.split('; ').find(value => value.startsWith(prefix));
    return item ? decodeURIComponent(item.substring(prefix.length)) : '';
  }

  async function apiFetch(url, options) {
    options = options || {};
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrf = readCookie('csrf_token');
      if (csrf) headers.set('X-CSRF-Token', csrf);
    }
    if (options.body && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, Object.assign({}, options, { headers: headers }));
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.message || 'Request failed');
    return data;
  }

  function startCooldown(target, stop) {
    stop();
    target.resendCooldown = 60;
    target._timer = setInterval(function () {
      target.resendCooldown--;
      if (target.resendCooldown <= 0) stop();
    }, 1000);
  }

  function stopCooldown(target) {
    if (target._timer) { clearInterval(target._timer); target._timer = null; }
    target.resendCooldown = 0;
  }

  document.addEventListener('alpine:init', () => {
    // ── Shared verification window store ──
    // One widget serves every verification flow: operation 2FA (email/SMS
    // tabs), login email identity check, login TOTP, and email management
    // (add/verify). Codes are always requested explicitly (click send).
    Alpine.store('authSteps', {
      verify: {
        open: false, context: 'operation', tabs: [], tab: 'email',
        step: 'code', tempToken: '', emailId: null, emailInput: '',
        hint: '', message: '', code: '', sent: false,
        loading: false, error: '', resendCooldown: 0,
        onSuccess: null, onCancel: null, onDone: null, _timer: null,
      },

      // Compat delegates: callers keep using openEmail/open2FA; both open the
      // same unified window.
      openEmail(mode, opts) {
        if (!(window.FEATURES && window.FEATURES.emailEnabled)) return;
        opts = opts || {};
        if (mode === 'login') {
          this.openVerify({ context: 'login-email', tempToken: opts.tempToken || '', message: opts.message || '', onDone: opts.onDone || null, onCancel: opts.onCancel || null });
        } else if (mode === 'add') {
          this.openVerify({ context: 'email-add', onDone: opts.onDone || null, onCancel: opts.onCancel || null });
        } else {
          this.openVerify({ context: 'email-verify', emailId: opts.emailId || null, onDone: opts.onDone || null, onCancel: opts.onCancel || null });
        }
      },
      open2FA(opts) {
        opts = opts || {};
        if (opts.context === 'login') {
          this.openVerify({ context: 'login-2fa', method: opts.method || 'totp', tempToken: opts.tempToken || '', onSuccess: opts.onSuccess || null, onCancel: opts.onCancel || null });
        } else {
          this.openVerify({
            context: 'operation', method: opts.method || 'email',
            available_methods: opts.available_methods || [],
            tempToken: opts.tempToken || '', hint: opts.hint || '', message: opts.message || '',
            onSuccess: opts.onSuccess || null, onCancel: opts.onCancel || null,
          });
        }
      },

      openVerify(opts) {
        const v = this.verify;
        v.open = true;
        v.context = opts.context || 'operation';
        v.tempToken = opts.tempToken || '';
        v.emailId = opts.emailId || null;
        v.emailInput = '';
        v.hint = opts.hint || '';
        v.message = opts.message || '';
        v.code = '';
        v.error = '';
        v.sent = false;
        v.loading = false;
        v.step = 'code';
        v.onSuccess = opts.onSuccess || null;
        v.onCancel = opts.onCancel || null;
        v.onDone = opts.onDone || null;
        if (v.context === 'operation') {
          const methods = opts.available_methods && opts.available_methods.length ? opts.available_methods : (opts.method ? [opts.method] : ['email']);
          v.tabs = methods;
          v.tab = opts.method && methods.indexOf(opts.method) !== -1 ? opts.method : methods[0];
        } else if (v.context === 'login-email') {
          v.tabs = ['email']; v.tab = 'email';
        } else if (v.context === 'email-add' || v.context === 'email-verify') {
          v.tabs = ['email']; v.tab = 'email';
          if (v.context === 'email-add') v.step = 'input';
        } else {
          v.tabs = [opts.method || 'totp']; v.tab = opts.method || 'totp';
        }
        stopCooldown(v);
      },

      closeVerify() {
        const v = this.verify;
        stopCooldown(v);
        v.open = false;
        const cancel = v.onCancel;
        v.onCancel = null;
        if (cancel) cancel();
      },

      verifyStartCooldown() { startCooldown(this.verify, () => stopCooldown(this.verify)); },
      verifyStopCooldown() { stopCooldown(this.verify); },

      // Switching verification method resets the code and the delivery state.
      verifySelect(tab) {
        const v = this.verify;
        if (v.context === 'login-2fa' || v.tabs.indexOf(tab) === -1 || v.tab === tab) return;
        v.tab = tab;
        v.code = '';
        v.error = '';
        v.sent = false;
        v.hint = '';
        v.message = '';
        this.verifyStopCooldown();
      },

      // Explicitly request the code for the current verification flow. In the
      // email-add flow the first click submits the new address instead.
      async verifySend() {
        const v = this.verify;
        v.error = '';
        v.loading = true;
        try {
          if (v.context === 'email-add' && v.step === 'input') {
            const email = v.emailInput.trim();
            if (!email) { v.error = 'Please enter an email address'; v.loading = false; return; }
            const data = await apiFetch('/api/v1/auth/me/emails', { method: 'POST', body: { email: email } });
            v.emailId = data.email_id;
            v.step = 'code';
            v.message = data.message || '';
            v.loading = false;
            return;
          }
          let data;
          if (v.context === 'operation') {
            data = await apiFetch('/api/v1/auth/2fa/send', { method: 'POST', body: { temp_token: v.tempToken, method: v.tab } });
            if (data.temp_token) v.tempToken = data.temp_token;
          } else if (v.context === 'login-email') {
            data = await apiFetch('/api/v1/auth/login/resend-email', { method: 'POST', body: { temp_token: v.tempToken } });
          } else {
            data = await apiFetch('/api/v1/auth/me/emails/' + v.emailId + '/resend', { method: 'POST', body: {} });
          }
          v.sent = true;
          v.hint = data.email_hint || v.hint;
          v.message = data.message || v.message;
          this.verifyStartCooldown();
        } catch (err) { v.error = err.message; }
        v.loading = false;
      },

      // Submit the 6-digit code for the active flow.
      async verifySubmit() {
        const v = this.verify;
        v.error = '';
        const code = v.code.replace(/\s/g, '');
        if (code.length !== 6) { v.error = 'Please enter the 6-digit code'; return; }
        v.loading = true;
        try {
          if (v.context === 'login-2fa') {
            await apiFetch('/api/v1/auth/login/totp', { method: 'POST', body: { temp_token: v.tempToken, totp_code: code } });
            this.verifyStopCooldown();
            v.open = false;
            if (v.onSuccess) v.onSuccess();
          } else if (v.context === 'login-email') {
            const data = await apiFetch('/api/v1/auth/login/verify-email', { method: 'POST', body: { temp_token: v.tempToken, code: code } });
            this.verifyStopCooldown();
            v.open = false;
            if (v.onDone) v.onDone(data);
          } else if (v.context === 'email-add' || v.context === 'email-verify') {
            await apiFetch('/api/v1/auth/me/emails/' + v.emailId + '/verify', { method: 'POST', body: { code: code } });
            this.verifyStopCooldown();
            v.open = false;
            if (v.onDone) v.onDone();
          } else {
            await apiFetch('/api/v1/auth/2fa/verify', { method: 'POST', body: { temp_token: v.tempToken, code: code } });
            this.verifyStopCooldown();
            v.open = false;
            if (v.onSuccess) v.onSuccess();
          }
        } catch (err) { v.error = err.message; }
        v.loading = false;
      },

    });

    // ── Login page flow (standalone page) ──
    Alpine.data('authFlow', () => ({
      username: '', password: '', email: '', confirmPassword: '',
      containerId: '', containers: [], loading: false, checking: true, needsSetup: false, errorMsg: '',
      emailEnabled: (window.FEATURES && window.FEATURES.emailEnabled) === true,

      async checkSetup() {
        try {
          const res = await fetch('/api/v1/auth/setup-status');
          const data = await res.json();
          this.needsSetup = !!data.needs_setup;
          if (!this.needsSetup) {
            const cRes = await fetch('/api/v1/auth/containers/active');
            const cData = await cRes.json();
            this.containers = cData.items || [];
          }
        } catch {}
        this.checking = false;
      },

      async doSetup() {
        this.errorMsg = '';
        if (this.password !== this.confirmPassword) {
          this.errorMsg = 'Passwords do not match';
          return;
        }
        if (this.password.length < 12) {
          this.errorMsg = 'Password must be at least 12 characters';
          return;
        }
        this.loading = true;
        try {
          const body = { username: this.username, password: this.password };
          if (this.emailEnabled && this.email) body.email = this.email;
          const res = await fetch('/api/v1/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            window.location.href = '/web/';
          } else {
            this.errorMsg = data.message || 'Setup failed';
          }
        } catch (err) {
          this.errorMsg = 'Network error';
        }
        this.loading = false;
      },

      async login() {
        this.errorMsg = '';
        this.loading = true;
        try {
          const body = { username: this.username, password: this.password };
          if (this.containerId) body.container_id = parseInt(this.containerId);
          const res = await fetch('/web/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            this.handleLoginResponse(data);
          } else {
            this.errorMsg = data.message || 'Login failed';
          }
        } catch (err) {
          this.errorMsg = 'Network error';
        }
        this.loading = false;
      },

      handleLoginResponse(data) {
        if (data.email_verification) {
          const step = data.email_verification;
          Alpine.store('authSteps').openEmail('login', {
            tempToken: step.temp_token,
            message: step.message || '',
            onDone: (next) => this.handleLoginResponse(next),
          });
        } else if (data.two_factor) {
          const step = data.two_factor;
          Alpine.store('authSteps').open2FA({
            context: 'login',
            method: step.method || 'totp',
            tempToken: step.temp_token,
            onSuccess: () => this.redirectAfterLogin(),
          });
        } else {
          this.redirectAfterLogin();
        }
      },

      redirectAfterLogin() {
        const params = new URLSearchParams(window.location.search);
        const requestedRedirect = params.get('redirect') || '/web/';
        window.location.href = requestedRedirect.startsWith('/') && !requestedRedirect.startsWith('//')
          ? requestedRedirect
          : '/web/';
      },
    }));
  });
})();
