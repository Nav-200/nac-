/**
 * Assembles the single-file page for publishing as a claude.ai artifact.
 *
 * The host wraps the file in its own <!doctype html>…<head>…<body> skeleton,
 * so this emits a fragment: <title>, inline <style>, the root div, and one
 * inline module <script>. The script payload must be escaped — a literal
 * "</script" or "<!--" inside the JS would terminate or corrupt the inline
 * script per HTML parsing rules.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist-artifact', import.meta.url).pathname;
const assets = join(dist, 'assets');

const files = readdirSync(assets);
const jsFile = files.find((f) => f.endsWith('.js'));
const cssFile = files.find((f) => f.endsWith('.css'));
if (!jsFile || !cssFile) {
  throw new Error(`expected one js and one css asset, found: ${files.join(', ')}`);
}

const escapeInlineScript = (src) =>
  src.replaceAll('</script', '<\\/script').replaceAll('<!--', '\\x3C!--');
const escapeInlineStyle = (src) => src.replaceAll('</style', '<\\/style');

const js = readFileSync(join(assets, jsFile), 'utf8');
const css = readFileSync(join(assets, cssFile), 'utf8');

const page = `<title>Horizon Rush</title>
<style>${escapeInlineStyle(css)}</style>
<div id="root"></div>
<script>window.__HR_ARTIFACT__ = true;</script>
<script type="module">${escapeInlineScript(js)}</script>
`;

const out = join(dist, 'horizon-rush.artifact.html');
writeFileSync(out, page);
console.log(`${out}: ${(page.length / 1024 / 1024).toFixed(2)} MB`);
