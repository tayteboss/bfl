# Film Printing isolated staging

This directory contains the Film Printing staging implementation: a persistent
Node service, Shopify Function sources, the storefront form/cart modules, and
local regression tests. It is scoped to the configured development store. The
source checkpoint is not production deployment approval or a claim that every
browser/provider combination has passed live acceptance.

## Local verification

Use Node 22.21.1 or a compatible newer version with `node:sqlite`. From the
repository root:

```sh
npm ci --prefix apps/film-printing-staging
node --test apps/film-printing-staging/tests/*.test.mjs
python3 -m unittest discover -s apps/film-printing-staging/tests -p 'test_*.py'
```

Run the Node tests from the repository root: several integration fixtures resolve
application files relative to that directory. The tests use temporary SQLite
databases and generated Shopify/upload-provider transports. HTTP tests need
permission to listen on loopback. They do not require live credentials.

The retained Function candidate under
`fixtures/film-printing/f06b-continuation/attempt-02/candidate` is an intentional
immutable test dependency. Nine custody tests verify its exact manifest, four
compiled targets and 440 measured cases, including corruption and interrupted
packaging. Its deterministic matrices and binaries are not deployment output to
regenerate in place. Source lockfiles and the separate build harness support a
new artifact in a fresh directory when Function changes require it.

## Source layout

- `backend/` composes HTTP, fresh proof, finite resource sessions, persistence and
  the persistent staging entry point.
- `checkout/` implements cart ownership, immutable preparations, pricing grants,
  confirmed-current recovery and no-replay handling for uncertain writes.
- `jobs/`, `pricing/`, `configuration/`, `shipping/` and `carrier/` implement
  source-bound selections, prices, packing and shipping callbacks.
- `uploads/` implements owned uploads and bounded public-source imports;
  `theme/` integrates local files, Direct Link, Google Drive and Dropbox with the
  existing form and cart. Crop controls are disabled in the current MVP.
- `extensions/` and `checkout/rust/` contain Shopify Function sources and pinned
  build dependencies. Historical synthetic probes remain separate from the
  customer entry point.
- `hosting/` contains container, ingress and single-writer supervisor templates.

## Deployment boundary

See [hosting instructions](hosting/README.md) and the
[persistent service runbook](hosting/PERSISTENT-DEPLOYMENT.md). Deployment needs
private environment/material files and an independently verified isolated-store
configuration. Shopify client/application IDs and store names in source are
identifiers, not credentials. Keep app secrets, bearer tokens, cart capabilities,
provider account inventories, signed delivery URLs, host access metadata,
SQLite data/WAL, backups and activation receipts outside Git.

The persistent executable is `backend/staging-main.mjs`; historical entry points
and probes are not interchangeable deployment recipes. Initialize only a new
reviewed service. An update must preserve the current database, keys, owner
history and original finite deadlines. Unknown external-write outcomes must be
reconciled by the guarded recovery paths rather than replayed or erased.
