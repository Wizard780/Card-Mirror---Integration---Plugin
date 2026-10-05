import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { words, htmlToText, pageYear, urlsIn, citeParts, cardProse, compare, skippedQualifiers, verdict } from '../lib/cardcheck.mjs';
import { isPublicAddress, safeFetch, getSource } from '../lib/fetchsafe.mjs';

const SOURCE = `Data centers are the demand shock of the decade. Demand is growing seventeen times faster than the rest of the economy,
according to the agency's latest forecast. Utilities say the grid cannot keep up without new transmission.
${'Filler sentence about unrelated matters that goes on for a while. '.repeat(80)}
Regulators warned that blackouts may become common by 2030 unless capacity is added quickly.`;

test('words: case, quotes, ligatures, soft and line-break hyphens, glued footnote numbers stop mattering', () => {
  assert.deepEqual(words('The “eﬃcient” grid’s de-\nmand grew.12 Fast'), ['the', 'efficient', "grid's", 'demand', 'grew', 'fast']);
  assert.deepEqual(words('re­silience'), ['resilience']);
});

test('html text, page year, URLs in cites, cite author and year', () => {
  assert.equal(htmlToText('<p>A&amp;B</p><script>x()</script><style>.a{}</style><div>C</div>').replace(/\s+/g, ' ').trim(), 'A&B C');
  assert.equal(pageYear('<meta property="article:published_time" content="2025-03-01T00:00:00Z">'), 2025);
  assert.equal(pageYear('<script type="application/ld+json">{"datePublished":"2023-11-02"}</script>'), 2023);
  assert.equal(pageYear('<p>no date</p>'), null);
  assert.deepEqual(urlsIn('Chen 25 [Xin; arXiv, https://arxiv.org/pdf/2509.07218]. Also http://x.org/a,'), ['https://arxiv.org/pdf/2509.07218', 'http://x.org/a']);
  assert.deepEqual(citeParts("Chen et al. '25 [Xin; September 8]"), { author: 'chen', year: 2025 });
  assert.deepEqual(citeParts('Neocleous 08 [Mark (Professor…)]'), { author: 'neocleous', year: 2008 });
  assert.deepEqual(citeParts('Royal 2010 (Jedediah, Director)'), { author: 'royal', year: 2010 });
});

test('cardProse drops condense notes, bracketed insertions and the cutter\'s --- note lines', () => {
  assert.equal(cardProse('Text <<TEXT CONDENSED, NONE OMITTED>> more [the US] end\n---my note\nlast').replace(/\s+/g, ' ').trim(), 'Text more end last');
});

test('compare: a faithful card matches; changed and added text is listed; text from far apart is a join', () => {
  const ok = compare('Demand is growing seventeen times faster than the rest of the economy, according to the agency’s latest forecast.', SOURCE);
  assert.ok(ok.coverage > 0.95);
  assert.deepEqual([ok.missing, ok.joins], [[], []]);
  const edited = compare('Demand is growing seventeen times faster than the rest of the economy. Experts agree this guarantees a total collapse of every grid.', SOURCE);
  assert.deepEqual(edited.missing, ['Experts agree this guarantees a total collapse of every grid.']);
  const spliced = compare('Utilities say the grid cannot keep up without new transmission. Regulators warned that blackouts may become common by 2030 unless capacity is added quickly.', SOURCE);
  assert.equal(spliced.missing.length, 0);
  assert.equal(spliced.joins.length, 1);
  assert.ok(spliced.joins[0].gapWords > 400);
});

