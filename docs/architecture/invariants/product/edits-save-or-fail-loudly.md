# Edits Save Or Fail Loudly

## Invariant

If the user can type into it, then what they see on screen is either durably
saving to the filesystem, or the product is loudly telling them it is not.
Silent persistence failure, and silent divergence between screen and disk,
are never acceptable.

Losing a small in-flight edit during an out-of-band conflict (e.g. a direct
filesystem write racing an active session) is tolerable — that path
circumvents conflict-free resolution by definition — but ONLY when the user
is clearly informed. The failure mode this invariant forbids is the user
continuing to type, unaware that their changes are not being preserved or
that the underlying file changed beneath them.

## This Means

- A persistence failure (disk error, permission, missing directory) surfaces
  to every connected client as a prominent, persistent warning until a
  subsequent write succeeds.
- An external change to a file backing an active session is detected, the
  session state is reconciled to reflect it, all clients converge, and all
  clients display a clear notice that the file changed outside KB-2.
- No code path swallows a write error into a server-side log alone — the log
  line exists for operators; the user-facing signal exists for the user.
- Recovery is also visible: when saving resumes, the warning clears.

## Temporary Exception (accepted, with expiry)

Transient WebSocket disconnects: while the socket is down, edits are not
saving and the only indicator is the connection status chip. Accepted for
now because offline detection, reconnect, and read-only-on-disconnect have
not been built. This exception expires when those ship (see horizons); it
must not be used to justify any new silent-failure path.

## Violations

- A failed materialization that only writes a daemon log line.
- Reloading a file under an active session without telling the clients.
- A save indicator that shows "saved" state it cannot verify.
- Extending the WebSocket exception to new failure classes.

## Review Checklist

- Can any new write path fail without a user-visible signal?
- Does every reconcile-from-disk path emit a client-facing event?
- Does recovery clear the warning state?
- Is the WebSocket exception's scope unchanged?
