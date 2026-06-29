import { QueryClient } from '@tanstack/svelte-query';

export interface KbQueryClient {
  client: QueryClient;
}

export function createKbQueryClient(): KbQueryClient {
  return {
    client: new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          staleTime: 0,
        },
      },
    }),
  };
}
