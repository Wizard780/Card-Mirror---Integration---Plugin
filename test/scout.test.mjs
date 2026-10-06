import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpponent, codeMatches, schoolScore, pickTeam } from '../lib/scout.mjs';

test('parseOpponent splits Tabroom "School CODE" into school text and the debater code', () => {
  assert.deepEqual(parseOpponent('Cranbrook FZ'), { school: 'Cranbrook', code: 'FZ' });
  assert.deepEqual(parseOpponent('  VDA - Vancouver TZ '), { school: 'VDA - Vancouver', code: 'TZ' });
  assert.deepEqual(parseOpponent('FZ'), { school: '', code: 'FZ' });
  assert.deepEqual(parseOpponent(''), { school: '', code: '' });
});

test('codeMatches compares debater initials in either order, from names or the team code', () => {
  const lex = { team: 'AlHu', debaters: ['Ali', 'Hu'] };
  assert.equal(codeMatches('AH', lex), true);
  assert.equal(codeMatches('HA', lex), true, 'order does not matter');
  assert.equal(codeMatches('AlHu', lex), true, 'two-letter caselist style also matches');
  assert.equal(codeMatches('AS', lex), false);
  assert.equal(codeMatches('FZ', { team: 'Team1', debaters: ['Fox', 'Zhang'] }), true, 'debater names win when the team code is arbitrary');
  assert.equal(codeMatches('FZ', { team: 'FoZh', debaters: [] }), true, 'team code alone when no names');
  assert.equal(codeMatches('', lex), false);
  assert.equal(codeMatches('A', { team: 'All', debaters: [] }), false, 'the "All Teams" placeholder never matches');
});

test('schoolScore: exact > partial/acronym > nothing', () => {
  assert.ok(schoolScore('Cranbrook', 'Cranbrook') > schoolScore('Cranbrook', 'Cranbrook Kingswood School') );
  assert.ok(schoolScore('Cranbrook', 'Cranbrook Kingswood School') > 0);
  assert.ok(schoolScore('VDA - Vancouver', 'Vancouver Debate Academy') > 0, 'acronym + shared word');
  assert.ok(schoolScore('University', 'University School') > 0, 'filler words ignored');
  assert.ok(schoolScore('Acton-Boxborough', 'Acton-Boxborough') > 0);
  assert.equal(schoolScore('McLean', 'Lexington'), 0);
  assert.equal(schoolScore('', 'Lexington'), 0);
});

const T = (school, schoolLabel, team, debaters) => ({ school, schoolLabel, team, label: `${schoolLabel} ${team}`, debaters });

test('pickTeam: one initials match wins; two schools → the better Tabroom school match wins; tie or none → candidates', () => {
  const crFZ = T('Cranbrook', 'Cranbrook', 'FoZh', ['Fox', 'Zhang']);
  const otherFZ = T('Fairfax', 'Fairfax', 'FiZa', ['Fisher', 'Zapata']);
  const crAB = T('Cranbrook', 'Cranbrook', 'AlBe', ['Allen', 'Bell']);
  assert.equal(pickTeam('Cranbrook FZ', [crAB, crFZ]).match, crFZ);
  assert.equal(pickTeam('Cranbrook FZ', [otherFZ, crFZ, crAB]).match, crFZ, 'defers to the Tabroom school name');
  const tie = pickTeam('FZ', [otherFZ, crFZ]);
  assert.equal(tie.match, null);
  assert.deepEqual(tie.candidates, [otherFZ, crFZ]);
  const none = pickTeam('Cranbrook QQ', [otherFZ, crAB, crFZ]);
  assert.equal(none.match, null);
  assert.deepEqual(none.candidates.map((t) => t.team), ['AlBe', 'FoZh', 'FiZa'], 'no match: best-school teams first');
});

test('pickTeam: initials plus one shared word ("Lake") is a candidate, not a match; blank debater names do not crash', () => {
  const lf = { school: 'LF', schoolLabel: 'Lake Forest', team: 'LFHM', label: 'Lake Forest HM', debaters: ['Hall', 'Moss'] };
  const r = pickTeam('Lake Highland HM', [lf]);
  assert.equal(r.match, null);
  assert.deepEqual(r.candidates, [lf]);
  assert.equal(pickTeam('Lake Forest HM', [lf]).match, lf);
  assert.equal(pickTeam('X AB', [{ school: 's', schoolLabel: 'X', team: 't', debaters: [' ', 'B'] }]).match, null);
});
