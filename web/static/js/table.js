// ── Crash Report Server - Shared Data Table Utilities ──

/**
 * Build query string from filter object (excludes empty values).
 * Usage: buildQuery({ page: 1, status: 'open', search: '' }) → "page=1&status=open"
 */
function buildQuery(params) {
  return Object.entries(params)
    .filter(function (_ref) { var value = _ref[1]; return value !== '' && value !== null && value !== undefined; })
    .map(function (_ref2) { var key = _ref2[0], value = _ref2[1]; return encodeURIComponent(key) + '=' + encodeURIComponent(value); })
    .join('&');
}

/**
 * Reload table data with current page and filters.
 * Usage in Alpine component:
 *   async load() {
 *     const data = await fetchTableData('/api/v1/crash-groups', this.page, this.page_size, this.filters);
 *     if (data) { this.items = data.items; this.total = data.total; this.total_pages = data.total_pages; }
 *     else { this.error = data === null ? 'Network error' : ''; }
 *   }
 */
async function fetchTableData(url, page, pageSize, filters) {
  var params = Object.assign({ page: String(page), page_size: String(pageSize) }, filters || {});
  var queryStr = buildQuery(params);
  try {
    var response = await fetch(url + '?' + queryStr);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    return { items: data.items || [], total: data.total || 0, page: data.page || page, total_pages: data.total_pages || 1 };
  } catch (err) {
    console.error('Failed to load table data:', err);
    return null;
  }
}

/**
 * Go to page helper. Handles boundary check and scroll.
 * Usage: goTo(page) { goToPage(page, this); }
 */
function goToPage(p, ctx) {
  if (p < 1 || p > ctx.total_pages) return;
  ctx.page = p;
  ctx.load();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Render pagination HTML string.
 * Usage in Alpine template: <div x-html="paginationHtml"></div>
 */
function renderPaginationHtml() {
  return '<div class="flex items-center justify-between mt-4 text-sm">' +
    '<span class="text-gray-500" x-text="\'Page \' + page + \' of \' + total_pages + \' (\' + total + \' total)\'"></span>' +
    '<div class="flex gap-2">' +
    '<button @click="goTo(page - 1)" :disabled="page <= 1" class="btn-page">\u2190 Prev</button>' +
    '<button @click="goTo(page + 1)" :disabled="page >= total_pages" class="btn-page">Next \u2192</button>' +
    '</div></div>';
}

/**
 * Debounce timer — used for search input.
 * Usage: @keyup="debounceSearch"
 */
function debounceTimer(ctx, delay) {
  if (ctx._searchTimer) clearTimeout(ctx._searchTimer);
  ctx._searchTimer = setTimeout(function () { ctx.load(); }, delay || 300);
}
