document.addEventListener('alpine:init', () => {
  Alpine.data('aiChat', () => ({
    available: false, open: false, conversations: [], selectedId: '', conversation: null,
    model: 'deepseek-chat', models: [], messages: [], events: [], tasks: [], draft: '', sending: false, error: '', status: '', copiedId: null, requestController: null, panelExpanded: true, pendingGroupId: null, showCrashPicker: false, crashSearch: '', crashes: [], crashLoading: false,

    async init() {
      if (!['/web/', '/web', '/web/crashes', '/web/feedback', '/web/symbols', '/web/accounts', '/web/containers', '/web/api-doc'].some(path => window.location.pathname === path || window.location.pathname.startsWith(path + '/'))) return;
      try {
        const status = await this.request('/api/v1/ai/status');
        this.available = !!status.configured;
        this.model = status.model || this.model;
        this.models = status.models || [];
        if (!this.available) return;
        await this.loadConversations();
        const match = window.location.pathname.match(/^\/web\/crashes\/(\d+)$/);
        if (match && !this.selectedId) {
          const existing = this.conversations.find(item => item.group_id === Number(match[1]));
          if (existing) {
            this.selectedId = String(existing.id);
            await this.loadConversation();
          } else {
            this.pendingGroupId = Number(match[1]);
          }
        }
      } catch (error) {
        this.available = false;
      }
    },

    async request(url, options = {}) {
      const response = await fetch(url, options);
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.message || 'Request failed');
      return data;
    },

    selectedModelLabel() {
      return this.models.find(option => option.value === this.model)?.label || this.model;
    },

    openPanel() {
      this.open = true;
      this.$nextTick(() => this.scrollMessages());
    },

    closePanel() {
      if (this.sending) this.stop();
      this.open = false;
    },
    conversationLabel(item) { return '#' + item.id + (item.group_id ? ' · Crash #' + item.group_id : ' · New'); },

    stepStatusLabel(status) {
      return { ok: 'Success', error: 'Error', running: 'Running', cancelled: 'Cancelled' }[status] || status;
    },

    async loadConversations() {
      const data = await this.request('/api/v1/ai/conversations');
      this.conversations = data.items || [];
    },

    buildSteps(messageId) {
      // Persisted results/subagent outcomes nest under their parent event via
      // group_id, so replay pairs them by that reference. `at` is the
      // character offset into the message text where the step was streamed.
      const steps = [];
      for (const entry of this.events.filter(event => event.message_id === messageId)) {
        const payload = entry.payload || {};
        const at = typeof payload.at === 'number' ? payload.at : 0;
        if (entry.kind === 'tool_call') {
          steps.push({ id: entry.id, name: entry.name, status: 'running', args: payload.args || '', prompt: '', summary: '', group: entry.group_id, at });
        } else if (entry.kind === 'tool_result') {
          const step = steps.find(item => item.id === entry.group_id);
          if (step) { step.status = entry.status; step.summary = payload.summary || ''; }
        } else if (entry.kind === 'subagent') {
          if (entry.status === 'running') {
            steps.push({ id: entry.id, name: 'subagent', status: 'running', args: '', prompt: payload.prompt || '', summary: '', group: entry.group_id, at });
          } else {
            const step = steps.find(item => item.id === entry.group_id);
            if (step) { step.status = entry.status; step.summary = payload.report || payload.error || entry.status; }
          }
        }
      }
      return steps;
    },

    // Splits a message into text/step segments so tool lines appear in the
    // text flow at the point they were streamed, not stacked at the top.
    messageSegments(item) {
      const content = item.content || '';
      const steps = item.steps || [];
      if (!steps.length) return content ? [{ text: content }] : [];
      const segments = [];
      let cursor = 0;
      for (const step of steps) {
        const at = Math.max(0, Math.min(typeof step.at === 'number' ? step.at : 0, content.length));
        if (at >= cursor) {
          if (at > cursor) segments.push({ text: content.slice(cursor, at) });
          segments.push({ step });
          cursor = at;
        } else {
          segments.push({ step });
        }
      }
      if (cursor < content.length) segments.push({ text: content.slice(cursor) });
      return segments;
    },

    applyConversation(data) {
      this.conversation = data.conversation;
      this.events = data.events || [];
      this.tasks = data.tasks || [];
      this.messages = (data.messages || []).map(item => ({ ...item, steps: this.buildSteps(item.id) }));
    },

    async loadConversation() {
      this.error = '';
      if (!this.selectedId) {
        this.conversation = null; this.messages = []; this.events = []; this.tasks = []; return;
      }
      try {
        const data = await this.request('/api/v1/ai/conversations/' + this.selectedId, { signal: undefined });
        this.applyConversation(data);
        this.$nextTick(() => this.scrollMessages());
      } catch (error) { this.error = error.message; }
    },

    async createConversation(groupId = null) {
      try {
        const data = await this.request('/api/v1/ai/conversations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(groupId ? { group_id: groupId } : {}),
        });
        this.applyConversation(data);
        this.selectedId = String(this.conversation.id);
        await this.loadConversations();
      } catch (error) { this.error = error.message; }
    },

    async newConversation() { await this.createConversation(this.pendingGroupId); this.pendingGroupId = null; },
    async deleteConversation() {
      if (!this.selectedId || !await Modal.confirm('Delete conversation', 'Delete this AI conversation?', 'Delete')) return;
      try {
        await this.request('/api/v1/ai/conversations/' + this.selectedId, { method: 'DELETE' });
        this.selectedId = ''; this.conversation = null; this.messages = []; this.events = []; this.tasks = [];
        await this.loadConversations();
      } catch (error) { this.error = error.message; }
    },

    async detachCrash() {
      if (!this.conversation) return;
      this.error = 'Crash detachment is available when starting a new conversation.';
    },

    async openCrashPicker() {
      this.showCrashPicker = true;
      await this.searchCrashes();
    },

    async searchCrashes() {
      this.crashLoading = true;
      try {
        const query = this.crashSearch.trim() ? '?search=' + encodeURIComponent(this.crashSearch.trim()) : '';
        const data = await this.request('/api/v1/ai/crashes' + query);
        this.crashes = data.items || [];
      } catch (error) { this.error = error.message; }
      this.crashLoading = false;
    },

    async chooseCrash(crash) {
      this.showCrashPicker = false;
      this.draft = '';
      await this.linkCrash(crash.id);
    },

    handleDraftInput() {
      const wantsCrashPicker = this.draft.trimStart().startsWith('@');
      if (wantsCrashPicker && !this.showCrashPicker) this.openCrashPicker();
      if (!wantsCrashPicker) this.showCrashPicker = false;
    },

    async linkCrash(groupId, reportId = null) {
      if (!this.selectedId) await this.createConversation(null);
      if (!this.selectedId) return;
      try {
        const data = await this.request('/api/v1/ai/conversations/' + this.selectedId + '/attach', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: groupId, report_id: reportId }),
        });
        this.applyConversation(data);
        this.pendingGroupId = null; await this.loadConversations();
      } catch (error) { this.error = error.message; }
    },

    parseCrashCommand(message) {
      const match = message.match(/^@(?:crash|bug)\s+(\d+)(?:\s+(?:report|#)?(\d+))?\s*/i);
      return match ? { groupId: Number(match[1]), reportId: match[2] ? Number(match[2]) : null, text: message.slice(match[0].length).trim() } : null;
    },
    stop() {
      if (!this.requestController) return;
      this.requestController.abort();
      this.requestController = null;
      this.sending = false;
      this.status = 'Generation stopped';
    },

    async copyMessage(item) {
      const text = item.content || '';
      if (!text) return;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.setAttribute('readonly', '');
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
        }
        this.copiedId = item.id;
        setTimeout(() => { if (this.copiedId === item.id) this.copiedId = null; }, 2000);
      } catch (error) {
        this.error = 'Copy failed';
      }
    },

    async send() {
      const rawMessage = this.draft.trim();
      const command = this.parseCrashCommand(rawMessage);
      if (command) {
        await this.linkCrash(command.groupId, command.reportId);
        if (!command.text) { this.draft = ''; return; }
      }
      const message = command?.text || rawMessage;
      if (!message || this.sending) return;
      if (!this.selectedId) await this.createConversation(this.pendingGroupId);
      if (!this.selectedId) return;
      this.pendingGroupId = null;
      this.draft = ''; this.error = ''; this.status = ''; this.sending = true;
      const controller = new AbortController();
      this.requestController = controller;
      const timestamp = new Date().toISOString();
      const localUserId = 'local-user-' + timestamp;
      const provisionalId = 'local-ai-' + timestamp;
      this.messages.push(
        { id: localUserId, role: 'user', content: message, reasoning: null, created_at: timestamp },
        { id: provisionalId, role: 'assistant', content: '', reasoning: null, created_at: timestamp, steps: [] },
      );
      // Always mutate through the reactive array so Alpine re-renders per delta.
      const liveItem = () => this.messages.find(item => item.id === provisionalId);
      const scroll = () => this.$nextTick(() => this.scrollMessages());
      try {
        const response = await fetch('/api/v1/ai/conversations/' + this.selectedId + '/messages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, model: this.model }), signal: controller.signal,
        });
        if (!response.ok) {
          let data = {};
          try { data = await response.json(); } catch {}
          throw new Error(data.message || 'Request failed');
        }
        if (!response.body) throw new Error('Streaming is not supported by this browser');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventName = 'message';
        let streamError = '';
        let streamFinished = false;
        while (!streamFinished) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;
            if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
            if (!line.startsWith('data:')) continue;
            const event = eventName;
            eventName = 'message';
            const raw = line.slice(5).trim();
            if (!raw) continue;
            let payload = {};
            try { payload = JSON.parse(raw); } catch { continue; }
            if (event === 'delta' || event === 'reasoning') {
              const item = liveItem();
              if (!item) continue;
              if (event === 'delta') item.content += payload.content || '';
              else item.reasoning = (item.reasoning || '') + (payload.content || '');
              scroll();
            } else if (event === 'tool_call') {
              this.status = 'Agent is using ' + (payload.name || 'a tool') + '…';
              const item = liveItem();
              if (!item) continue;
              item.steps = item.steps || [];
              item.steps.push({ id: payload.id, name: payload.name, status: 'running', args: payload.args || '', prompt: '', summary: '', group: payload.group ?? null, at: item.content.length });
              scroll();
            } else if (event === 'tool_result') {
              this.status = payload.status === 'error' ? 'Tool failed; Agent is continuing…' : 'Tool finished; Agent is continuing…';
              const item = liveItem();
              const step = item && (item.steps || []).find(entry => entry.id === payload.id);
              if (step) { step.status = payload.status; step.summary = payload.summary || ''; scroll(); }
            } else if (event === 'subagent') {
              this.status = payload.status === 'running' ? 'Sub-agent is investigating…'
                : payload.status === 'error' ? 'Sub-agent failed; Agent is continuing directly…'
                  : 'Sub-agent finished; Agent is continuing…';
              const item = liveItem();
              if (!item) continue;
              item.steps = item.steps || [];
              const existing = item.steps.find(entry => entry.id === payload.id);
              if (existing) { existing.status = payload.status; existing.summary = payload.summary || existing.summary; }
              else item.steps.push({ id: payload.id, name: 'subagent', status: payload.status, args: '', prompt: payload.prompt || '', summary: payload.summary || '', group: payload.group ?? null, at: item.content.length });
              scroll();
            } else if (event === 'tasks') {
              this.tasks = payload.tasks || [];
              scroll();
            } else if (event === 'done') {
              this.status = '';
              if (payload.message) {
                const index = this.messages.findIndex(item => item.id === provisionalId);
                if (index !== -1) {
                  const steps = this.messages[index].steps || [];
                  this.messages.splice(index, 1, { ...payload.message, steps });
                  scroll();
                }
              }
              if (payload.tasks) this.tasks = payload.tasks;
            } else if (event === 'error') {
              // A failed turn must not discard the output and tool activity
              // already streamed: keep them visible and show the reason.
              streamError = payload.message || 'The AI request failed';
              streamFinished = true;
              break;
            }
          }
        }
        if (streamError) throw new Error(streamError);
      } catch (error) {
        if (streamError) {
          // Server-reported failure after partial output: keep the streamed
          // content and tool steps, surface the reason.
          const item = liveItem();
          if (item && !item.content) item.content = '(no answer produced)';
          this.error = streamError;
          this.status = 'Generation stopped';
        } else {
          this.messages = this.messages.filter(item => item.id !== provisionalId && item.id !== localUserId);
          if (error.name !== 'AbortError') this.error = error.message;
          this.draft = message;
        }
      }
      if (this.requestController === controller) {
        this.requestController = null;
        this.sending = false;
      }
      scroll();
    },

    scrollMessages() {
      if (this.$refs.messages) this.$refs.messages.scrollTop = this.$refs.messages.scrollHeight;
    },
  }));
});
