import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { parseMarkdown, parseInline, isSafeUrl } = require('../web/static/js/markdown.js');

test('markdown block parser handles headings, lists and fences', () => {
  const blocks = parseMarkdown('# Title\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n\n3. first\n4. second');
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Title' });
  assert.deepEqual(blocks[1], { type: 'list', ordered: false, items: ['one', 'two'] });
  assert.deepEqual(blocks[2], { type: 'code', lang: 'ts', text: 'const a = 1;' });
  assert.deepEqual(blocks[3], { type: 'list', ordered: true, items: ['first', 'second'] });
});

test('markdown block parser degrades unknown constructs to paragraphs', () => {
  const blocks = parseMarkdown('<img src=x onerror=alert(1)>\n\n<div>raw html stays text</div>');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].text, '<img src=x onerror=alert(1)>');
});

test('inline parser extracts code, links, bold and italic', () => {
  const tokens = parseInline('Use `npm test` and **bold** text with [docs](https://example.com/x) here');
  assert.deepEqual(tokens, [
    { type: 'text', text: 'Use ' },
    { type: 'code', text: 'npm test' },
    { type: 'text', text: ' and ' },
    { type: 'strong', text: 'bold' },
    { type: 'text', text: ' text with ' },
    { type: 'link', href: 'https://example.com/x', label: 'docs' },
    { type: 'text', text: ' here' },
  ]);
});

test('unsafe link protocols are rejected', () => {
  assert.equal(isSafeUrl('https://example.com'), true);
  assert.equal(isSafeUrl('http://example.com'), true);
  assert.equal(isSafeUrl('mailto:a@b.c'), true);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('data:text/html;base64,xxx'), false);
});

test('javascript links degrade to plain text tokens', () => {
  const tokens = parseInline('[click](javascript:alert(1))');
  assert.deepEqual(tokens, [{ type: 'text', text: '[click](javascript:alert(1))' }]);
});

test('AI chat binds text segments to the native Markdown renderer', async () => {
  const template = await readFile(new URL('../web/templates/partials/ai_chat.html', import.meta.url), 'utf8');
  assert.match(template, /<ai-markdown class="ai-chat-markdown" :content="seg\.text"><\/ai-markdown>/);
  assert.doesNotMatch(template, /x-markdown|x-effect="renderMarkdown/);
});

test('AI chat x-for template keeps a single root element per segment', async () => {
  // Alpine's x-for clones only the firstElementChild of the template, so two
  // sibling <template x-if> branches silently drop the second: markdown text
  // segments never rendered. Every branch must live inside one wrapper div.
  const template = await readFile(new URL('../web/templates/partials/ai_chat.html', import.meta.url), 'utf8');
  const xfor = template.match(/x-for="\(seg, segIndex\) in messageSegments\(item\)"[\s\S]*?<\/template>\n\s*<\/div>\n\s*<\/template>/);
  assert.ok(xfor, 'messageSegments x-for template exists');
  const inner = xfor[0];
  assert.match(inner, /<div class="ai-chat-seg">/);
  const directChildren = inner.match(/<template x-if="seg\.step">/) && inner.match(/<template x-if="!seg\.step && seg\.text">/);
  assert.ok(directChildren, 'both step and text branches are wrapped in the root div');
  const firstChild = inner.match(/messageSegments\(item\)"[^>]*>\s*<(\w+)/);
  assert.equal(firstChild[1], 'div', 'x-for template must start with the wrapper div');
});
