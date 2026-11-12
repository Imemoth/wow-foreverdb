# ADM-01B-5 boundary rehearsal

Migration 0024 adds an inactive, private editorial permission gate and a narrow
audit append helper. It changes the Admin logout RPC so a session revocation and
a guarded editorial transaction serialize on the same session key. It creates
no article table, public editorial RPC, staff assignment or active policy.

`editorial_probe` exists only in the disposable test database. The tests prove
the authorization, synthetic write and audit append can share a transaction;
they do not establish a production article workflow. A future action wrapper
must use a PostgREST-verified JWT, call the gate, validate authoritative CMS
state, mutate that state, append audit and commit as one transaction. Separate
narrow wrappers are required for draft edits, approval requests, revision
approval, publication and unpublication.

The accepted ADR-020 rules still require immutable revisions, independent
highlighted approval, classification history, approval replay protection and
public delivery consistency. The repository has no accepted ADM-03 content
store or authoritative revision model yet. Those actions remain unavailable
until the ADM-03 contract and its implementation are reviewed. Hosted migration,
Admin activation, Companion compatibility and external audit anchoring remain
separate gates.

Run the disposable tests with `FDB_ADMIN_PG_IMAGE=postgres:16` or
`postgres:17` and `bash database/tests/admin_editorial/run-docker.sh`.
