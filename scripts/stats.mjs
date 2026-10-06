#!/usr/bin/env node
// Downloads per release from GitHub. CardMirror downloads plugin.js each time someone installs or
// updates the plugin, so this counts installs + updates (not people, not active users).
// No data is collected from anyone's Mac. Usage: npm run stats
const REPO = process.env.STATS_REPO || 'Wizard780/Card-Mirror---Integration---Plugin';
const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
if (!res.ok) { console.error(`GitHub said ${res.status}. Try again later (the API allows 60 requests an hour without a login).`); process.exit(1); }
const releases = (await res.json()).sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
const count = (r, name) => r.assets.find((a) => a.name === name)?.download_count ?? 0;
let total = 0;
console.log('release     installs/updates   published');
for (const r of releases) {
  const n = count(r, 'plugin.js');
  total += n;
  console.log(`${r.tag_name.padEnd(12)}${String(n).padStart(16)}   ${r.published_at.slice(0, 10)}`);
}
const latest = releases.at(-1);
console.log(`\ntotal: ${total} downloads of plugin.js across ${releases.length} releases`);
if (latest) console.log(`latest (${latest.tag_name}): ${count(latest, 'plugin.js')}; a new release starts at 0, so recent installs + updates show up there`);
