import type { PersistedClient } from '@tanstack/query-persist-client-core';

const MAX_PERSISTED_NOTE_QUERIES = 200;

export function trimPersistedClient(persistedClient: PersistedClient): PersistedClient {
  const queries = persistedClient.clientState.queries;
  const noteQueries = queries.filter((query) => isPersistedNoteQuery(query.queryKey));
  if (noteQueries.length <= MAX_PERSISTED_NOTE_QUERIES) return persistedClient;

  const noteQueriesToKeep = new Set(
    [...noteQueries]
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
      .slice(0, MAX_PERSISTED_NOTE_QUERIES)
      .map((query) => query.queryHash),
  );

  return {
    ...persistedClient,
    clientState: {
      ...persistedClient.clientState,
      queries: queries.filter(
        (query) =>
          !isPersistedNoteQuery(query.queryKey) || noteQueriesToKeep.has(query.queryHash),
      ),
    },
  };
}

function isPersistedNoteQuery(queryKey: unknown): boolean {
  return (
    Array.isArray(queryKey) &&
    queryKey[0] === 'vault' &&
    typeof queryKey[1] === 'string' &&
    queryKey[2] === 'note'
  );
}