test('skippedQualifiers: an unread "not"/"may" inside read text is flagged; "not only" and unread clauses are not', () => {
  const runs = [{ t: 'AI will ', h: true }, { t: 'not ', h: false }, { t: 'cause a war. ', h: true }, { t: 'This is ', h: false }, { t: 'not only bad ', h: false }, { t: 'but costly.', h: true }];
  assert.deepEqual(skippedQualifiers(runs).map((q) => q.word), ['not']);
  assert.match(skippedQualifiers(runs)[0].context, /will \[not\] cause/);
  assert.deepEqual(skippedQualifiers([{ t: 'Blackouts ', h: true }, { t: 'may ', h: false }, { t: 'become common.', h: true }]).map((q) => q.word), ['may']);
  assert.deepEqual(skippedQualifiers([{ t: 'Nothing here is read, not even this.', h: false }]), []);
  assert.deepEqual(skippedQualifiers([{ t: 'not only X but also Y', h: false }, { t: ' read', h: true }]), []);
});

test('verdict wording: matches, differences with reasons, unverified, unreachable, no link; never "fake"', () => {
  const src = { text: SOURCE, textLower: `${SOURCE} by jane chen`.toLowerCase(), year: 2025 };
  assert.equal(verdict({ result: compare('Demand is growing seventeen times faster than the rest of the economy.', SOURCE), source: src, cite: 'Chen 25' }).status, 'matches');
  const diff = verdict({ result: compare('Demand is growing seventeen times faster than the rest of the economy.', SOURCE), source: src, cite: 'Smith 19' });
  assert.deepEqual(diff, { status: 'differences', issues: ['Author "smith" isn\'t named on the page.', 'Cite says 2019; the page is dated 2025.'], coverage: 100 });
  assert.equal(verdict({ result: compare('Completely different words that appear nowhere in that source at all whatsoever.', SOURCE), source: src, cite: 'Chen 25' }).status, 'unverified');
  // Mostly invented, but one sentence is word for word: the right page, so it's a difference, not "couldn't verify".
  const padded = verdict({ result: compare('Utilities say the grid cannot keep up without new transmission. Experts all agree that every single grid on earth will certainly fail within the year and nothing can stop it.', SOURCE), source: src, cite: 'Chen 25' });
  assert.equal(padded.status, 'differences');
  assert.equal(verdict({ result: null, source: { error: 'http_403' }, cite: '' }).status, 'unreachable');
  assert.equal(verdict({ result: null, source: null, cite: '' }).status, 'no_link');
});

test('isPublicAddress refuses loopback, private, link-local, CGNAT and reserved ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.5', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['93.184.216.34', '192.0.66.199', '8.8.8.8', '2606:4700::6810:84e5']) assert.equal(isPublicAddress(ip), true, ip);
});

test('safeFetch: refuses private hosts and redirects into them; only http(s)', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { Location: 'http://internal.test/' }); return res.end(); }
    res.end('hello');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), /blocked_address/);
    await assert.rejects(safeFetch('file:///etc/passwd'), /bad_url/);
    // A public-looking name that resolves to loopback is refused too.
    await assert.rejects(safeFetch(`http://evil.test:${port}/`, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), /blocked_address/);
    // The redirect target is checked at its own hop.
    const resolve = async (h) => (h === 'public.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.5', family: 4 }]);
    const hop = safeFetch('http://internal.test/', { resolve });
    await assert.rejects(hop, /blocked_address/);
    const ok = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(ok.body.toString(), 'hello');
  } finally { srv.close(); }
});

test('getSource falls back to the archived copy when the page is blocked', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://web.archive.org/')) return { status: 200, type: 'text/html', body: Buffer.from(`<p>${SOURCE}</p>`), url };
    return { status: 403, type: 'text/html', body: Buffer.from('blocked') };
  };
  const src = await getSource('https://news.test/a', { fetchImpl });
  assert.equal(src.archived, true);
  assert.match(calls[1], /^https:\/\/web\.archive\.org\/web\/\d{8}id_\/https:\/\/news\.test\/a$/);
  assert.ok(src.text.includes('seventeen times faster'));
  const gone = await getSource('https://news.test/b', { fetchImpl: async () => ({ status: 404, type: 'text/html', body: Buffer.from('') }) });
  assert.equal(gone.error, 'http_404');
});
