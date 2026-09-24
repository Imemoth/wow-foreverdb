# ForeverDB sync behavior

The sync helper is session-based by design.

Run `sync-db.cmd` once when you want database sync active. It does not install
itself at Windows startup and it does not use Task Scheduler.

WoW writes SavedVariables to disk on:

- `/reload`
- logout
- client exit

The watcher checks all `ForeverDB.lua` files under `WTF/Account` and uploads
a snapshot only when the exported content changed.

## Safety

The server stores the timestamp of the latest accepted snapshot for each
anonymous installation. Older snapshots are ignored, so a stale WTF backup or a
second old account file cannot roll central data backwards.

Uploads are idempotent: each upload replaces the previous snapshot for that
installation instead of adding the same counters again.

## One-shot test

```powershell
.\scripts\sync-db.ps1 -Once
```

This checks all discovered SavedVariables files once and exits.
