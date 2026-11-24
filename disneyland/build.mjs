// Rebuilds the two HTML entry points from shell.js + plan.json.
//   node build.mjs
// page.html  -> the page published as the Claude artifact (content only; the wrapper is added at publish)
// index.html -> the same page as a complete document, for GitHub Pages, Vercel or any static host
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shell = createRequire(import.meta.url)('./shell.js');
const plan = JSON.parse(readFileSync(join(here, 'plan.json'), 'utf8'));

writeFileSync(join(here, 'page.html'), shell.content(plan) + '\n');
writeFileSync(join(here, 'index.html'), shell.fullDocument(plan) + '\n');
console.log('Built page.html and index.html from plan.json (rev ' + plan.rev + ')');
