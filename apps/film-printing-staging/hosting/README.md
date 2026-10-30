# Isolated staging hosting templates

These files describe the single-writer deployment contract. Actual cloud-account
identities, host access records, private environment files, provider inventories,
service manifests, backups and deployment receipts are maintained outside Git.
No file here grants access or activates a live service.

Use `compose.yaml` with `persistent.compose.yaml` for the persistent runtime,
`persistent-supervisor.py` with `bfl-persistent-staging.service` for process
supervision, and `Caddyfile.persistent.in` with `render-persistent-caddy.py` for a
reviewed ingress candidate. The plain `Caddyfile` is a historical restricted
session template, not the complete persistent customer ingress.

Pin reviewed image digests and set the hostname explicitly. The example env files
contain identifiers and secret-file paths only; their old image references do
not establish the currently deployed runtime. Supply actual configuration through
private mounted files. Do not publish the runtime port or add another writer to
the SQLite volume. Keep the data and secret mounts, UID and fixed Caddy peer
consistent with application validation.

Follow [PERSISTENT-DEPLOYMENT.md](PERSISTENT-DEPLOYMENT.md) for initialization,
cutover, restart and crash-lock handling. Stop and verify the existing writer
before replacing a container. Preserve current history and stable keys, and never
restore an old database merely to make a test pass. A consistent backup and a
successful startup are separate from authenticated cart/provider acceptance.
