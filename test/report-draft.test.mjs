import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechCode, sectionsOf, draftReport } from '../lib/report-draft.mjs';

const H = (level, text) => ({ level, text });

test('speechCode finds a code as prefix or suffix, with any dash style; the rest is the argument name', () => {
  assert.deepEqual(speechCode('1AC---False Profits'), { code: '1AC', name: 'False Profits' });
  assert.deepEqual(speechCode('1NC --- Midterms'), { code: '1NC', name: 'Midterms' });
  assert.deepEqual(speechCode('1NC—Stargate'), { code: '1NC', name: 'Stargate' });
  assert.deepEqual(speechCode('Spark---AT: Transition---2NC'), { code: '2NC', name: 'Spark---AT: Transition' });
  assert.deepEqual(speechCode('DA---1NC'), { code: '1NC', name: 'DA' });
  assert.deepEqual(speechCode('2ac - AT: Offshoring'), { code: '2AC', name: 'AT: Offshoring' });
  assert.deepEqual(speechCode('1AC---Round 1---UKSO'), { code: '1AC', name: 'Round 1---UKSO' });
  assert.equal(speechCode('AT: Indigenous Sovereignty'), null);
  assert.equal(speechCode('Cards from 21AC research'), null, 'code must stand alone');
});

test('sections: codes on a parent heading apply to the headings under it; overviews and blanks are dropped', () => {
  const s = sectionsOf([
    H(1, '1AC---Round 1---UKSO'), H(3, '1AC---Overview'), H(3, '1AC---Solvency'), H(3, 'Climate'),
    H(1, 'Mid America Cup Round 5 --- University AS vs Arlington AL'), H(2, '1NC—Stargate'), H(2, '1NC---O/V'),
    H(2, 'Spark---AT: ASI---2NC'), H(2, '2NC'), H(2, ''),
  ]);
  assert.deepEqual(s, { '1AC': ['Solvency', 'Climate'], '1NC': ['Stargate'], '2NC': ['Spark---AT: ASI'] });
});

test('a doc with no codes in its headings takes the speech from its file name, else contributes nothing', () => {
  assert.deepEqual(sectionsOf([H(2, 'AT: Indigenous Sovereignty'), H(2, 'AT: Rematriation')], '2NR Glenbrooks R3.docx'), { '2NR': ['AT: Indigenous Sovereignty', 'AT: Rematriation'] });
  assert.deepEqual(sectionsOf([H(2, 'AT: Indigenous Sovereignty')], 'UniversitySchool-SaAn-Con.docx'), {});
});

test('draftReport merges the round\'s docs in speech order, dedupes, and lists its sources', () => {
  const r = draftReport([
    { name: 'Univ 1AC.docx', headings: [H(1, 'Mid America Cup Round 6'), H(2, '1AC---False Profits'), H(2, '1AC---Fool’s Gold')] },
    { name: 'Acton 1NC.docx', headings: [H(2, '1NC---Econ'), H(2, '1NC---Innovation'), H(2, '1NC---Offshoring')] },
    { name: 'Univ 2AC.docx', headings: [H(2, '2AC---AT: Innovation'), H(2, '2AC---AT: Offshoring'), H(2, '2ac---AT: offshoring')] },
    { name: '2AR.docx', headings: [H(2, 'Extensions')] },
    { name: 'notes.docx', headings: [H(2, 'Contact info')] },
  ]);
  assert.equal(r.report, '1AC -- False Profits, Fool’s Gold\n1NC -- Econ, Innovation, Offshoring\n2AC -- AT: Innovation, AT: Offshoring\n2AR -- Extensions');
  assert.deepEqual(r.used, ['Univ 1AC.docx', 'Acton 1NC.docx', 'Univ 2AC.docx', '2AR.docx']);
  assert.equal(draftReport([{ name: 'x.docx', headings: [H(2, 'Contact')] }]).report, '');
});
