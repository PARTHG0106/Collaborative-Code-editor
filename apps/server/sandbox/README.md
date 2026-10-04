# Existing-Space workspace sandbox

The API remains in the existing Hugging Face Docker Space. Each workspace uses
a persistent Unix UID (10000–59999) and a kernel Landlock filesystem policy.
The shared `/usr` toolchain is root-owned and immutable. The process can write
only beneath its own `workspace` and `tmp` directories under
`/var/lib/syncscript/workspaces/WORKSPACE_HASH`. `HOME` and a bare `cd` refer to
the actual workspace directory; `TMPDIR` refers to its private temporary area.

The root-only native launcher requires Landlock ABI 3 or newer, including
cross-directory and truncation restrictions. Rules permit reading/executing
`/usr`, selected public runtime configuration under `/etc`, and the existing
real `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, and `/dev/tty` nodes.
Their parent must be root-owned and not writable by other users. Nodes must
match the exact character-device numbers and mode 0666; owner 0 or the host's
overflow UID 65534 is accepted, while workspace UIDs never include 65534.
Backend files, other workspaces, `/proc` contents, and unauthorized directory
listings are denied. Landlock does not hide path metadata: `stat` or `chdir` may
observe existing paths, while opening their contents or listing them fails.

The launcher installs the policy, closes inherited descriptors beyond stdio,
clears the backend environment, and drops supplementary groups, UID/GID
privileges, capabilities and the capability bounding set. It enables
`no_new_privs` and a syscall filter, then runs the requested executable directly.
User namespaces, mount APIs, process inspection, privileged kernel APIs,
shared System V IPC and network sockets are denied. Anonymous Unix socket pairs
remain available for ordinary parent/child IPC. There is no command parser.

There is no chroot, device creation, archive of device nodes, or host mount.
Landlock initialization failures stop the command; no weaker fallback is used.

This is an **offline terminal**. Bash, pipes, redirection, Git, Python/venv,
Node/npm/TypeScript, C/C++, and Java run using the installed toolchain. Downloads,
remote Git operations, network servers, API loopback, metadata and Internet
connections cannot work because the kernel denies their networking syscalls.
Namespaces and device creation are unavailable on the current Space.

The launcher applies process, descriptor, CPU, address-space and file-size limits.
The API also monitors total workspace RSS and disk usage and uses UID-based
cleanup for detached processes. These aggregate limits are polling-based
availability controls, not cgroup quotas or VM isolation: an abusive workspace
can consume shared host resources between checks. A dedicated container host
with resource quotas is required for a stronger availability boundary.

All filesystem writes and inspections involving workspace-controlled paths must
run through the launcher as that workspace UID. Root API code must not follow
paths or symlinks from writable workspace directories. Runtime cleanup drops to the workspace
UID before signaling, including process-group cleanup, so PID reuse cannot
cause it to kill the API or a different workspace.

```sh
syncscript-sandbox --root /var/lib/syncscript/workspaces/WORKSPACE_HASH \
  --uid 10001 --gid 10001 \
  --cwd /var/lib/syncscript/workspaces/WORKSPACE_HASH/workspace \
  -- /bin/bash --noprofile --norc -i
syncscript-sandbox --kill-workspace --uid 10001 --gid 10001
syncscript-sandbox --kill-workspace --uid 10001 --gid 10001 --process-group 12345
```

Run the real Linux boundary tests on a root-capable Linux host with Landlock
ABI 3 or newer. They run with both device-creation and chroot capabilities removed:

```sh
docker build --target sandbox-toolchain -t syncscript-sandbox-test .
docker run --rm --cap-drop=MKNOD --cap-drop=SYS_CHROOT \
  -v "$PWD/apps/server/sandbox:/tests:ro" \
  syncscript-sandbox-test python3 /tests/smoke.py \
  --launcher /usr/local/bin/syncscript-sandbox
```

The suite validates two different workspace UIDs, host path and inherited-FD
isolation, outside writes/truncation, real safe devices, unavailable-Landlock
failure, syscall/network denial, symlink/hard-link attacks, all six language
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
