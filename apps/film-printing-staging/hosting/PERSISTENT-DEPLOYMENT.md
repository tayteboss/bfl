# Persistent isolated staging supervisor

These are isolated-service deployment materials only. They do not revive expired
owners, recreate an existing database, clear authority, or activate production.
A single authorized operator owns each deployment and verifies actual state.

## Runtime contract

Use the existing pinned `hosting/compose.yaml` plus `persistent.compose.yaml`.
Set `BFL_RUNTIME_IMAGE` to the reviewed `sha256:` image and
`BFL_STAGING_MANIFEST_SHA256` to the exact private `service.json` hash. Runtime is:

```
node backend/staging-main.mjs serve /run/staging/service.json MANIFEST_SHA256
```

Preserve `/var/lib/bfl-staging/data:/data`, UID1000, the existing secret mount,
read-only root, fixed Caddy peer/network, and no public runtime port. Add
`/etc/bfl-staging/persistent:/run/staging:ro`. Private files include service.json,
three nonpersonal fixtures, carrier-path, Shippo inventory, and runtime.env.
Existing app/job/session, Uploadcare API/delivery, and Shippo TEST credentials
stay private in `/etc/bfl-staging/secrets`. The manifest hash pins the command;
source and fixture hashes remain application validation's responsibility.

Do not supply `--hostname`: Docker must generate the hostname from the first12
characters of the full container ID. The runtime Node process must be PID1.
The supervisor uses that unique hostname to match an abandoned owner.json to the
exact dead writer. A fixed hostname reused across containers cannot establish
that correspondence and is rejected.

## One-time cutover sequence

1. Complete reviewed application/source/Function/carrier/theme preparation, keep
   client ingress closed, and stop the existing runtime gracefully. Confirm the
   current DB/history backup and that no previous diagnostic/watchdog remains.
   Never replace the current SQLite file with a historical backup.
2. Run the explicit one-time persistent initialization with all writers stopped,
   using the exact reviewed image/manifest and existing private configuration.
   This is separate from systemd. It must close cleanly and leave no runtime.lock.
3. Create the single `bfl-staging-runtime` with the merged Compose files without
   starting it. If replacing the previous container, retain its stopped inspect
   receipt and do not remove an unexplained lock. Keep Docker restart policy `no`.
4. Install `persistent-supervisor.py` root-owned0755 at
   `/opt/bfl-staging/persistent-supervisor.py`, then execute:

   ```
   python3 /opt/bfl-staging/persistent-supervisor.py pin sha256:REVIEWED_IMAGE
   ```

   `pin` requires no existing supervisor manifest, no runtime.lock, exact target
   entry/arguments/policies, and all other data-capable containers stopped. It
   creates root-only `/etc/bfl-staging/persistent-supervisor.json` containing the
   full container ID, image ID and Config/HostConfig/Mounts fingerprint. Archive
   an old manifest only after an explicit stopped-writer deployment; never
   silently replace it to overcome a mismatch.
5. Install `bfl-persistent-staging.service` root-owned0644 in
   `/etc/systemd/system`, run `systemctl daemon-reload`, then
   `systemctl enable --now bfl-persistent-staging.service`. Do not also run a
   Compose start/up/recreate/watch operation against this service.
6. Verify actual `/healthz` and `/readyz`, source/identity/owner registration,
   credential refresh, and retained history. Render the private Caddy candidate:

   ```
   python3 /opt/bfl-staging/render-persistent-caddy.py \
     /etc/bfl-staging/persistent/carrier-path \
     /etc/bfl-staging/persistent/Caddyfile.candidate
   ```

   The renderer creates a new0600 file only; it never replaces the live mounted
   Caddyfile. Validate the candidate using the existing pinned Caddy image/tool
   before cutover, then apply through the root's existing exact-file ingress
   deployment and verify readback. Static tests do not establish that the candidate parses under the installed
   Caddy version; perform that check before replacing ingress.
7. Confirm actual persistent restart and two independent cart flows before
   handing the stable link to the client. `systemctl stop` invokes a bounded35s
   Docker stop, checks the exact target is dead, and leaves uncertain SQLite
   operations for application recovery. The supervisor never edits SQLite.

## Crash behavior

Each start holds a host flock for this supervisor instance. A new start inspects
all Docker containers and refuses any other active container with a RW mount of
this data directory, its ancestor or a DB subpath. A running exact pinned target
is reattached, without release or another start. A stopped exact pinned target
may have its lock released only after matching private owner.json's UUID token,
PID1 and unique container hostname; all containers are observed again directly
before release, and lock inode/content and container start/finish timestamps
must remain unchanged. Only that owner.json and its empty directory are removed.

Unknown/mismatched container or lock states stop the unit with exit78. Docker
connection failures and unexpected normal exits retry after10s; no newcontainer
or grant is created. An application exit78 is propagated and stops retries.
Application startup must verify/recover durable authority, pending sends and
provider custody before readiness. Successful host lock recovery does not prove
successful cart/publication recovery, and it does not authorize replaying an
unknown mutation.

To deliberately replace the container/image later: stop the systemd unit,
verify the exact stopped state, run `persistent-supervisor.py recover` if its
known lock remains, archive the old private manifest and container receipt, then
perform a reviewed one-container cutover and pin the new container. No automatic
recreate, timed lock stealing, rolling replicas, or blind `rm runtime.lock`.

The service uses `Wants=docker.service` and `After=docker.service`; a transient
Docker disconnect causes reattachment/restart rather than coupling the staging
service's lifetime to an interactive operator session. Docker restart remains
`no`, as recommended when using a host process manager. See [Docker restart
policy documentation](https://docs.docker.com/engine/containers/start-containers-automatically/),
[attach semantics](https://docs.docker.com/reference/cli/docker/container/attach/),
and [systemd service semantics](https://www.freedesktop.org/software/systemd/man/261/systemd.service.html).
