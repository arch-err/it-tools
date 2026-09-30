# Kubernetes container converters

Four tools share a browser-only manifest parser:

- `/kubernetes-to-compose`
- `/kubernetes-to-quadlet`
- `/kubernetes-to-docker-run`
- `/kubernetes-to-podman-run`

Paste rendered YAML (including multi-document input) or Kubernetes JSON/List
output. Helm rendering and cluster access are outside the converter's scope.
Input remains in memory when switching outputs; it is not saved to localStorage.

## Supported mappings

| Kubernetes input | Local output |
| --- | --- |
| Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob | One Pod instance with its containers |
| Image, command, args, workingDir | Container image and process configuration |
| Literal env, ConfigMap envFrom/key references | Container environment |
| Secret envFrom/key references and mounts | Native Podman secrets with namespace/name/key identity, target paths and modes; values imported separately |
| Missing non-Secret env references | Host environment references and explicit notes |
| Regular init containers | Ordered one-shot services/foreground commands before main containers |
| Service selectors and named target ports | Network aliases; TCP port differences use generated HAProxy Services |
| hostPort and nodePort | Explicit published ports, defaulting to loopback |
| ConfigMap mounts/items/subPath | Read-only file mounts and companion files |
| PVC and StatefulSet volumeClaimTemplates | Empty local named volumes; existing data is not migrated |
| emptyDir | Shared named volume with a lifecycle/medium warning |
| hostPath | Host bind mount |
| CPU/memory limits | Container limits |
| UID/GID, capabilities, privileged, read-only, no-new-privileges | Container security settings |
| restartPolicy | Runtime/systemd restart policy |
| hostNetwork | Host networking |

Compose and Docker run share each Pod's primary container network namespace with
its sidecars. Quadlet and Podman run create actual Podman pods on a shared
network. Recreating a Docker primary container can require recreating sidecars
that share its network namespace.

Unsupported kinds and Pod/container fields produce conversion notes. Restartable
init sidecars, probes, scheduling, ingress/network policies, storage provisioning,
projected/CSI mounts and cluster controllers are not reproduced. TCP Service port
translation uses generated HAProxy pods; UDP/host-network translation is not supported. Namespace-scoped short Service aliases can be
ambiguous on the shared local network; use qualified names when necessary.

ZIP downloads contain every generated file and a README with conversion notes.
Run scripts create containers but are not idempotent redeployment scripts; remove
existing containers/pods before rerunning them. Quadlets target rootless Podman
5.8+ and require all units and companion files in the same extracted directory.
The converter never executes the generated commands or starts workloads.

For Quadlet/Podman run, `secret-references.json` and `import-secrets.py` preserve
Secret source identity without including values. The separate **Download Secret
values** action exports Kubernetes Secret JSON from the exact pasted rendering;
normal file output and ZIP downloads exclude those values. Literal env and ConfigMap
contents are preserved, including any credentials embedded there. Import before startup.
Rotating Podman secrets requires recreating consuming containers. Intentional
empty env values do not create zero-byte secrets. Compose/Docker run still require
host env values and do not reproduce Secret mounts; their notes identify sources.
Podman named volumes use `:U` when approximating fsGroup, changing local ownership.

See [the Harbor integration fixture](../fixtures/harbor/README.md) for the pinned
upstream chart, rendering settings, Secret workflow, and authenticated OCI smoke
test. `pnpm convert:kubernetes` calls the browser converter for CLI validation.

## Development

Use the repository's pnpm commands: `pnpm dev`, `pnpm typecheck`, `pnpm build`,
and `pnpm test:unit --run`. Converter behavior tests live beside the shared
parser. Validate generated Compose with `docker compose config`, shell scripts
with `bash -n`, and Quadlets with the Podman systemd generator's `--user --dryrun`
mode before changing renderers. Inspect generator diagnostics as well as its
exit code: conversion errors can be printed even when the process exits zero.

Primary format references:

- https://docs.docker.com/reference/compose-file/services/
- https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html
- https://kubernetes.io/docs/concepts/workloads/pods/

## Container publishing

The fork's `CI and container` workflow runs lint, unit tests, type checking and
an application build on pull requests and pushes to `main`. After checks pass,
main builds publish amd64/arm64 images to `ghcr.io/arch-err/it-tools` with a full
`sha-<commit>` tag and `latest`. Publishing uses `GITHUB_TOKEN` with job-scoped
`packages: write`; Docker Hub credentials are not required. Upstream-only nightly/release workflows are removed from this fork; publishing
is handled by the main workflow.

The package must be public for anonymous cluster pulls. The public cluster
instance uses a pinned image digest; future builds do not silently upgrade it.

## Fork base

This fork tracks `sharevb/it-tools`, branch `chore/all-my-stuffs` (base `fad759e`, release 2026.09.27). The Kubernetes suite, Harbor fixtures, and GHCR publishing workflow are maintained in `arch-err/it-tools`.
