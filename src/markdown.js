/** Small, deliberately HTML-free Markdown renderer. User text is never interpreted as HTML. */
export function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeURL(value, image = false) {
  const url = String(value || '').trim();
  if (!url || /[\u0000-\u0020\u007f<>"'\\]/.test(url)) return null;
  if (image) {
    // SVG and remote images are intentionally excluded: diary contents never make tracking requests.
    return /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*|blob:(?:https?:\/\/|null\/)[^\s<>"']+)$/i.test(url) ? url : null;
  }
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(url)) return url;
  if (/^(?:#|\/(?!\/)|\.\.?\/)/.test(url)) return url;
  if (!/[:&]/.test(url) && !url.startsWith('//')) return url;
  return null;
}

function linkAt(source, index, image) {
  const labelStart = index + (image ? 2 : 1);
  let labelEnd = labelStart;
  let depth = 1;
  for (; labelEnd < source.length; labelEnd++) {
    if (source[labelEnd] === '\\') { labelEnd++; continue; }
    if (source[labelEnd] === '[' && ++depth > 24) return null;
    if (source[labelEnd] === ']' && --depth === 0) break;
  }
  if (source[labelEnd + 1] !== '(') return null;
  let end = labelEnd + 2;
  depth = 1;
  for (; end < source.length; end++) {
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '(') depth++;
    if (source[end] === ')' && --depth === 0) break;
  }
  if (depth !== 0) return null;
  let destination = source.slice(labelEnd + 2, end).trim();
  let title = '';
  const titleMatch = destination.match(/^(\S+)\s+["']([^\r\n]*)["']$/);
  if (titleMatch) [, destination, title] = titleMatch;
  if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
  return { label: source.slice(labelStart, labelEnd), destination, title, end: end + 1 };
}

function inline(source, depth = 0, allowLinks = true) {
  if (depth > 12) return escapeHTML(source);
  let output = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\' && /[\\`*_{}\[\]()#+\-.!|~>]/.test(source[i + 1] || '')) {
      output += escapeHTML(source[i + 1]); i += 2; continue;
    }
    if (char === '`') {
      let count = 1;
      while (source[i + count] === '`') count++;
      const delimiter = '`'.repeat(count);
      const end = source.indexOf(delimiter, i + count);
      if (end !== -1) {
        output += `<code>${escapeHTML(source.slice(i + count, end).replace(/\n/g, ' '))}</code>`;
        i = end + count; continue;
      }
    }
    const isImage = char === '!' && source[i + 1] === '[';
    if (isImage || (char === '[' && allowLinks)) {
      const link = linkAt(source, i, isImage);
      if (link) {
        const url = safeURL(link.destination, isImage);
        if (isImage) {
          output += url ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(link.label)}" loading="lazy" decoding="async">` : `<span class="md-image-alt">${escapeHTML(link.label)}</span>`;
        } else {
          const label = inline(link.label, depth + 1, false);
          const title = link.title ? ` title="${escapeHTML(link.title)}"` : '';
          output += url ? `<a href="${escapeHTML(url)}"${title} rel="noopener noreferrer"${/^https?:/i.test(url) ? ' target="_blank"' : ''}>${label}</a>` : label;
        }
        i = link.end; continue;
      }
    }
    const delimiter = source.startsWith('**', i) ? '**' : source.startsWith('__', i) ? '__' : source.startsWith('~~', i) ? '~~' : /[*_]/.test(char) ? char : null;
    if (delimiter && !(delimiter.includes('_') && /[\p{L}\p{N}]/u.test(source[i - 1] || ''))) {
      const end = source.indexOf(delimiter, i + delimiter.length);
      if (end > i + delimiter.length) {
        const tag = delimiter === '~~' ? 'del' : delimiter.length === 2 ? 'strong' : 'em';
        output += `<${tag}>${inline(source.slice(i + delimiter.length, end), depth + 1, allowLinks)}</${tag}>`;
        i = end + delimiter.length; continue;
      }
    }
    if (char === '\n') { output += '<br>\n'; i++; continue; }
    // Consume plain text in batches instead of escaping character by character.
    let end = i + 1;
    while (end < source.length && !/[\\`!*_[~\n]/.test(source[end])) end++;
    output += escapeHTML(source.slice(i, end));
    i = end;
  }
  return output;
}

const fenceRE = /^\s{0,3}(`{3,}|~{3,})([\w-]*)\s*$/;
const listRE = /^(\s{0,3})([-+*]|\d{1,9}[.)])\s+(.+)$/;
const ruleRE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const tableDividerRE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function blocks(lines, nesting = 0) {
  if (nesting > 8) return `<p>${inline(lines.join('\n'))}</p>`;
  const output = [];
  let i = 0;
  const startsBlock = (line, next) => !line.trim() || fenceRE.test(line) || /^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}>/.test(line) || listRE.test(line) || ruleRE.test(line) || (next && line.includes('|') && tableDividerRE.test(next));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(fenceRE);
    if (fence) {
      const code = [];
      i++;
      const endRE = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !endRE.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      output.push(`<pre><code${fence[2] ? ` class="language-${escapeHTML(fence[2])}"` : ''}>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (ruleRE.test(line)) { output.push('<hr>'); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
      output.push(`<blockquote>${blocks(quote, nesting + 1)}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableDividerRE.test(lines[i + 1])) {
      const headers = tableCells(line);
      const alignments = tableCells(lines[i + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const cell = (text, index, tag) => `<${tag} style="text-align:${alignments[index] || 'left'}">${inline(text || '')}</${tag}>`;
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = tableCells(lines[i++]);
        rows.push(`<tr>${headers.map((_, index) => cell(cells[index], index, 'td')).join('')}</tr>`);
      }
      output.push(`<div class="md-table-wrap"><table><thead><tr>${headers.map((text, index) => cell(text, index, 'th')).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const firstItem = line.match(listRE);
    if (firstItem) {
      const ordered = /^\d/.test(firstItem[2]);
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? Number.parseInt(firstItem[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const item = lines[i].match(listRE);
        if (!item || /^\d/.test(item[2]) !== ordered) break;
        i++;
        const content = [item[3]];
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !lines[i].match(listRE)) content.push(lines[i++].trim());
        const task = content[0].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) content[0] = task[2];
        items.push(`<li${task ? ' class="md-task"' : ''}>${task ? `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''} aria-label="${task[1].toLowerCase() === 'x' ? 'Выполнено' : 'Не выполнено'}"> ` : ''}${inline(content.join('\n'))}</li>`);
      }
      output.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`); continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1])) paragraph.push(lines[i++]);
    output.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  return output.join('\n');
}

export function renderMarkdown(text = '') {
  return blocks(String(text).replace(/\r\n?/g, '\n').split('\n'));
}

/** Plain preview text, safe to use with textContent (escape it when interpolating HTML). */
export function plainText(text = '') {
  return String(text)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/([*_~`])\1*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
