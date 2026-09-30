# Upstream Harbor → Quadlet integration fixture

Source: [goharbor/harbor-helm](https://github.com/goharbor/harbor-helm), published
chart **1.19.2**, Harbor **2.15.2**, from https://helm.goharbor.io.
`rendered.yaml` is the complete rendered chart with Secret contents replaced by
obvious test markers and volatile checksum annotations removed. It is a parser
regression fixture, not a runnable registry: its certificate/key markers are not
valid PEM. Render the real chart for a runnable bundle.

`values.yaml` keeps nginx, internal PostgreSQL, Redis, Trivy, persistence, and the
registry sidecar. It disables chart TLS and ingress, uses a loopback NodePort
30002, and sets `externalURL` for a host reverse proxy at `https://harbor.laptop`.
Use your own externally reachable HTTPS URL and terminate TLS at that proxy.
No chart templates or application configuration are patched after rendering.

## Render and convert

```sh
helm repo add harbor https://helm.goharbor.io
helm repo update harbor
umask 077
helm template harbor harbor/harbor --version 1.19.2 --namespace harbor \
  -f fixtures/harbor/values.yaml > /tmp/harbor.yaml
```

Paste `/tmp/harbor.yaml` into **Kubernetes to Quadlet** in IT Tools. Download the
ZIP, and use **Download Secret values separately (.json)** for the exact Secret
values from this rendering. The standard ZIP has references, not values.
Do not render a second time just to get Secrets: Helm generates random signing
keys and shared credentials which must match the ConfigMaps and other consumers.
Keep the manifest and separate JSON private and out of version control.

For repeatable development, this CLI calls the same converter as the browser:

```sh
pnpm convert:kubernetes /tmp/harbor.yaml --output /tmp/harbor-quadlets --secrets
```

The optional `--secrets` writes a separate `secrets.json` with mode 0600, using
exclusive creation. Without that flag, no Secret values are written by the CLI.

## Import and start

Extract the bundle into `~/.config/containers/systemd/harbor/`. Put only the separately downloaded JSON outside that
directory, with `chmod 600`. As the same user who will run the containers:

```sh
cd ~/.config/containers/systemd/harbor
python3 import-secrets.py /private/path/secrets.json --dry-run
python3 import-secrets.py /private/path/secrets.json
bash start-quadlets.sh
```

Requires Podman 5.8+ (validated with 5.8.4), cgroup v2, and Python 3 for the
importer. The importer reads Kubernetes Secret JSON, JSON arrays, or Lists,
decodes `data`, gives `stringData` precedence, and passes values over stdin to
`podman secret create --replace`. It never puts values in arguments or logs.
Literal env and ConfigMap contents are preserved; credentials embedded there are
not automatically detected or redacted. Source namespace/name/key determine each Podman secret name; consumers of the
same key share it even when their environment variable names differ. Empty env
keys become empty values because Podman rejects zero-byte secrets.

Secret files use the Kubernetes target path and mode, with UID/GID from the
container and Pod security context. The signing key and registry htpasswd mount
are preserved. After rotation, recreate the consuming containers; importing new
values alone does not update already created containers. Podman's default secret
store is not encrypted at rest: manage imports with your secret-management system
if the host requires an encrypted source/store.

The database initializer runs once before its main container through systemd
Requires/After dependencies. Pods keep their network namespace through init exits
and container restarts. Named volumes are initially empty; Podman `:U` approximates
fsGroup ownership using the container UID/GID. This modifies local volume
ownership and is not equivalent to Kubernetes group permission reconciliation.

Three generated HAProxy containers preserve the core, jobservice and portal
Services' hard-coded 80 → 8080 mappings. Their DNS resolvers follow Pod IP changes.
They bind port 80 inside their rootless pods with NET_BIND_SERVICE; the only host
listener is `127.0.0.1:30002`. Point your host TLS reverse proxy at that listener.

## Validate

Run the Podman generator against the extracted bundle and inspect diagnostics,
not just its exit code:

```sh
QUADLET_UNIT_DIRS="$PWD" /usr/lib/systemd/system-generators/podman-system-generator \
  --user --dryrun
```

Once your reverse proxy serves the configured external URL:

```sh
uv run --no-project fixtures/harbor/smoke.py --url https://harbor.laptop \
  --secrets /private/path/secrets.json
```

This authenticates as the rendered admin, creates a private `quadlet-smoke`
project, obtains a registry token, pushes and pulls a minimal OCI image/config,
and requires every Harbor health component to pass. It leaves the small smoke
artifact in that disposable test registry. It does not print credentials/tokens.

The integration test ran the Quadlet generator's actual Podman commands in
Requires/After order, without installing persistent host systemd services. The
jobservice startup retry was exercised after core became ready. All eight Harbor
components were healthy and authenticated OCI push/pull passed. Kubernetes
probes, scheduling, storage provisioning and controller lifecycle remain outside
the converter's scope. This validates a single-instance Harbor, not HA migration
or preservation of existing Kubernetes PVC data.
