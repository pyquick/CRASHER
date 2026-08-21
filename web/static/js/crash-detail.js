// ── Crash Detail Page ──
// Page-level Alpine component for pages/app/crash_detail.html.

document.addEventListener('alpine:init', () => {
  Alpine.data('crashDetail', () => ({
    group: null,
    reports: [],
    latestReport: null,
    selectedReport: null,
    showReportModal: false,
    attachments: [],
    dumpParsed: [],
    analysis: null,
    treeHTML: '',
    expandedNodes: {},
    importMsg: '',
    importErr: false,
    importProgress: '',
    newStatus: 'open',
    resolvedVersion: '',
    statusMsg: '',
    statusErr: false,

    async init() {
      const id = window.location.pathname.split('/').pop();
      await this.loadGroup(id);
      await this.loadAnalysis();
    },

    async loadGroup(id) {
      try {
        const res = await fetch('/api/v1/crash-groups/' + id);
        const data = await res.json();
        if (res.ok) {
          this.group = data;
          this.reports = data.recent_reports || [];
          this.latestReport = this.reports[0] || null;
          this.newStatus = data.status || 'open';
          this.resolvedVersion = data.resolved_version || '';
          await this.loadAttachmentsAndDump();
        } else {
          this.group = null;
        }
      } catch (err) {
        console.error('Failed to load group:', err);
      }
    },

    async loadAttachmentsAndDump() {
      if (!this.latestReport) return;
      try {
        const res = await fetch('/api/v1/download/report/' + this.latestReport.id);
        const data = await res.json();
        this.attachments = data.attachments || [];
        if (data.dump_info) {
          try {
            this.dumpParsed = JSON.parse(data.dump_info);
          } catch {
            this.dumpParsed = [];
          }
        }
      } catch {}
    },

    async updateStatus() {
      this.statusMsg = '';
      this.statusErr = false;
      try {
        const id = window.location.pathname.split('/').pop();
        const body = { status: this.newStatus };
        if (this.newStatus === 'resolved' && this.resolvedVersion) {
          body.resolved_version = this.resolvedVersion;
        }
        const res = await fetch('/api/v1/crash-groups/' + id + '/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          this.statusMsg = 'Status updated!';
          this.group.status = this.newStatus;
          if (body.resolved_version) this.group.resolved_version = body.resolved_version;
        } else {
          const err = await res.json();
          this.statusMsg = err.message || 'Update failed';
          this.statusErr = true;
        }
      } catch (err) {
        this.statusMsg = 'Network error';
        this.statusErr = true;
      }
    },

    async onImportFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      this.importMsg = '';
      this.importErr = false;
      this.importProgress = 'Uploading and analyzing...';

      try {
        const formData = new FormData();
        formData.append('package', file);

        let res = await fetch('/api/v1/import', { method: 'POST', body: formData });
        const dryResult = await res.json();

        if (!res.ok) {
          this.importMsg = dryResult.message || 'Import failed';
          this.importErr = true;
          this.importProgress = '';
          return;
        }

        if (dryResult.conflicts?.length > 0) {
          this.importMsg = 'Conflicts found: ' + dryResult.conflicts.map(c => c.detail).join(', ');
          this.importErr = true;
        }
        this.importProgress = 'Importing...';
        const formData2 = new FormData();
        formData2.append('package', file);
        res = await fetch('/api/v1/import?confirm=true', { method: 'POST', body: formData2 });
        const result = await res.json();
        if (res.ok) {
          this.importMsg = `Imported: ${result.new_reports} reports, ${result.new_attachments} attachments (group #${result.group_id})`;
          this.importErr = false;
        } else {
          this.importMsg = result.message || 'Import failed';
          this.importErr = true;
        }
      } catch (err) {
        this.importMsg = 'Network error during import';
        this.importErr = true;
      }
      this.importProgress = '';
      event.target.value = '';
    },

    plainAnalysisSummary() {
      const text = (this.analysis?.summary || '')
        .replace(/^##\s+[^\n]+\n*/m, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/`/g, '');
      return text
        .split('\n')
        .filter(line => !line.startsWith('Exception:') && !line.startsWith('Crash Site:'))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    sourceLocationLabel(location) {
      if (!location) return '';
      return location.file_path + ':' + location.line_number;
    },

    topRootCause() {
      return (this.analysis?.source_analysis?.root_cause_candidates || [])[0] || null;
    },

    crashPath() {
      const deep = this.analysis?.source_analysis?.crash_path;
      return deep && deep.length ? deep : (this.analysis?.crash_path || []);
    },

    suggestedFixes() {
      const deep = this.analysis?.source_analysis?.fixes;
      return deep && deep.length ? deep : (this.analysis?.suggestions || []);
    },

    isPythonAnalysis() {
      return this.analysis?.detected_language === 'python';
    },

    rootCauseLabel(kind) {
      return {
        'none-return': 'None return',
        'missing-attribute': 'Missing attribute',
        'missing-key': 'Missing key',
        'out-of-range': 'Out of range',
        'type-mismatch': 'Type mismatch',
        'undefined-name': 'Undefined name',
        'import-failure': 'Import failure',
        'recursion': 'Recursion',
        'generic': 'Possible cause',
      }[kind] || kind;
    },

    rootCauseClass(kind) {
      return {
        'none-return': 'bg-red-900/50 text-red-300',
        'missing-attribute': 'bg-orange-900/50 text-orange-300',
        'missing-key': 'bg-amber-900/50 text-amber-300',
        'out-of-range': 'bg-yellow-900/50 text-yellow-300',
        'type-mismatch': 'bg-orange-900/50 text-orange-300',
        'undefined-name': 'bg-purple-900/50 text-purple-300',
        'import-failure': 'bg-cyan-900/50 text-cyan-300',
        'recursion': 'bg-pink-900/50 text-pink-300',
        'generic': 'bg-gray-800 text-gray-400',
      }[kind] || 'bg-gray-800 text-gray-400';
    },

    crashPathStepClass(step) {
      if (!step || step.role === 'root-cause') {
        return 'border-purple-700 bg-purple-950/40 text-purple-200';
      }
      return {
        trigger: 'border-red-800 bg-red-950/40 text-red-200',
        propagation: 'border-orange-800 bg-orange-950/40 text-orange-200',
        source: 'border-yellow-800 bg-yellow-950/40 text-yellow-200',
        framework: 'border-gray-700 bg-gray-900 text-gray-400',
        unknown: 'border-gray-800 bg-surface-900 text-gray-400',
      }[step.severity] || 'border-gray-800 bg-surface-900 text-gray-400';
    },

    symbolicationWarnings(info) {
      try {
        const warnings = JSON.parse(info).warnings || [];
        return warnings.join(' · ');
      } catch {
        return '';
      }
    },

    async loadAnalysis() {
      if (!this.latestReport) return;
      try {
        const res = await fetch('/api/v1/crash-reports/' + this.latestReport.id + '/analysis');
        if (res.ok) {
          this.analysis = await res.json();
          this.expandedNodes = {};
          this.initExpandedNodes(this.analysis.file_tree);
          this.buildTreeHTML();
        }
      } catch (err) {
        console.error('Failed to load analysis:', err);
      }
    },

    buildTreeHTML() {
      const nodes = this.analysis?.file_tree;
      this.treeHTML = nodes?.length ? this.renderTreeNodes(nodes, 1) : '';
    },

    initExpandedNodes(nodes) {
      if (!nodes) return;
      nodes.forEach(node => {
        if (!node.is_file) {
          this.expandedNodes[node.path] = true;
          this.initExpandedNodes(node.children);
        }
      });
    },

    languageLabel(lang) {
      const labels = {
        csharp: 'C# / Unity', cpp: 'C++', c: 'C',
        go: 'Go', python: 'Python',
        node: 'Node.js', browser: 'Browser JS',
        unknown: 'Auto-detected'
      };
      return labels[lang] || (lang ? lang.toUpperCase() : 'Unknown');
    },

    renderTreeNodes(nodes, level) {
      const role = level === 1 ? 'tree' : 'group';
      return `<ul class="tree-list" role="${role}">${nodes.map(node => this.renderTreeNode(node, level)).join('')}</ul>`;
    },

    renderTreeNode(node, level) {
      const name = this.escapeHtml(node.name);
      const path = this.escapeAttribute(node.path);
      const severity = ['red', 'orange', 'yellow', 'gray'].includes(node.severity) ? node.severity : 'gray';
      const children = node.children || [];

      if (!node.is_file) {
        const expanded = !!this.expandedNodes[node.path];
        const childTree = children.length
          ? `<ul class="tree-list${expanded ? '' : ' collapsed'}" role="group">${children.map(child => this.renderTreeNode(child, level + 1)).join('')}</ul>`
          : '';
        return [
          `<li class="tree-node" role="treeitem" aria-level="${level}" aria-expanded="${expanded}">`,
          `<button type="button" class="tree-row tree-dir" data-tree-toggle="${path}" tabindex="0">`,
          `<span class="tree-chevron${expanded ? ' expanded' : ''}" aria-hidden="true"></span>`,
          `<span class="tree-kind tree-kind-dir">dir</span>`,
          `<span class="tree-name" title="${path}">${name}</span>`,
          `<span class="tree-meta">${children.length} item${children.length === 1 ? '' : 's'}</span>`,
          `</button>`,
          childTree,
          `</li>`,
        ].join('');
      }

      const extension = this.escapeHtml(this.fileExtension(node.name));
      const line = node.line_number ? `<span class="tree-line-num">line ${node.line_number}</span>` : '';
      const crashTag = node.is_crash_site ? `<span class="tree-crash-tag">Crash site${node.line_number ? ` · line ${node.line_number}` : ''}</span>` : line;
      return [
        `<li class="tree-node" role="treeitem" aria-level="${level}">`,
        `<div class="tree-row tree-file tree-severity-${severity}" title="${path}">`,
        `<span class="tree-file-spacer" aria-hidden="true"></span>`,
        `<span class="tree-kind">${extension}</span>`,
        `<span class="tree-name">${name}</span>`,
        `<span>${crashTag}</span>`,
        `</div>`,
        `</li>`,
      ].join('');
    },

    toggleTreePath(path, expanded) {
      if (expanded) this.expandedNodes[path] = true;
      else delete this.expandedNodes[path];
      this.buildTreeHTML();
    },

    onTreeClick(event) {
      const row = event.target.closest('[data-tree-toggle]');
      if (!row) return;
      const path = row.getAttribute('data-tree-toggle');
      if (path) this.toggleTreePath(path, !this.expandedNodes[path]);
    },

    onTreeKeydown(event) {
      const row = event.target.closest('[data-tree-toggle]');
      if (!row) return;
      const path = row.getAttribute('data-tree-toggle');
      if (!path) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.toggleTreePath(path, !this.expandedNodes[path]);
      } else if (event.key === 'ArrowRight' && !this.expandedNodes[path]) {
        event.preventDefault();
        this.toggleTreePath(path, true);
      } else if (event.key === 'ArrowLeft' && this.expandedNodes[path]) {
        event.preventDefault();
        this.toggleTreePath(path, false);
      }
    },

    fileExtension(filename) {
      const dot = (filename || '').lastIndexOf('.');
      return dot >= 0 && dot < filename.length - 1 ? filename.substring(dot + 1).toLowerCase() : 'file';
    },

    escapeHtml(value) {
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    escapeAttribute(value) {
      return this.escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
  }));
});
