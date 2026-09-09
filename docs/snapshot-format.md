# Snapshot archives and offline restore

The daemon owns snapshot creation and interpretation. Cloud stores and relays
opaque ZIP bytes. A backup does not change live vault paths or content.

## Schema 2

`kb1-snapshot.json` records `schemaVersion: 2`, `createdAt`, `durableAsOf`,
`files`, `directories`, and source byte/file totals. Each file records its ZIP
`path`, byte size, SHA-256, mode, and modification time. Each directory records
its ZIP `path` without a trailing slash, mode, and modification time, including
empty directories. An entry has `originalPath` when its archive path differs
from its exact daemon-home-relative path. `kb1-snapshot.complete` contains the
matching creation timestamp and is emitted only after source validation.

Ordinary paths remain readable. A segment is mapped when Windows cannot
represent it, when sibling names collide under case/Unicode normalization, or
when it begins with the reserved `~kb1-` prefix. Its archive segment is `~kb1-`
plus the SHA-256 of its original UTF-8 segment, retaining a short alphanumeric
extension where possible. Descendants inherit their mapped parent path. The
manifest, not a hash reversal, preserves original names. Duplicate paths or a
mapping collision fail closed. ZIP creation/parsing and hashing use yazl,
yauzl, and Node's crypto library; this mapping is the format-specific glue.

An ordinary ZIP extractor shows all archived bytes, but renamed paths can
affect links and metadata references. Use the restore command for a working
daemon home. Original names that are impossible on Windows remain impossible
there; use a compatible filesystem rather than silently renaming or losing
customer data. Case-colliding names require a filesystem that distinguishes
them. The original archive remains usable even when a restore target does not.

## Restore into a new home

From the matching daemon checkout with dependencies installed:

```sh
pnpm snapshot:restore --archive /path/to/snapshot.zip --target /tmp/kb1-restored-home
KB1_HOME=/tmp/kb1-restored-home KB1_HOST=127.0.0.1 KB1_PORT=17390 pnpm dev:daemon
```

Choose a free local port and a target that does not exist. Packaged builds also
provide `kb1-restore --archive ... --target ...`. The restore command accepts
legacy schema 1 and schema 2. It validates the manifest, completion marker,
entry inventory, original paths, sizes, and hashes; rejects links and path
traversal; and creates files exclusively so an existing file or incompatible
case alias cannot be overwritten. A failure removes only the destination home
created by this invocation. The ZIP is never modified. Ownership and special
permission bits are not restored; the new home is private to the operator.

After restoration, inspect representative notes, attachments, and trash, then
start the daemon and verify vault enumeration and a real edit/save. Recovery
into a live production volume is a separate operator-approved cutover with a
captured rollback point. Never use this command to merge into a live home.

## Release compatibility

Cloud versions that accept only snapshot schema 1 must be upgraded to accept
schema 2 **before** rolling out this daemon. A Cloud code deployment and a
managed-daemon fleet rollout are separate steps. The Cloud backup descriptor's
own schema version is independent of the daemon archive schema.

## Consistency and exclusions

Snapshots flush dirty sessions, copy files into a private temporary capture,
and validate the source before hashing and compression. A reflink is used when
the filesystem supports it, with a normal copy as fallback. Edits after this
capture cannot invalidate the archive. Changes during capture still fail the
attempt; discard that ZIP and retry. The last successful backup must remain
intact when a later attempt fails.

Temporary storage can require the full uncompressed source plus the final ZIP
when reflinks are unavailable. HTTP snapshots keep the capture inside the
daemon-owned spool so restart cleanup covers interrupted work. Continuous
mutation faster than the capture window can still prevent a snapshot; backup
age and failures must be monitored rather than claiming guaranteed completion.
A local 1,001-file / 12.9 MB probe completed 3/3 attempts with one edit per
second after capture was introduced (2/3 before); ten edits per second still
failed all three attempts. This is a synthetic observation, not a fleet SLO.

Archives include active vaults, recoverable trash, and portable `.kb1` metadata.
They exclude `.git` and daemon-local `.kb1/cache`, `runtime`, `tmp`, and `secrets`
directories. They are not a backup of Cloud identity, billing, or D1 records.
