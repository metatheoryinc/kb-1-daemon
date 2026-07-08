import { describe, expect, it } from 'vitest';
import type { PersistedClient } from '@tanstack/query-persist-client-core';

import { trimPersistedClient } from './query-persistence';

describe('query client persistence', () => {
  it('keeps persisted note snapshots bounded while preserving other queries', () => {
    const noteQueries = Array.from({ length: 201 }, (_, index) =>
      persistedQuery({
        queryHash: `note-${String(index)}`,
        queryKey: ['vault', 'v1', 'note', `n${String(index)}`],
        dataUpdatedAt: index,
      }),
    );
    const treeQuery = persistedQuery({
      queryHash: 'tree',
      queryKey: ['vault', 'v1', 'tree'],
      dataUpdatedAt: 0,
    });
    const persistedClient = persistedClientWithQueries([treeQuery, ...noteQueries]);

    const trimmed = trimPersistedClient(persistedClient);
    const keptHashes = new Set(trimmed.clientState.queries.map((query) => query.queryHash));

    expect(trimmed.clientState.queries).toHaveLength(201);
    expect(keptHashes.has('tree')).toBe(true);
    expect(keptHashes.has('note-0')).toBe(false);
    expect(keptHashes.has('note-1')).toBe(true);
    expect(keptHashes.has('note-200')).toBe(true);
  });
});

function persistedClientWithQueries(
  queries: PersistedClient['clientState']['queries'],
): PersistedClient {
  return {
    timestamp: 1,
    buster: 'test',
    clientState: {
      mutations: [],
      queries,
    },
  };
}

function persistedQuery(args: {
  queryHash: string;
  queryKey: readonly unknown[];
  dataUpdatedAt: number;
}): PersistedClient['clientState']['queries'][number] {
  return {
    queryHash: args.queryHash,
    queryKey: args.queryKey,
    state: {
      dataUpdatedAt: args.dataUpdatedAt,
    },
  } as PersistedClient['clientState']['queries'][number];
}
