import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../lib/report.mjs';

test('reads the side\'s own constructive, final speech and result', () => {
  const report = '1AC -- False Profits\n1NC -- Econ, Innovation, Offshoring\n2AC -- All, Innovation Turn\n2NC -- Econ\n2AR -- All\n2NR -- Innovation\n[W]';
  assert.deepEqual(parseReport(report, 'A'), { own: ['False Profits'], final: [], result: 'W' });
  assert.deepEqual(parseReport(report, 'N'), { own: ['Econ', 'Innovation', 'Offshoring'], final: ['Innovation'], result: 'W' });
});

test('handles lowercase labels, single dashes, colons and no space before the dash', () => {
  assert.deepEqual(parseReport('1ac: warming, grids\n1nc: parody,quantum', 'N').own, ['parody', 'quantum']);
  assert.deepEqual(parseReport('1ac - climate, grids, water\n2ar - all', 'A'), { own: ['climate', 'grids', 'water'], final: [], result: null });
  assert.deepEqual(parseReport('1ac- econ, communities\n\n1nc- econ\n\nall down\n\nw', 'A'), { own: ['econ', 'communities'], final: [], result: 'W' });
  assert.deepEqual(parseReport('1AC—(A)s(I)an Fantasies', 'A').own, ['(A)s(I)an Fantasies']);
});

test('skips filler entries', () => {
  for (const filler of ['All', 'all down', 'same', 'same as r3', 'everything else is same', 'x', '-', 'ALL']) {
    assert.deepEqual(parseReport(`1AC - ${filler}`, 'A').own, [], filler);
  }
  assert.deepEqual(parseReport('2NR - P - TT, Skep.', 'N').final, ['P - TT', 'Skep']);
  assert.deepEqual(parseReport('1ac - efficiency (bubble, amrs), mobilization', 'A').own, ['efficiency (bubble, amrs)', 'mobilization']);
});

test('reads results in every form seen on the caselist', () => {
  const cases = [
    ['[W]', 'W'], ['W', 'W'], ['w', 'W'], ['L :(', 'L'], ['LLL\nwe  got cooked', 'L'], ['[WLL]', 'L'], ['[WWL]', 'W'],
    ['W prob the silliest round ever', 'W'], ['[L] see you at bronx', 'L'], ['we had to forfeit', null], ['Check team notes!', null],
  ];
  for (const [report, want] of cases) assert.equal(parseReport(report, 'A').result, want, report);
});

test('empty or junk reports parse to nothing', () => {
  assert.deepEqual(parseReport('', 'A'), { own: [], final: [], result: null });
  assert.deepEqual(parseReport(null, 'N'), { own: [], final: [], result: null });
  assert.deepEqual(parseReport('bubble guppies', 'A'), { own: [], final: [], result: null });
  assert.deepEqual(parseReport('1AC - X', ''), { own: [], final: [], result: null });
});
