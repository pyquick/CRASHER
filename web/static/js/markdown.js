// ── Safe, limited Markdown renderer for AI assistant replies ──
// Two layers:
//   - parseMarkdown/parseInline: pure tokenizers, Node-testable.
//   - renderMarkdown: browser-only DOM builder. Never uses innerHTML;
//     all text goes through textContent, so unsupported or hostile input
//     degrades to plain text instead of executing.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else if (root) root.AiMarkdown = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isSafeUrl(url) {
    return /^(https?:|mailto:)/i.test(String(url).trim());
  }

  // ── Inline parsing ──
  // tokens: { type: 'text'|'code'|'strong'|'em'|'link', ... }
  function parseInlineEmphasis(text) {
    const tokens = [];
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__|_[^_]+_)/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > lastIndex) tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
      const value = match[0];
      const strong = value.startsWith('**') || value.startsWith('__');
      tokens.push({ type: strong ? 'strong' : 'em', text: value.slice(strong ? 2 : 1, -(strong ? 2 : 1)) });
      lastIndex = match.index + value.length;
    }
    if (lastIndex < text.length) tokens.push({ type: 'text', text: text.slice(lastIndex) });
    return tokens;
  }

  function parseInlineRich(text) {
    const tokens = [];
    const linkRe = /\[([^\]]*)\]\(([^\s]+)\)/g;
    let lastIndex = 0;
    let match;
    while ((match = linkRe.exec(text))) {
      if (match.index > lastIndex) tokens.push(...parseInlineEmphasis(text.slice(lastIndex, match.index)));
      const label = match[1];
      const href = match[2];
      if (isSafeUrl(href)) tokens.push({ type: 'link', href, label });
      else tokens.push({ type: 'text', text: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) tokens.push(...parseInlineEmphasis(text.slice(lastIndex)));
    return tokens;
  }

  function parseInline(text) {
    const tokens = [];
    const parts = String(text).split(/(`[^`]*`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
        tokens.push({ type: 'code', text: part.slice(1, -1) });
      } else {
        tokens.push(...parseInlineRich(part));
      }
    }
    return tokens;
  }

  // ── Block parsing ──
  // blocks: { type: 'heading'|'paragraph'|'code'|'list', ... }
  function parseMarkdown(raw) {
    const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^```(\S*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++; // closing fence (or end of input)
        blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
        i++;
        continue;
      }
      const listMarker = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (listMarker) {
        const ordered = /^\d+[.)]$/.test(listMarker[2]);
        const items = [];
        const markerRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
        while (i < lines.length && markerRe.test(lines[i])) {
          items.push(lines[i].replace(markerRe, '').trim());
          i++;
        }
        blocks.push({ type: 'list', ordered, items });
        continue;
      }
      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim()
        && !/^```/.test(lines[i])
        && !/^(#{1,3})\s/.test(lines[i])
        && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
        paragraph.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    }
    return blocks;
  }

  // ── DOM rendering (browser only) ──
  function renderInlineNodes(tokens, doc) {
    return tokens.map((token) => {
      switch (token.type) {
        case 'code': {
          const el = doc.createElement('code');
          el.textContent = token.text;
          return el;
        }
        case 'strong': {
          const el = doc.createElement('strong');
          el.textContent = token.text;
          return el;
        }
        case 'em': {
          const el = doc.createElement('em');
          el.textContent = token.text;
          return el;
        }
        case 'link': {
          const el = doc.createElement('a');
          el.setAttribute('href', token.href);
          el.textContent = token.label;
          if (/^https?:/i.test(token.href)) {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
          return el;
        }
        default:
          return doc.createTextNode(token.text);
      }
    });
  }

  function renderMarkdown(raw) {
    const fragment = document.createDocumentFragment();
    for (const block of parseMarkdown(raw)) {
      if (block.type === 'heading') {
        const el = document.createElement('h' + block.level);
        el.append(...renderInlineNodes(parseInline(block.text), document));
        fragment.appendChild(el);
      } else if (block.type === 'paragraph') {
        const el = document.createElement('p');
        el.append(...renderInlineNodes(parseInline(block.text), document));
        fragment.appendChild(el);
      } else if (block.type === 'code') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = block.text;
        if (block.lang) code.setAttribute('data-lang', block.lang);
        pre.appendChild(code);
        fragment.appendChild(pre);
      } else if (block.type === 'list') {
        const el = document.createElement(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) {
          const li = document.createElement('li');
          li.append(...renderInlineNodes(parseInline(item), document));
          el.appendChild(li);
        }
        fragment.appendChild(el);
      }
    }
    return fragment;
  }

  if (typeof window !== 'undefined' && window.customElements && !window.customElements.get('ai-markdown')) {
    window.customElements.define('ai-markdown', class extends HTMLElement {
      static get observedAttributes() { return ['content']; }

      connectedCallback() {
        if (this.hasAttribute('content')) this.render();
      }
      attributeChangedCallback() { this.render(); }

      render() {
        this.replaceChildren(renderMarkdown(this.getAttribute('content') || ''));
      }
    });
  }

  return { parseMarkdown, parseInline, isSafeUrl, renderMarkdown };
});
