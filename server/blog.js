'use strict';

// The blog (/blog): posts are Markdown files in content/blog/<slug>.md with
// a short front matter block (see docs/BLOG.md). They're read once, rendered
// to HTML here (a small Markdown subset, no dependency) and served in the
// static pages' frame by pages.js.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'content', 'blog');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- front matter: "key: value" lines between --- fences.
function parseFrontMatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter (--- … ---)`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: can't read front matter line "${line}"`);
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (v === 'true' || v === 'false') v = v === 'true';
    else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1]] = v;
  }
  for (const key of ['title', 'description', 'date']) if (!meta[key]) throw new Error(`${file}: front matter needs "${key}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date) || Number.isNaN(Date.parse(meta.date))) throw new Error(`${file}: date must be YYYY-MM-DD`);
  meta.tags = Array.isArray(meta.tags) ? meta.tags.map((t) => slugify(t)).filter(Boolean) : meta.tags ? [slugify(meta.tags)] : [];
  return { meta, body: m[2] };
}

// ---------- Markdown (the subset docs/BLOG.md describes).
// Links and images: site paths, anchors, http(s) and mailto only.
const safeUrl = (u) => (/^(\/(?!\/)|#|https?:\/\/|mailto:)/i.test(u) ? u : '#');
function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${safeUrl(src)}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const external = /^https?:/.test(href) && !/^https?:\/\/(www\.)?tonament\.com/.test(href);
      return `<a href="${safeUrl(href)}"${external ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<span class="ink-red">$1</span>')
    .replace(/\(\(([^)]+)\)\)/g, '<span class="circled">$1</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

// An image line: ![alt](src "caption"). "{theme}" in src gives a dark and a light copy.
function figure(line) {
  const m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  if (!m) return null;
  const [, alt, src, caption] = m;
  const img = (s, cls) => `<img${cls ? ` class="${cls}"` : ''} src="${esc(safeUrl(s))}" alt="${esc(alt)}" loading="lazy">`;
  const imgs = src.includes('{theme}') ? img(src.replace('{theme}', 'dark'), 'on-dark') + img(src.replace('{theme}', 'light'), 'on-light') : img(src);
  return `<figure class="post-figure${/\/guide\//.test(src) && !/display/.test(src) ? ' phone-shot' : ''}">${imgs}${caption ? `<figcaption>${inline(caption)}</figcaption>` : ''}</figure>`;
}

function markdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); i++; continue; }
    // :::paper … ::: — a handwritten fixture-sheet snippet.
    if (/^:::paper\b/.test(t)) {
      flush();
      const title = t.replace(/^:::paper\s*/, '');
      const rows = [];
      for (i++; i < lines.length && lines[i].trim() !== ':::'; i++) if (lines[i].trim()) rows.push(lines[i].trim());
      i++;
      out.push(`<div class="paper-sheet paper-inline" role="img" aria-label="${esc(title || 'A handwritten fixture sheet')}">${rows.map((r) => `<p class="ink">${inline(r)}</p>`).join('')}</div>`);
      continue;
    }
    // :::compare — two columns, "On paper" | "With Tonament", split by a line of ---.
    if (/^:::compare\b/.test(t)) {
      flush();
      const cols = [[]];
      for (i++; i < lines.length && lines[i].trim() !== ':::'; i++) {
        if (lines[i].trim() === '---') cols.push([]);
        else cols[cols.length - 1].push(lines[i]);
      }
      i++;
      out.push(`<div class="post-compare">${cols.map((c) => `<div>${markdown(c.join('\n')).html}</div>`).join('')}</div>`);
      continue;
    }
    const hm = t.match(/^(#{2,4})\s+(.*)$/);
    if (hm) {
      flush();
      const level = hm[1].length;
      const id = slugify(hm[2]);
      if (level === 2) headings.push({ id, text: hm[2] });
      out.push(`<h${level} id="${id}">${inline(hm[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flush(); out.push('<hr>'); i++; continue; }
    const fig = figure(t);
    if (fig) { flush(); out.push(fig); i++; continue; }
    if (/^>\s?/.test(t)) {
      flush();
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i].trim()); i++) q.push(lines[i].trim().replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(q.join('\n')).html}</blockquote>`);
      continue;
    }
    if (/^([-*]|\d+\.)\s+/.test(t)) {
      flush();
      const ordered = /^\d+\./.test(t);
      const items = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*([-*]|\d+\.)\s+/.test(l)) items.push(l.trim().replace(/^([-*]|\d+\.)\s+/, ''));
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\|.*\|$/.test(t)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\|.*\|$/.test(lines[i].trim()); i++) rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
      const head = rows[0];
      const body = rows.slice(rows[1] && rows[1].every((c) => /^:?-{2,}:?$/.test(c)) ? 2 : 1);
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return { html: out.join('\n'), headings };
}

// ---------- posts
let cache = null;
function load(dir = DIR) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  const posts = files.map((file) => {
    const slug = file.slice(0, -3);
    if (!SLUG.test(slug)) throw new Error(`${file}: file names are lower-case words joined by hyphens`);
    const { meta, body } = parseFrontMatter(fs.readFileSync(path.join(dir, file), 'utf8'), file);
    const { html, headings } = markdown(body);
    const words = body.split(/\s+/).filter(Boolean).length;
    return {
      slug, path: `/blog/${slug}`, title: meta.title, description: meta.description, date: meta.date, updated: meta.updated || null,
      author: meta.author || 'Tonament', tags: meta.tags, image: meta.image || null, featured: Boolean(meta.featured),
      html, headings, minutes: Math.max(1, Math.round(words / 220)),
    };
  });
  // Newest first; a featured post leads the list.
  return posts.sort((a, b) => (b.featured - a.featured) || b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}
function posts() {
  if (!cache) cache = load();
  return cache;
}
const find = (slug) => posts().find((p) => p.slug === slug) || null;
const tags = () => [...new Set(posts().flatMap((p) => p.tags))].sort();
// Posts sharing the most tags, then the newest.
function related(post, n = 3) {
  return posts().filter((p) => p.slug !== post.slug)
    .map((p) => ({ p, shared: p.tags.filter((t) => post.tags.includes(t)).length }))
    .sort((a, b) => b.shared - a.shared || b.p.date.localeCompare(a.p.date))
    .slice(0, n).map((x) => x.p);
}

module.exports = { posts, find, tags, related, load, markdown, parseFrontMatter, slugify };
