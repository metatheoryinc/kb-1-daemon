import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDispatchPayload } from './linked-cloud-repin-dispatch.mjs';

const HEAD_SHA = '1'.repeat(40);
const MERGE_SHA = '2'.repeat(40);

function mergedPull(overrides = {}) {
  return {
    number: 111,
    state: 'closed',
    merged_at: '2026-08-18T20:56:38Z',
    merge_commit_sha: MERGE_SHA,
    base: {
      ref: 'main',
      repo: { full_name: 'metatheoryinc/kb-1-daemon' },
    },
    head: {
      sha: HEAD_SHA,
      repo: { full_name: 'metatheoryinc/kb-1-daemon' },
    },
    ...overrides,
  };
}

test('builds an exact Cloud repository dispatch payload', () => {
  assert.deepEqual(buildDispatchPayload(mergedPull()), {
    event_type: 'daemon-pr-merged',
    client_payload: {
      source_repository: 'metatheoryinc/kb-1-daemon',
      daemon_pr_number: 111,
      daemon_head_sha: HEAD_SHA,
      daemon_merge_sha: MERGE_SHA,
      daemon_base_ref: 'main',
    },
  });
});

test('rejects a closed but unmerged daemon pull request', () => {
  assert.throws(() => buildDispatchPayload(mergedPull({ merged_at: null })), /must be merged/);
});

test('rejects a daemon pull request that targets another branch', () => {
  assert.throws(
    () =>
      buildDispatchPayload(
        mergedPull({
          base: {
            ref: 'release',
            repo: { full_name: 'metatheoryinc/kb-1-daemon' },
          },
        }),
      ),
    /must target main/,
  );
});

test('rejects a fork daemon pull request', () => {
  assert.throws(
    () =>
      buildDispatchPayload(
        mergedPull({
          head: { sha: HEAD_SHA, repo: { full_name: 'someone/fork' } },
        }),
      ),
    /must use an internal branch/,
  );
});
