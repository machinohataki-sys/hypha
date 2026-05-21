'use strict';
const fs = require('fs');
const path = require('path');

const blogDir = path.join(__dirname, 'blog');

function htmlToText(html) {
  let s = html;
  const start = s.indexOf('<div class="post"');
  if (start > 0) {
    const end = s.indexOf('</div>\n  </div>', start);
    if (end > 0) s = s.slice(start, end);
  }
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && !f.startsWith('_'));
for (const f of files) {
  const html = fs.readFileSync(path.join(blogDir, f), 'utf8');
  const text = htmlToText(html);
  const outPath = path.join(blogDir, f.replace('.html', '.txt'));
  fs.writeFileSync(outPath, text);
  console.log(f, '→', text.length, 'chars');
}
