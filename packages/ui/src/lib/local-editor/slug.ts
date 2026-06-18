import { slug as githubSlug } from 'github-slugger';

/**
 * Slug helpers shared with the daemon, defined identically so a slug the
 * UI suggests is accepted by the server verbatim.
 *
 * These are PURE string transforms — no transport, no endpoint knowledge —
 * so they are allowed to live in `packages/ui` (the `ui-packages-own-no-
 * transport` invariant scopes only network/IO). The network submit stays
 * in the app (`apps/web/src/lib/kb-service.ts`).
 *
 * The daemon normalizes with the SAME `github-slugger` library
 * (`apps/daemon/src/vault-registry.ts`). Keep this in lockstep with it.
 */

/**
 * Normalize a string into a vault slug via github-slugger (battle-tested,
 * not hand-rolled). Stateless: the same input always yields the same
 * output (it does not dedupe across calls).
 */
export function suggestSlug(value: string): string {
  return githubSlug(value);
}

/**
 * Whether a slug is well-formed: non-empty AND already normalized
 * (idempotent under {@link suggestSlug} — slugging it again leaves it
 * unchanged). Mirrors the daemon's server-side check so the UI can flag a
 * bad slug before the round-trip.
 */
export function isWellFormedSlug(slug: string): boolean {
  return slug.length > 0 && suggestSlug(slug) === slug;
}
