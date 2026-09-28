import test from 'node:test';
import assert from 'node:assert/strict';
import {addressWithoutKey} from '../../lib/editor-link';

test('the editor address loses its key and keeps everything else', () => {
  assert.equal(addressWithoutKey('/p/project-test', '', '#key=private_capability_1234567890'), '/p/project-test');
  assert.equal(addressWithoutKey('/p/project-test', '?scene=hero', '#key=private_capability_1234567890&tab=CSS'), '/p/project-test?scene=hero#tab=CSS');
  assert.equal(addressWithoutKey('/p/project-test', '', '#tab=CSS'), '/p/project-test#tab=CSS');
  assert.equal(addressWithoutKey('/p/project-test', '', ''), '/p/project-test');
});
