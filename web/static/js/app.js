// ── Crash Report Server - Shared JavaScript ──

// Helper: read cookie by name
function readCookie(name) {
  const prefix = encodeURIComponent(name) + '=';
  const item = document.cookie.split('; ').find(value => value.startsWith(prefix));
  return item ? decodeURIComponent(item.substring(prefix.length)) : '';
}

// Helper: format date
function formatDate(d) { if (!d) return '-'; return new Date(d).toLocaleString(); }

// Helper: format file size
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(1) + ' ' + units[i];
}

// CSRF-aware fetch wrapper
(function () {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const headers = new Headers(init.headers || {});
      headers.set('X-CSRF-Token', readCookie('csrf_token'));
      init.headers = headers;
    }
    return originalFetch(input, init);
  };
})();

// Global Modal
window.Modal = (function () {
  let resolve = null;
  const el = {
    root: () => document.getElementById('global-modal'),
    title: () => document.getElementById('modal-title'),
    msg: () => document.getElementById('modal-message'),
    input: () => document.getElementById('modal-input'),
    ok: () => document.getElementById('modal-ok-btn'),
    cancel: () => document.getElementById('modal-cancel-btn'),
  };
  function show(title, message, type, opts) {
    return new Promise(function (r) {
      resolve = r;
      el.title().textContent = title;
      el.msg().textContent = message || '';
      el.msg().style.display = message ? '' : 'none';
      el.ok().textContent = (opts && opts.okLabel) || 'OK';
      if (type === 'input') {
        el.input().style.display = '';
        el.input().value = '';
        el.input().type = (opts && opts.inputType) || 'text';
        el.input().placeholder = (opts && opts.placeholder) || '';
        el.input().focus();
      } else {
        el.input().style.display = 'none';
      }
      el.cancel().style.display = type !== 'info' ? '' : 'none';
      el.root().style.display = '';
    });
  }
  return {
    confirm: function (title, message, okLabel) { return show(title, message, 'confirm', { okLabel: okLabel }); },
    prompt: function (title, message, inputType, placeholder, okLabel) { return show(title, message, 'input', { inputType: inputType, placeholder: placeholder, okLabel: okLabel }); },
    alert: function (title, message) { return show(title, message, 'info', {}); },
    _confirm: function () {
      var result = el.input().style.display === 'none' ? true : el.input().value;
      el.root().style.display = 'none';
      if (resolve) { resolve(result); resolve = null; }
    },
    _cancel: function () {
      el.root().style.display = 'none';
      if (resolve) { resolve(null); resolve = null; }
    },
  };
})();

// Secure logout
async function secureLogout() {
  await window.fetch('/web/logout', { method: 'POST' });
  window.location.href = '/web/login';
}

// Initialize sidebar navigation based on user role
(function () {
  window.fetch('/api/v1/auth/me').then(function (response) { return response.json(); }).then(function (data) {
    if (!data.user) return;
    var el = document.getElementById('current-user');
    el.textContent = data.user.username + ' \u00b7 ' + data.user.role;

    if (data.user.role === 'ultraadmin') {
      document.getElementById('containers-link').style.display = '';
      document.querySelectorAll('.admin-only').forEach(function (n) { n.style.display = ''; });
      document.querySelectorAll('.ua-hide').forEach(function (n) { n.remove(); });
      var badge = document.getElementById('container-badge');
      badge.textContent = 'UltraAdmin \u00b7 All Containers';
      badge.style.display = '';
      badge.className = 'text-xs text-purple-400 mr-2 px-2 py-0.5 rounded bg-purple-900/30 border border-purple-700/30';
      if (window.location.pathname === '/web/' || window.location.pathname === '/web') {
        window.location.replace('/web/containers');
      }
    } else {
      document.getElementById('containers-link').remove();
      if (data.user.role === 'admin' || data.user.role === 'operator') {
        document.getElementById('accounts-link').style.display = '';
      }
      if (data.user.role === 'admin') {
        document.querySelectorAll('.admin-only').forEach(function (n) { n.style.display = ''; });
      }
      if (data.user.role !== 'admin' && data.user.role !== 'operator') {
        document.querySelectorAll('.viewer-hide').forEach(function (n) { n.remove(); });
      }
      if (data.container_name) {
        var badge = document.getElementById('container-badge');
        badge.textContent = 'Container: ' + data.container_name;
        badge.style.display = '';
        badge.className = 'text-xs text-blue-400 mr-2';
      }
    }
  }).catch(function () {});
})();
