import { QueryClient } from '@tanstack/svelte-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  persistQueryClient,
  removeOldestQuery,
  type Persister,
} from '@tanstack/query-persist-client-core';
import localforage from 'localforage';
import { trimPersistedClient } from './query-persistence';

export const CACHE_BUSTER = '20260707-note-snapshots';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface KbQueryClient {
  client: QueryClient;
  restored: Promise<void>;
}

export interface KbQueryClientOptions {
  persist?: boolean;
}

export function createKbQueryClient(options: KbQueryClientOptions = {}): KbQueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 0,
      },
    },
  });

  if (options.persist === false) {
    return { client, restored: Promise.resolve() };
  }

  const persister: Persister = createAsyncStoragePersister({
    storage: localforage,
    key: 'kb2-query-cache',
    retry: removeOldestQuery,
    serialize: (persistedClient) => JSON.stringify(trimPersistedClient(persistedClient)),
  });

  const [, restored] = persistQueryClient({
    queryClient: client,
    persister,
    maxAge: MAX_AGE_MS,
    buster: CACHE_BUSTER,
  });

  return {
    client,
    restored,
  };
}
