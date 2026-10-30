F06P V2 disabled local Function candidate. NOT a released app or checkout proof.

Authority schema 2 matches a protected cart-binding marker and the exact unique
current immutable-job set in a protected Shop grant. Each Function uses only its
own current IDs for output addresses. Unobserved equivalent same-cart content is
intentionally allowed; recorded invalidation/retirement remains effective.

All included matrices are synthetic. Same-app public/untrusted-writer exclusion,
native propagation, supported recalculation, actual enforcement and lifecycle
visibility remain unproved integration requirements. No release IDs are assigned.
Runtime publication stays disabled; no verifyFunctionIdentity implementation.

manifest.json binds source, queries, schemas, compiled bytes, saved input/output
matrices and budgets. manifest.sha256 is not an independent authenticity proof:
compare it to the separate F06P handoff record. Old F02/F06B artifacts are unchanged.

Verify retained custody from this folder:
  node source/checkout/candidate-bundle.mjs verify /absolute/path/to/this/candidate

Rebuild only into a NEW directory using the repository harness:
  PATH=/private/tmp/bfl-f06p-toolchain/root/bin:$PATH \
  CARGO_HOME=/private/tmp/bfl-f06p-toolchain/cargo \
  BFL_CARGO=/private/tmp/bfl-f06p-toolchain/root/bin/cargo \
  node apps/film-printing-staging/checkout/verify-wasm-f06b.mjs \
    --binding-v2 --retain-bundle /absolute/new/destination

The temporary compiler/cache may be removed by macOS. Compiler, Cargo and library
bytes match the historical pins; this installation has its own separately retained
metadata lock. Never silently update pins. Build runs Cargo offline/locked, then
Shopify's pinned trampoline and optimizer; no dev/deploy/release command is used.

For replay use each target's saved fixture matrix, query/schema and function.wasm
with the pinned Shopify test helpers/runner. Validation deliberately rejects the
historical V1 golden authority. No golden history is rewritten.
