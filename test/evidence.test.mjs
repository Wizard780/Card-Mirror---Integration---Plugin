import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { writeZip } from '../lib/docx.mjs';
import { createEvidenceIndex } from '../lib/evidence.mjs';

function docx(cards, heads = ['Pocket', '', 'Block']) {
  const p = (style, text) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const body = heads.map((h, i) => (h ? p(`Heading${i + 1}`, h) : '')).join('')
    + cards.map(([tag, cite]) => p('Heading4', tag) + (cite ? `<w:p><w:r><w:t>${cite}</w:t></w:r></w:p>` : '')).join('');
  const xml = `<w:document><w:body>${body}</w:body></w:document>`;
  return writeZip([['word/document.xml', xml], ['word/styles.xml', '']].map(([name, text]) => {
    const raw = Buffer.from(text);
    return { name, method: 8, crc: crc32(raw), usize: raw.length, data: deflateRawSync(raw) };
  }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ev-'));
  const a = join(root, 'files');
  await mkdir(join(a, 'sub'), { recursive: true });
  await mkdir(join(a, '.hidden'), { recursive: true });
  await writeFile(join(a, 'Grid Aff.docx'), docx([['AI load swings crash the grid', 'Chen 25 [Xin; TAMU]'], ['Offshoring is a myth', 'Rogan 26']]));
  await writeFile(join(a, 'sub', 'Copy of Grid.docx'), docx([['AI load swings crash the grid', 'Chen 25 [Xin; TAMU]']]));
  await writeFile(join(a, 'sub', 'Econ DA.docx'), docx([['Recession causes war', 'Royal 10'], ['No link, grid spending is small', '']], ['Econ DA', '', 'AT: Grid']));
  await writeFile(join(a, '.hidden', 'secret.docx'), docx([['hidden grid card', 'X 1']]));
  await writeFile(join(a, '~$Grid Aff.docx'), 'lock file');
  await writeFile(join(a, 'stub.docx'), 'not a zip');
  await writeFile(join(a, 'notes.txt'), 'grid');
  return { root, a, file: join(root, 'index.json') };
}

test('scan indexes .docx cards in the chosen folders; skips hidden dirs, ~$ lock files and broken files', async () => {
  const f = await fixture();
  try {
    const ix = createEvidenceIndex({ file: f.file });
    await ix.scan([f.a]);
    assert.deepEqual(ix.status(), { folders: [f.a], files: 4, cards: 5, unreadable: 1, scanning: false, done: 4, total: 4, scannedAt: ix.status().scannedAt });
    assert.ok(ix.status().scannedAt > 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('search: every word must match tag, cite, headings or file name; tag hits rank first; copies are grouped', async () => {
  const f = await fixture();
  try {
    const ix = createEvidenceIndex({ file: f.file });
    await ix.scan([f.a]);
    const r = ix.search('grid');
    // tag hits, then heading / file-name hits ("AT: Grid" block, "Grid Aff.docx")
    assert.deepEqual(r.map((x) => x.tag), ['AI load swings crash the grid', 'No link, grid spending is small', 'Offshoring is a myth', 'Recession causes war']);
    assert.equal(r[0].copies, 2, 'same tag + cite in two files is one result');
    assert.equal(r[2].file, 'Grid Aff.docx', 'matched on the file name only');
    assert.deepEqual(r[1].headings, ['Econ DA', 'AT: Grid']);
    assert.equal(r[1].cite, '');
    assert.deepEqual(ix.search('chen tamu').map((x) => x.tag), ['AI load swings crash the grid']);
    assert.deepEqual(ix.search('CHEN  recession'), []);
    assert.deepEqual(ix.search('myth').map((x) => x.tag), ['Offshoring is a myth']);
    assert.deepEqual(ix.search('royal').map((x) => x.cite), ['Royal 10'], 'cite search');
    assert.deepEqual(ix.search('   '), []);
    assert.equal(ix.search('a', 1).length, 1, 'limit');
    const hit = ix.lookup(r[1].path, r[1].ordinal);
    assert.equal(hit.tag, 'No link, grid spending is small');
    assert.equal(ix.lookup('/etc/passwd', 0), null, 'only indexed files');
    assert.equal(ix.lookup(r[1].path, 7), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rescans only changed files, drops deleted ones, survives a restart, and runs one scan at a time', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const ix = createEvidenceIndex({ file: f.file, onRead: () => reads++ });
    await Promise.all([ix.scan([f.a]), ix.scan([f.a])]);
    assert.equal(reads, 4, 'one scan, every .docx read once');
    await writeFile(join(f.a, 'sub', 'Econ DA.docx'), docx([['Recession causes nuclear war', 'Royal 10']]));
    await utimes(join(f.a, 'sub', 'Econ DA.docx'), new Date(), new Date(Date.now() + 5000));
    await rm(join(f.a, 'sub', 'Copy of Grid.docx'));
    await ix.scan([f.a]);
    assert.equal(reads, 5, 'only the changed file is read again');
    assert.equal(ix.search('grid')[0].copies, 1);
    assert.deepEqual(ix.search('nuclear').map((x) => x.tag), ['Recession causes nuclear war']);

    const again = createEvidenceIndex({ file: f.file, onRead: () => reads++ });
    await again.load();
    assert.deepEqual(again.search('nuclear').map((x) => x.tag), ['Recession causes nuclear war'], 'loaded from disk');
    assert.deepEqual(again.status().folders, [f.a]);
    await again.scan([f.a]);
    assert.equal(reads, 5, 'nothing changed since the saved index');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('symlinked folders are not followed; a missing folder just has no files', async () => {
  const f = await fixture();
  try {
    await symlink(f.a, join(f.root, 'link'));
    const ix = createEvidenceIndex({ file: f.file });
    await ix.scan([join(f.root, 'nope')]);
    assert.equal(ix.status().files, 0);
    await mkdir(join(f.root, 'outer'));
    await symlink(f.a, join(f.root, 'outer', 'inner'));
    await ix.scan([join(f.root, 'outer')]);
    assert.equal(ix.status().files, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
