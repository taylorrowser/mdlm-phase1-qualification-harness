import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectProposals } from '../lib/common.mjs';

test('proposal rejection covers object keys and values', () => {
  assert.throws(() => rejectProposals({ '$proposal.hidden': 'value' }), /unresolved \$proposal placeholder in key/);
  assert.throws(() => rejectProposals({ safe: '$proposal.hidden' }), /unresolved \$proposal placeholder/);
});
