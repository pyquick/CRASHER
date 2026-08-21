document.addEventListener('alpine:init', () => {
  Alpine.data('aiChat', () => ({
    available: false, open: false, conversations: [], selectedId: '', conversation: null,
    model: 'deepseek-chat', models: [], messages: [], draft: '', sending: false, error: '', status: '', copiedId: null, requestController: null, panelExpanded: true, pendingGroupId: null, showCrashPicker: false, crashSearch: '', crashes: [], crashLoading: false,

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

    async loadConversations() {
      const data = await this.request('/api/v1/ai/conversations');
      this.conversations = data.items || [];
    },

    async loadConversation() {
      this.error = '';
      if (!this.selectedId) {
        this.conversation = null; this.messages = []; return;
      }
      try {
        const data = await this.request('/api/v1/ai/conversations/' + this.selectedId, { signal: undefined });
        this.conversation = data.conversation;
        this.messages = data.messages || [];
        this.$nextTick(() => this.scrollMessages());
      } catch (error) { this.error = error.message; }
    },

    async createConversation(groupId = null) {
      try {
        const data = await this.request('/api/v1/ai/conversations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(groupId ? { group_id: groupId } : {}),
        });
        this.conversation = data.conversation;
        this.messages = data.messages || [];
        this.selectedId = String(this.conversation.id);
        await this.loadConversations();
      } catch (error) { this.error = error.message; }
    },

    async newConversation() { await this.createConversation(this.pendingGroupId); this.pendingGroupId = null; },
    async deleteConversation() {
      if (!this.selectedId || !await Modal.confirm('Delete conversation', 'Delete this AI conversation?', 'Delete')) return;
      try {
        await this.request('/api/v1/ai/conversations/' + this.selectedId, { method: 'DELETE' });
        this.selectedId = ''; this.conversation = null; this.messages = [];
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
        this.conversation = data.conversation; this.messages = data.messages || [];
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
        { id: provisionalId, role: 'assistant', content: '', reasoning: null, created_at: timestamp },
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
        while (true) {
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
            } else if (event === 'done') {
              if (payload.message) {
                const index = this.messages.findIndex(item => item.id === provisionalId);
                if (index !== -1) this.messages.splice(index, 1, payload.message);
                scroll();
              }
            } else if (event === 'error') {
              throw new Error(payload.message || 'The AI request failed');
            }
          }
        }
      } catch (error) {
        this.messages = this.messages.filter(item => item.id !== provisionalId && item.id !== localUserId);
        if (error.name !== 'AbortError') this.error = error.message;
        this.draft = message;
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
