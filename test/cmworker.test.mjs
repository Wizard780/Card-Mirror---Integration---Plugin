import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmWorkerPath } from '../lib/cmworker.mjs';

test('cmWorkerPath: only the docx-open worker inside an app bundle', () => {
  assert.equal(cmWorkerPath('file:///Applications/cardmirror.app/Contents/Resources/renderer/assets/docx-open-worker-BFab4lSo.js'),
    '/Applications/cardmirror.app/Contents/Resources/renderer/assets/docx-open-worker-BFab4lSo.js');
  assert.equal(cmWorkerPath('file:///Applications/cardmirror.app/Contents/Resources/renderer/assets/docx-open-worker-BFab4lSo.js?x=1'),
    '/Applications/cardmirror.app/Contents/Resources/renderer/assets/docx-open-worker-BFab4lSo.js');
  for (const bad of [
    'file:///Applications/cardmirror.app/Contents/Resources/renderer/assets/main-wou1R90m.js',
    'file:///Users/me/Documents/docx-open-worker-x.js',
    'file:///Applications/cardmirror.app/Contents/Resources/renderer/assets/../../../../../etc/docx-open-worker-a.js',
    'http://localhost/assets/docx-open-worker-a.js',
    'file:///Applications/cardmirror.app/Contents/Resources/renderer/assets/docx-open-worker-a.js/../secret',
    null, 42,
  ]) assert.equal(cmWorkerPath(bad), null, String(bad));
});
