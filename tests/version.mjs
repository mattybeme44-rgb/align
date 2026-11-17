/*
 * The build stamp has to agree everywhere, or the update banner lies.
 *
 *   node tests/version.mjs
 *
 * Why this exists: js/app.js once held its own BUILD literal. It drifted from
 * version.json, so every reload compared the page against the published stamp,
 * found them different, and showed "a new build is published" again. Pressing
 * Reload reloaded the same page, the same mismatch was found, and the banner
 * came back — the button looked dead. These checks make that drift a failure
 * before it can ship.
 */

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));

/* 1. version.json carries a build. */
const published = String(version.build || '').trim();
report('version.json carries a build stamp', /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(published),
  '"' + published + '"');

/* 2. index.html stamps the same build the page reads. */
const meta = html.match(/<meta\s+name="align-build"\s+content="([^"]+)"/);
const stamped = meta ? meta[1].trim() : '';
report('index.html stamps a build', stamped === published,
  stamped ? 'page "' + stamped + '" against version.json "' + published + '"'
    : 'no align-build meta tag in index.html');

/* 3. app.js reads that stamp rather than carrying its own. */
report('app.js reads the build from the document',
  app.includes("querySelector('meta[name=\"align-build\"]')"),
  app.includes("querySelector('meta[name=\"align-build\"]')")
    ? 'reads the meta tag'
    : 'app.js still holds its own literal, which can drift');

/* 4. app.js holds no build literal at all: a literal is what drifted before. */
const literal = app.match(/const BUILD\s*=\s*'(\d{4}-\d{2}-\d{2}-\d{2})'/);
report('app.js holds no build literal that could drift', !literal,
  literal ? 'found a literal "' + literal[1] + '" — remove it' : 'no build literal in app.js');

/* 5. The worker answers the message Reload sends. */
report('The service worker honours SKIP_WAITING',
  /addEventListener\('message'/.test(sw) && sw.includes('SKIP_WAITING'),
  /addEventListener\('message'/.test(sw)
    ? 'a message handler is present'
    : 'no message handler: a waiting worker can never take over');

/* 6. The worker's cache name is versioned, so the shell is refreshed. */
const cache = sw.match(/const CACHE = '([^']+)'/);
report('The shell cache is named and versioned', !!cache,
  cache ? cache[1] : 'no CACHE constant');

/* 7. app.js sends the message the worker listens for. */
report('app.js posts the message the worker answers',
  app.includes("postMessage({ type: 'SKIP_WAITING' })"),
  app.includes("postMessage({ type: 'SKIP_WAITING' })")
    ? 'both sides agree on the message'
    : 'app.js asks for something the worker does not handle');

/* 8. Reload cannot leave the page sitting there doing nothing. */
report('Reload always navigates, even if the worker does not answer',
  /setTimeout\(go, 2500\)/.test(app),
  /setTimeout\(go, 2500\)/.test(app)
    ? 'a 2.5 s fallback navigation is in place'
    : 'no fallback: a silent worker would leave the button dead');

/* 9. version.json is never cached by the worker: an old copy would hide the update. */
report('The worker never caches version.json',
  /pathname\.endsWith\('\/version\.json'\)/.test(sw),
  /pathname\.endsWith\('\/version\.json'\)/.test(sw)
    ? 'bypassed in the fetch handler'
    : 'version.json can be served from the cache, so the banner would never clear');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
