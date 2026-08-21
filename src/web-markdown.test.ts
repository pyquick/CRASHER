import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
