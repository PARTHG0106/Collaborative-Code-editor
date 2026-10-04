# Existing-Space workspace sandbox

The API remains in the existing Hugging Face Docker Space. Each workspace uses
a separate chroot filesystem and persistent Unix UID (at least 200000), with a
root-owned immutable toolchain and writable `/workspace` and `/tmp` directories.
No `/app`, `/proc`, `/sys`, home directories, backend environment or inherited
file descriptors are included. A bare `cd` returns to `/workspace`.

The root-only native launcher enters the jail before dropping all supplementary
groups, UID/GID privileges, capabilities and the capability bounding set. It
enables `no_new_privs` and a syscall filter, then runs the requested executable
directly. User namespace creation, mount APIs, process inspection, privileged
kernel APIs, shared System V IPC and network sockets are denied. Anonymous Unix
socket pairs remain available for ordinary parent/child IPC. There is no command
allowlist or command-string parser.

This is an **offline terminal**. Bash, pipes, redirection, Git, Python/venv,
Node/npm/TypeScript, C/C++, and Java run using the installed toolchain. Downloads,
remote Git operations, network servers, API loopback, metadata and Internet
connections cannot work because the kernel denies their networking syscalls.
Namespaces are unavailable on the current Space; no unsafe fallback is used.

The launcher applies process, descriptor, CPU, address-space and file-size limits.
The API also monitors total workspace RSS and disk usage and uses UID-based
cleanup for detached processes. These aggregate limits are polling-based
availability controls, not cgroup quotas or VM isolation: an abusive workspace
can consume shared host resources between checks. A dedicated container host
with resource quotas is required for a stronger availability boundary.

All filesystem writes and inspections involving workspace-controlled paths must
run through the launcher as that workspace UID. Root API code must not follow
paths or symlinks from the writable jail. Runtime cleanup drops to the workspace
UID before signaling, including process-group cleanup, so PID reuse cannot
cause it to kill the API or a different workspace.

```sh
syncscript-sandbox --root /var/lib/syncscript/workspaces/WORKSPACE_HASH \
  --uid 200001 --gid 200001 --cwd /workspace -- /bin/bash --noprofile --norc -i
syncscript-sandbox --kill-workspace --uid 200001 --gid 200001
syncscript-sandbox --kill-workspace --uid 200001 --gid 200001 --process-group 12345
```

Run the real Linux boundary tests using Docker on a root-capable Linux host:

```sh
docker build --target sandbox-toolchain -t syncscript-sandbox-test .
docker run --rm -v "$PWD/apps/server/sandbox:/tests:ro" \
  syncscript-sandbox-test python3 /tests/smoke.py \
  --launcher /syncscript-sandbox --rootfs /rootfs
```

The suite validates two different workspace UIDs, host path and inherited-FD
isolation, syscall/network denial, symlink/hard-link attacks, all six language
toolchains, Python venv, Git, an actual PTY and detached-process cleanup. It does
not need backend secrets, a database, a network target or a real workspace.

After building the complete API image, also exercise the JavaScript adapter in
a disposable container, without starting the API or connecting a database:

```sh
docker build -t syncscript-api-test .
docker run --rm -v "$PWD/apps/server/sandbox:/tests:ro" \
  syncscript-api-test node /tests/adapter-smoke.cjs \
  /app/apps/server/dist/execution/localWorkspaceRuntime.js
```

This checks the actual PTY and all six language runners through the adapter,
relative imports without overwriting source files, conflict recovery copies,
late writes from a process holding an old file descriptor, separate persistent
UIDs, UID cleanup, and DB-content reconciliation when a workspace is reopened.
The harness creates only synthetic workspace fixtures inside that disposable
container. Do not run it against an active production container.

The full-stack gate also starts PostgreSQL 16, runs the production startup
migration script against its empty database, seeds two synthetic verified users,
and checks HTTP authentication/workspaces plus real Socket.IO terminals and
Python execution with stdin:

```sh
sh apps/server/sandbox/api-smoke.sh syncscript-api-check:latest
```

It checks cross-workspace denials, execution output separation, recovery copies
for terminal edits, and fresh file content after reconnecting. The script uses
dummy credentials on an internal Docker network and removes only its own
containers/network on exit. It does not need production secrets or expose ports.
