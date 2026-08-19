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
    // ── Shared widget store ──
    Alpine.store('authSteps', {
      email: {
        open: false, mode: 'login', step: 'code', title: '', message: '',
        emailId: null, emailInput: '', tempToken: '', code: '',
        loading: false, error: '', resendCooldown: 0, onDone: null, onCancel: null, _timer: null,
      },
      twoFactor: {
        open: false, context: 'operation', method: 'totp', tempToken: '',
        hint: '', message: '', code: '',
        loading: false, error: '', resendCooldown: 0, onSuccess: null, onCancel: null, _timer: null,
      },

      openEmail(mode, opts) {
        opts = opts || {};
        const e = this.email;
        e.open = true;
        e.mode = mode;
        e.step = mode === 'add' ? 'input' : 'code';
        e.title = opts.title || (mode === 'add' ? 'Add Email Address' : 'Verify your email');
        e.message = opts.message || '';
        e.emailId = opts.emailId || null;
        e.tempToken = opts.tempToken || '';
        e.emailInput = '';
        e.code = '';
        e.error = '';
        e.loading = false;
        e.onDone = opts.onDone || null;
        e.onCancel = opts.onCancel || null;
        stopCooldown(e);
        if (mode === 'login') startCooldown(e, () => stopCooldown(e));
      },

      closeEmail() {
        const e = this.email;
        stopCooldown(e);
        e.open = false;
        if (e.onCancel) e.onCancel();
      },

      emailStartCooldown() { startCooldown(this.email, () => stopCooldown(this.email)); },
      emailStopCooldown() { stopCooldown(this.email); },

      async emailSubmit() {
        const e = this.email;
        e.error = '';
        if (e.mode === 'add' && e.step === 'input') {
          const email = e.emailInput.trim();
          if (!email) { e.error = 'Please enter an email address'; return; }
          e.loading = true;
          try {
            const data = await apiFetch('/api/v1/auth/me/emails', { method: 'POST', body: { email: email } });
            e.emailId = data.email_id;
            e.step = 'code';
            e.message = data.message || '';
            this.emailStartCooldown();
          } catch (err) { e.error = err.message; }
          e.loading = false;
          return;
        }
        const code = e.code.replace(/\s/g, '');
        if (code.length !== 6) { e.error = 'Please enter the 6-digit code'; return; }
        e.loading = true;
        try {
          if (e.mode === 'login') {
            const data = await apiFetch('/api/v1/auth/login/verify-email', {
              method: 'POST', body: { temp_token: e.tempToken, code: code },
            });
            this.emailStopCooldown();
            e.open = false;
            if (e.onDone) e.onDone(data);
          } else {
            await apiFetch('/api/v1/auth/me/emails/' + e.emailId + '/verify', { method: 'POST', body: { code: code } });
            this.emailStopCooldown();
            e.open = false;
            if (e.onDone) e.onDone();
          }
        } catch (err) { e.error = err.message; }
        e.loading = false;
      },

      async emailResend() {
        const e = this.email;
        e.error = '';
        e.loading = true;
        try {
          let data;
          if (e.mode === 'login') {
            data = await apiFetch('/api/v1/auth/login/resend-email', { method: 'POST', body: { temp_token: e.tempToken } });
          } else {
            data = await apiFetch('/api/v1/auth/me/emails/' + e.emailId + '/resend', { method: 'POST' });
          }
          e.message = data.message || e.message;
          this.emailStartCooldown();
        } catch (err) { e.error = err.message; }
        e.loading = false;
      },

      open2FA(opts) {
        opts = opts || {};
        const t = this.twoFactor;
        t.open = true;
        t.context = opts.context || 'operation';
        t.method = opts.method || 'totp';
        t.tempToken = opts.tempToken || '';
        t.hint = opts.hint || '';
        t.message = opts.message || '';
        t.code = '';
        t.error = '';
        t.loading = false;
        t.onSuccess = opts.onSuccess || null;
        t.onCancel = opts.onCancel || null;
        stopCooldown(t);
        if (t.method !== 'totp') startCooldown(t, () => stopCooldown(t));
      },

      close2FA() {
        const t = this.twoFactor;
        stopCooldown(t);
        t.open = false;
        if (t.onCancel) t.onCancel();
      },

      twoFactorStartCooldown() { startCooldown(this.twoFactor, () => stopCooldown(this.twoFactor)); },
      twoFactorStopCooldown() { stopCooldown(this.twoFactor); },

      async twoFactorSubmit() {
        const t = this.twoFactor;
        t.error = '';
        const code = t.code.replace(/\s/g, '');
        if (code.length !== 6) { t.error = 'Please enter the 6-digit code'; return; }
        t.loading = true;
        try {
          if (t.context === 'login') {
            await apiFetch('/api/v1/auth/login/totp', { method: 'POST', body: { temp_token: t.tempToken, totp_code: code } });
            this.twoFactorStopCooldown();
            t.open = false;
            if (t.onSuccess) t.onSuccess();
          } else {
            await apiFetch('/api/v1/auth/2fa/verify', { method: 'POST', body: { temp_token: t.tempToken, code: code } });
            this.twoFactorStopCooldown();
            t.open = false;
            if (t.onSuccess) t.onSuccess();
          }
        } catch (err) { t.error = err.message; }
        t.loading = false;
      },

      async twoFactorResend() {
        const t = this.twoFactor;
        t.error = '';
        t.loading = true;
        try {
          const data = await apiFetch('/api/v1/auth/2fa/resend', { method: 'POST', body: { temp_token: t.tempToken } });
          t.message = data.message || t.message;
          this.twoFactorStartCooldown();
        } catch (err) { t.error = err.message; }
        t.loading = false;
      },
    });

    // ── Login page flow (standalone page) ──
    Alpine.data('authFlow', () => ({
      username: '', password: '', email: '', confirmPassword: '',
      containerId: '', containers: [], loading: false, checking: true, needsSetup: false, errorMsg: '',

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
          if (this.email) body.email = this.email;
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
