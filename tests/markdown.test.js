import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, plainText, escapeHTML } from '../src/markdown.js';
import { icon } from '../src/icons.js';

test('escapes raw HTML and attribute payloads', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHTML('"\'&<>'), '&quot;&#39;&amp;&lt;&gt;');
});

test('renders typical diary markdown, links and code', () => {
  const html = renderMarkdown('# Сон\n\n**Яркий** *сон* с `@Море`\n\n> Цитата\n\n- Шаг\n- Второй\n\n3. Третий\n\n```js\n<script>\n```\n\n[Справка](https://example.org "Источник")');
  assert.match(html, /<h1>Сон<\/h1>/);
  assert.match(html, /<strong>Яркий<\/strong>/);
  assert.match(html, /<em>сон<\/em>/);
  assert.match(html, /<code>@Море<\/code>/);
  assert.match(html, /<blockquote><p>Цитата/);
  assert.match(html, /<ul><li>Шаг/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<pre><code class="language-js">&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.org" title="Источник" rel="noopener noreferrer" target="_blank"/);
});

test('blocks executable and obfuscated link schemes', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,test', 'vbscript:evil', 'javascript&#58;evil', 'java\tscript:evil', 'java\nscript:evil', '//tracking.example.com', '\\\\tracking.example.com', 'file:///etc/passwd']) {
    assert.ok(!renderMarkdown(`[ссылка](${url})`).includes('<a '), `unsafe URL: ${url}`);
  }
  assert.match(renderMarkdown('[Содержание](#section)'), /href="#section"/);
  assert.match(renderMarkdown('[Источник](https://example.org/a_(b))'), /href="https:\/\/example.org\/a_\(b\)"/);
});

test('does not request remote images or permit SVG payloads', () => {
  for (const url of ['https://tracker.example/image.png', '//tracker.example/image.png', '/remote.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:evil']) {
    const html = renderMarkdown(`![описание](${url})`);
    assert.ok(!html.includes('<img'), url);
    assert.match(html, /описание/);
  }
  assert.match(renderMarkdown('![Фото](data:image/png;base64,iVBORw0KGgo=)'), /<img src="data:image\/png;base64,/);
  assert.match(renderMarkdown('![Рисунок](blob:https://example.org/abc-123)'), /<img src="blob:/);
  assert.ok(!renderMarkdown('![x" onerror="alert(1)](data:image/png;base64,AAAA)').includes('alt="x"'));
});

test('inline code is never parsed as Markdown or HTML', () => {
  assert.equal(renderMarkdown('`<b>**x**</b>`'), '<p><code>&lt;b&gt;**x**&lt;/b&gt;</code></p>');
  assert.match(renderMarkdown('``code ` inside``'), /<code>code ` inside<\/code>/);
});

test('handles tables and task lists without injecting attributes', () => {
  const html = renderMarkdown('| Тема | Значение |\n| :--- | ---: |\n| <img onerror=x> | **42** |\n\n- [x] Сделано\n- [ ] Ещё шаг');
  assert.match(html, /<table><thead>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.match(html, /<strong>42<\/strong>/);
  assert.match(html, /type="checkbox" disabled checked/);
});

test('malformed delimiters remain readable and cannot break escaping', () => {
  assert.equal(renderMarkdown('**unfinished <script>'), '<p>**unfinished &lt;script&gt;</p>');
  assert.equal(renderMarkdown('[missing](javascript:alert(1))'), '<p>missing</p>');
  assert.equal(renderMarkdown('\\*literal\\*'), '<p>*literal*</p>');
  assert.equal(renderMarkdown('snake_case_word'), '<p>snake_case_word</p>');
  assert.match(renderMarkdown('~~~~\n<script>\n~~~~'), /<pre><code>&lt;script&gt;/);
});

test('plain text previews remove display markup', () => {
  assert.equal(plainText('# Заголовок\n\n**Сон** и [ссылка](https://example.org) `код`'), 'Заголовок Сон и ссылка код');
});

test('icons accept only bounded numeric dimensions and static known paths', () => {
  const svg = icon('" onload="evil', '" onload="evil');
  assert.match(svg, /width="20"/);
  assert.ok(!svg.includes('onload'));
  assert.match(icon('moon', 2000), /width="128"/);
});
