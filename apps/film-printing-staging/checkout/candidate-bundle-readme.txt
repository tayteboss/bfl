F06B UNRELEASED CANDIDATE — LOCAL REVIEW ONLY

This directory retains optimized candidate Function bytes, not registered Functions
or an app release. All release_id and function_id values are null. checkout_ready
is false. No deployment, registration, source import or production use is authorized.
Historical isolated app/store IDs are references, not freshly verified remote state.

1. Verify custody without building, network or external dependencies:
   node source/checkout/candidate-bundle.mjs verify /absolute/path/to/this/candidate
   Compare manifest.sha256 with the separate continuation verification record.
   A local digest establishes integrity against that record, not signer identity.

2. Inspect manifest.json, evidence/wasm-results.json and each target's matrix.
   The 440 saved inputs/expected outputs were run against targets/*/function.wasm
   before publication. Those files equal the CLI's measured optimized output.
   All eight former large-cart failures are assertions. Limits and 8M headroom
   ceiling remain mandatory. Historical metrics are reference evidence only.

3. Rebuild and run the full matrix from the repository with the exact recorded
   source hashes and candidate-toolchain.lock.json. Use a NEW destination each time:
   CARGO_HOME=/private/tmp/bfl-f06b-toolchain/cargo \
   RUSTUP_HOME=/private/tmp/bfl-f06b-toolchain/rustup \
   BFL_CARGO=/private/tmp/bfl-f06b-toolchain/cargo/bin/cargo \
   node apps/film-printing-staging/checkout/verify-wasm-f06b.mjs \
     --retain-bundle /absolute/path/to/new-attempt
   The parent directory must exist. Existing destinations, including failed ones,
   are refused. Failures retain INCOMPLETE/failure.json and partial .pending files;
   successful candidates appear atomically at new-attempt/candidate. Never use a
   .pending tree. Do not run the legacy no-argument mode: it writes historical F06B
   fixtures. The toolchain lock checks compiler/stdlib, CLI, runner, trampoline,
   optimizer and verifier dependencies; it does not silently install or repin.
   Cargo uses --offline --locked. Dependencies/tools must already be available.

4. Sources needed to rebuild the raw module are under source/checkout/rust.
   Cargo build: --offline --locked --target wasm32-unknown-unknown --release.
   To reconstruct the temporary build layout, put each targets/<name> schema and
   shopify.extension.toml at source/extensions/f06b-candidate-<name>/, its query at
   src/<export>.graphql, and create dist/. Use source/shopify.app.staging.toml.
   The config copies the raw module from ../../checkout/rust/target/... and Shopify
   CLI then performs the pinned trampoline/optimizer step. Raw cargo output alone
   is NOT the retained, tested optimized module. Do not overwrite retained bytes.
   Every CLI build/info call must carry SHOPIFY_FLAG_APP_CONFIG=staging,
   SHOPIFY_FLAG_STORE=bellows-film-printing-staging.myshopify.com and an explicit
   absolute SHOPIFY_FLAG_PATH plus the temporary extension --path. No app dev,
   deploy, release, registration or remote CLI action is part of this procedure.

5. Independent replay can use the pinned runner with each matrix input on stdin,
   --export from the manifest, --query-path and --schema-path from that target,
   -f its retained function.wasm, and --json. Compare output exactly with
   expectedOutput and enforce all recorded budgets. Saved inputs are synthetic.
   The reference/cases.mjs and synthetic.mjs files are provenance copies, not
   standalone generators; repository job/config dependencies are needed to
   regenerate them. The full saved matrices permit replay without those modules.

Native pickup/authority/Send Rolls behavior and existing staging bounds are
unchanged. This bundle cannot supply real host/session/customer/guest/cart/Function
ID/recalculation, uploader/widget, catalog, callback/order/group or physical quote
proof. The form is unavailable; full F05/F06/F07 and production go-live remain gated.
