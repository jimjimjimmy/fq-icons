#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { exec } = require('child_process');

const PORT = 5180;

// Resolve paths relative to the repo worktree root (where this script runs from)
const REPO_ROOT  = process.cwd();
const BASE_SVGS  = path.join(REPO_ROOT, 'playspace/icon-svgs/all');
const FONT_DIR   = path.join(REPO_ROOT, 'projects/fq-icons');
const CUSTOM_DIR = path.join(FONT_DIR, 'custom');

fs.mkdirSync(CUSTOM_DIR, { recursive: true });

let regenRunning = false;

// Strip bounding-box rects, invisible elements, and empty groups from
// Figma-exported SVGs before they get baked into the font.
// Handles: rect fill="none"|fill="white", opacity=0, display=none,
//          visibility=hidden, and leftover empty <g> wrappers.
function cleanSvg(svg) {
  // Remove self-closing rects with fill="none" or fill="white" (Figma artboard bg)
  svg = svg.replace(
    /<rect\b([^>]*)\bfill="(none|white|#fff|#ffffff)"([^>]*)\/>/gi,
    (m, pre, fill, post) => {
      const hasVisibleStroke = /\bstroke="(?!none)[^"]+"/i.test(pre + post);
      return hasVisibleStroke ? m : '';
    }
  );

  // Remove any self-closing element with opacity="0"
  svg = svg.replace(/<\w+\b[^>]*\bopacity="0"[^>]*\/>/g, '');

  // Remove any self-closing element with display="none"
  svg = svg.replace(/<\w+\b[^>]*\bdisplay="none"[^>]*\/>/g, '');

  // Remove <g display="none">...</g> blocks (including children)
  svg = svg.replace(/<g\b[^>]*\bdisplay="none"[^>]*>[\s\S]*?<\/g>/g, '');

  // Remove any self-closing element with visibility="hidden"
  svg = svg.replace(/<\w+\b[^>]*\bvisibility="hidden"[^>]*\/>/g, '');

  // Remove <g visibility="hidden">...</g> blocks
  svg = svg.replace(/<g\b[^>]*\bvisibility="hidden"[^>]*>[\s\S]*?<\/g>/g, '');

  // Remove empty open/close g groups (may be left after above removals)
  let prev;
  do {
    prev = svg;
    svg = svg.replace(/<g\b[^>]*>\s*<\/g>/g, '');
  } while (svg !== prev);

  return svg.trim();
}

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.json':  'application/json',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.svg':   'image/svg+xml',
};

// Serve a file from FONT_DIR
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':  mime,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// Collect POST/PUT body as a string
function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

// Merge base + custom SVGs into a tmp dir, run Fantasticon, clean up
function regen(cb) {
  regenRunning = true;
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-icons-'));

    // Copy base SVGs
    for (const f of fs.readdirSync(BASE_SVGS).filter(f => f.endsWith('.svg'))) {
      fs.copyFileSync(path.join(BASE_SVGS, f), path.join(tmpDir, f));
    }

    // Copy custom SVGs (overrides base if same name)
    for (const f of fs.readdirSync(CUSTOM_DIR).filter(f => f.endsWith('.svg'))) {
      fs.copyFileSync(path.join(CUSTOM_DIR, f), path.join(tmpDir, f));
    }
  } catch (e) {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    regenRunning = false;
    return cb(e);
  }

  // Fantasticon requires the output dir to exist
  fs.mkdirSync(FONT_DIR, { recursive: true });

  const cmd = [
    'source ~/.nvm/nvm.sh',
    'nvm use 20',
    [
      `npx fantasticon "${tmpDir}"`,
      `--name fq-icons`,
      `--output "${FONT_DIR}"`,
      `--font-types woff2 ttf`,
      `--prefix fq-icon`,
      `--normalize`,
      `--asset-types json css`,
    ].join(' '),
  ].join(' && ');

  exec(cmd, { shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (err) {
      regenRunning = false;
      console.error('[regen] fantasticon error:', stderr || err.message);
      return cb(err);
    }

    // Append default color rule (Fantasticon overwrites the CSS each run)
    try {
      fs.appendFileSync(
        path.join(FONT_DIR, 'fq-icons.css'),
        '\n.fq-icon { color: #6B7280; }\n',
        'utf8'
      );
    } catch (_) {}

    regenRunning = false;
    console.log('[regen] done');
    cb(null);
  });
}

// Kebab-safe name sanitizer (same logic as index.html toKebab)
function sanitizeName(raw) {
  return (raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlObj   = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // ---- GET /api/regen-status ----
  if (req.method === 'GET' && pathname === '/api/regen-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: regenRunning }));
    return;
  }

  // ---- GET /api/custom ---- list of custom icon names (no ext)
  if (req.method === 'GET' && pathname === '/api/custom') {
    const names = fs.readdirSync(CUSTOM_DIR)
      .filter(f => f.endsWith('.svg'))
      .map(f => f.slice(0, -4));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(names));
    return;
  }

  // ---- POST /api/save-icon ---- { name, svg }
  if (req.method === 'POST' && pathname === '/api/save-icon') {
    if (regenRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Regeneration already in progress - try again shortly' }));
      return;
    }
    readBody(req, body => {
      let data;
      try { data = JSON.parse(body); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const name = sanitizeName(data.name);
      if (!name || !data.svg) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name and svg are required' }));
        return;
      }
      try {
        const cleanedSvg = cleanSvg(data.svg);
        fs.writeFileSync(path.join(CUSTOM_DIR, `${name}.svg`), cleanedSvg, 'utf8');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not write SVG file: ' + e.message }));
        return;
      }
      console.log(`[save] ${name}.svg - regenerating...`);
      regen(err => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Font regeneration failed: ' + err.message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name }));
        }
      });
    });
    return;
  }

  // ---- DELETE /api/custom/:name ----
  if (req.method === 'DELETE' && pathname.startsWith('/api/custom/')) {
    if (regenRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Regeneration already in progress - try again shortly' }));
      return;
    }
    const rawName = path.basename(pathname);
    const name = sanitizeName(rawName);
    const file = path.join(CUSTOM_DIR, `${name}.svg`);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Icon not found' }));
      return;
    }
    try {
      fs.unlinkSync(file);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not delete file: ' + e.message }));
      return;
    }
    console.log(`[delete] ${name}.svg - regenerating...`);
    regen(err => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Font regeneration failed: ' + err.message }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    return;
  }

  // ---- Static file serving from FONT_DIR ----
  let filePath = pathname === '/'
    ? path.join(FONT_DIR, 'index.html')
    : path.join(FONT_DIR, pathname.replace(/^\//, ''));

  // Prevent path traversal
  if (!filePath.startsWith(FONT_DIR + path.sep) && filePath !== path.join(FONT_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`FQ Icons Reference: http://localhost:${PORT}`);
  console.log(`Font dir:   ${FONT_DIR}`);
  console.log(`Custom dir: ${CUSTOM_DIR}`);
  console.log(`Base SVGs:  ${BASE_SVGS}`);
});
