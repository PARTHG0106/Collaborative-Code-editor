#!/usr/bin/env python3
"""Linux integration checks for the real Landlock launcher and shared tools.

Run as root with --launcher PATH in a disposable toolchain/API container.
Tests use synthetic workspace directories and never modify the shared tools.
No database, network service, backend credential, or real workspace is needed.
"""
import argparse
import ctypes
import errno
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import stat
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--launcher", required=True)
    arguments = parser.parse_args()
    if os.getuid() != 0:
        raise RuntimeError("Sandbox smoke tests require root")
    launcher = str(pathlib.Path(arguments.launcher).resolve())
    directory = pathlib.Path(tempfile.mkdtemp(prefix="syncscript-sandbox-smoke-"))
    directory.chmod(0o711)
    base_uid = 10000 + (os.getpid() % 10000) * 2
    users = [base_uid, base_uid + 1]
    cleanup_users = set()
    jails = []
    children = []
    env = {**os.environ, "SANDBOX_SECRET_CANARY": "outside-only-sentinel"}
    passed = 0

    def command(index, *args):
        return [launcher, "--root", str(jails[index]), "--uid", str(users[index]),
                "--gid", str(users[index]), "--cwd", str(jails[index] / "workspace"), "--", *args]

    def run(*args, index=0, expected=0, **kwargs):
        cleanup_users.add(users[index])
        result = subprocess.run(command(index, *args), capture_output=True, text=True,
                                timeout=30, env=env, **kwargs)
        if result.returncode != expected:
            raise AssertionError(f"{args[0]} exited {result.returncode}; stdout={result.stdout!r}, stderr={result.stderr!r}")
        return result

    def check(name, callback):
        nonlocal passed
        callback()
        passed += 1
        print("PASS", name, flush=True)

    def write(files, index=0):
        return run("/usr/bin/python3", "-I", "/usr/local/lib/syncscript/safe-files.py", str(jails[index] / "workspace"),
                   index=index, input=json.dumps({"files": files}))

    def file(name, content):
        return {"path": name, "type": "FILE", "content": content}

    try:
        def toolchain_invariants():
            expected_devices = {"null": (1, 3), "zero": (1, 5), "random": (1, 8), "urandom": (1, 9), "tty": (5, 0)}
            for name, numbers in expected_devices.items():
                metadata = pathlib.Path("/dev", name).lstat()
                assert stat.S_ISCHR(metadata.st_mode)
                assert (os.major(metadata.st_rdev), os.minor(metadata.st_rdev)) == numbers
            for current, directories, files in os.walk("/usr"):
                for name in directories + files:
                    metadata = os.lstat(pathlib.Path(current) / name)
                    if not stat.S_ISLNK(metadata.st_mode):
                        assert metadata.st_uid == 0, str(pathlib.Path(current) / name)
                        assert not (metadata.st_mode & 0o6022), str(pathlib.Path(current) / name)
        check("shared toolchain is root-owned and immutable; host devices are real character nodes", toolchain_invariants)

        # Refuse to signal an identity already used by a pre-existing process.
        for status in pathlib.Path("/proc").glob("[0-9]*/status"):
            try:
                for row in status.read_text().splitlines():
                    if row.startswith("Uid:") and int(row.split()[1]) in users:
                        raise RuntimeError("Test UID is already in use")
            except (FileNotFoundError, ProcessLookupError):
                pass
        for index, uid in enumerate(users):
            jail = directory / f"jail-{index}"
            jail.mkdir(mode=0o711)
            for writable in ("workspace", "tmp"):
                (jail / writable).mkdir(mode=0o700)
                os.chown(jail / writable, uid, uid)
                os.chmod(jail / writable, 0o700)
            jails.append(jail)

        outside = directory / "backend-secret"
        outside.write_text("outside-only-sentinel")
        # The UID could read/write this world-accessible fixture without
        # Landlock. Denials therefore exercise the kernel path policy itself.
        outside.chmod(0o666)
        pathlib.Path("/app").mkdir(exist_ok=True)
        check("home directory and real shell pipes/redirection", lambda: run(
            "/bin/bash", "--noprofile", "--norc", "-c",
            'cd "$TMPDIR"; cd; test "$PWD" = "$HOME"; printf shell-ok | cat > shell.txt; test "$(cat shell.txt)" = shell-ok'))

        fd = os.open(outside, os.O_RDONLY)
        try:
            probe = f'''
import errno, os, resource
assert os.getuid() == {users[0]} and os.getgid() == {users[0]}
assert os.getgroups() == []
assert "SANDBOX_SECRET_CANARY" not in os.environ
assert os.environ["HOME"] == {str(jails[0] / 'workspace')!r}
assert os.environ["TMPDIR"] == {str(jails[0] / 'tmp')!r}
for name in [{str(outside)!r}, "/proc/1/environ", "/proc/self/environ"]:
 try:
  open(name).read()
  raise AssertionError("host path readable: " + name)
 except PermissionError:
  pass
for name in ["/app", "/proc", "/sys", "/", {str(directory)!r}]:
 try:
  os.listdir(name)
  raise AssertionError("host directory listable: " + name)
 except PermissionError:
  pass
try:
 os.fstat({fd})
 raise AssertionError("inherited descriptor survived")
except OSError as error:
 assert error.errno == errno.EBADF
assert resource.getrlimit(resource.RLIMIT_NPROC) == (128, 128)
assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
print("boundary-ok")
'''
            check("UID, clean environment, closed descriptors and denied backend/proc/root reads", lambda: run(
                "/usr/bin/python3", "-c", probe, pass_fds=(fd,)))
        finally:
            os.close(fd)

        network = '''
import ctypes, errno, socket
for family in [socket.AF_INET, socket.AF_INET6, socket.AF_UNIX, socket.AF_NETLINK, socket.AF_PACKET]:
 try:
  socket.socket(family, socket.SOCK_STREAM)
  raise AssertionError("socket family allowed: " + str(family))
 except OSError as error:
  assert error.errno == errno.EPERM
left, right = socket.socketpair()
left.send(b"ipc")
assert right.recv(3) == b"ipc"
try:
 left.connect("\\0outside-abstract-socket")
 raise AssertionError("connect allowed")
except OSError as error:
 assert error.errno == errno.EPERM
try:
 socket.socketpair(socket.AF_INET)
 raise AssertionError("non-Unix socketpair allowed")
except OSError as error:
 assert error.errno == errno.EPERM
libc = ctypes.CDLL(None, use_errno=True)
assert libc.shmget(0, 4096, 0o1000 | 0o666) == -1 and ctypes.get_errno() == errno.EPERM
assert libc.ptrace(0, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
assert libc.unshare(0x10000000) == -1 and ctypes.get_errno() == errno.EPERM
assert libc.chroot(b"/") == -1 and ctypes.get_errno() == errno.EPERM
assert libc.prctl(39, 0, 0, 0, 0) == 1
assert libc.prctl(21, 0, 0, 0, 0) == 2
for capability in range(41):
 assert libc.prctl(23, capability, 0, 0, 0) == 0
print("offline-and-seccomp-ok")
'''
        check("IPv4/IPv6/Unix/network sockets, shared IPC and escape syscalls denied", lambda: run("/usr/bin/python3", "-c", network))

        def filesystem_policy():
            run("/usr/bin/python3", "-c", f'''
import os
with open('/dev/null','wb') as target: target.write(b'discarded')
with open('/dev/zero','rb') as source: assert source.read(32) == bytes(32)
with open('/dev/urandom','rb') as source: assert len(source.read(16)) == 16
for operation in [lambda: open({str(outside)!r},'w'), lambda: os.truncate({str(outside)!r},0),
                  lambda: open('/dev/full','wb'), lambda: os.listdir('/dev')]:
 try:
  operation()
  raise AssertionError('unauthorized file/device access succeeded')
 except PermissionError:
  pass
os.symlink({str(outside)!r}, 'escape-link')
try:
 open('escape-link').read()
 raise AssertionError('symlink escaped Landlock')
except PermissionError:
 pass
''')
            assert outside.read_text() == "outside-only-sentinel"
            invalid = command(0, "/usr/bin/true")
            invalid[invalid.index("--cwd") + 1] = str(jails[1] / "workspace")
            result = subprocess.run(invalid, capture_output=True, text=True)
            assert result.returncode == 126 and "cwd must remain" in result.stderr, result
        check("real safe devices work; outside writes/truncation, symlink escapes and foreign cwd are denied", filesystem_policy)

        def unavailable_landlock():
            def block_landlock():
                class Filter(ctypes.Structure):
                    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
                class Program(ctypes.Structure):
                    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]
                # landlock_create_ruleset is syscall 444 on both supported
                # architectures. Tighten only this child's inherited filter.
                rules = (Filter * 4)(Filter(0x20, 0, 0, 0), Filter(0x15, 0, 1, 444),
                                     Filter(0x06, 0, 0, 0x00050000 | errno.ENOSYS),
                                     Filter(0x06, 0, 0, 0x7FFF0000))
                policy = Program(len(rules), rules)
                libc = ctypes.CDLL(None, use_errno=True)
                if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(policy), 0, 0):
                    os._exit(127)
            result = subprocess.run(command(0, "/usr/bin/true"), capture_output=True,
                                    text=True, preexec_fn=block_landlock)
            assert result.returncode == 126 and "Landlock ABI 3 or newer is required" in result.stderr, result
        check("unavailable Landlock fails closed before executing a command", unavailable_landlock)

        def mapped_identity_range():
            for uid in (9999, 60000, 65534, 200000):
                invalid = command(0, "/usr/bin/true")
                invalid[invalid.index("--uid") + 1] = str(uid)
                invalid[invalid.index("--gid") + 1] = str(uid)
                result = subprocess.run(invalid, capture_output=True, text=True)
                assert result.returncode == 126 and "10000 to 59999" in result.stderr, result
        check("out-of-range and overflow workspace identities are rejected", mapped_identity_range)

        def verify_writes():
            write([file("safe.py", "print('saved')"), {"path": "folder", "type": "FOLDER"}])
            run("/bin/bash", "-c", "ln -s /app linked-parent; ln -s /app/backend-secret linked-file; ln safe.py hard-link")
            for name in ["../backend-secret", "linked-parent/backend-secret", "linked-file", "hard-link"]:
                result = run("/usr/bin/python3", "-I", "/usr/local/lib/syncscript/safe-files.py", str(jails[0] / "workspace"),
                             expected=1, input=json.dumps({"files": [file(name, "overwritten")]}))
                assert json.loads(result.stdout)["ok"] is False
            assert outside.read_text() == "outside-only-sentinel"
            assert (jails[0] / "workspace/safe.py").read_text() == "print('saved')"
        check("file helper rejects traversal, symlinks and hard links", verify_writes)

        def cross_workspace():
            write([file("private.txt", "second-workspace")], index=1)
            peer = subprocess.Popen(command(1, "/usr/bin/sleep", "30"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(peer)
            time.sleep(0.1)
            assert peer.poll() is None
            run("/usr/bin/python3", "-c", f'''
import os, signal
try:
 os.kill({peer.pid}, signal.SIGTERM)
 raise AssertionError("other workspace process was signaled")
except PermissionError:
 pass
try:
 open({str(jails[1] / 'workspace/private.txt')!r}).read()
 raise AssertionError("other workspace file was readable")
except PermissionError:
 pass
''')
            assert peer.poll() is None
        check("another workspace's files and processes remain inaccessible", cross_workspace)

        programs = [
            ("python", "main.py", "print('python-ok')", ["/usr/bin/python3", "main.py"], "python-ok"),
            ("javascript", "main.js", "console.log('javascript-ok')", ["/usr/local/bin/node", "main.js"], "javascript-ok"),
            ("typescript", "main.ts", "const x: string = 'typescript-ok'; console.log(x)", ["/usr/local/bin/tsx", "main.ts"], "typescript-ok"),
            ("C", "main.c", '#include <stdio.h>\nint main(void){puts("c-ok");return 0;}', ["/bin/bash", "-c", 'gcc main.c -o "$TMPDIR/c-test" && "$TMPDIR/c-test"'], "c-ok"),
            ("C++", "main.cpp", '#include <iostream>\nint main(){std::cout<<"cpp-ok"<<std::endl;}', ["/bin/bash", "-c", 'g++ main.cpp -o "$TMPDIR/cpp-test" && "$TMPDIR/cpp-test"'], "cpp-ok"),
            ("Java", "Main.java", 'public class Main {public static void main(String[] a){System.out.println("java-ok");}}', ["/bin/bash", "-c", 'javac -d "$TMPDIR" Main.java && java -cp "$TMPDIR" Main'], "java-ok"),
        ]
        for language, filename, content, invocation, marker in programs:
            def language_check(filename=filename, content=content, invocation=invocation, marker=marker):
                write([file(filename, content)])
                assert marker in run(*invocation).stdout
            check(language + " toolchain works inside the real boundary", language_check)

        check("Python virtual environments work without downloads", lambda: run(
            "/bin/bash", "-c", "python3 -m venv .venv && .venv/bin/python -c 'print(1)'"))
        check("Git works with workspace-local repositories", lambda: run(
            "/bin/bash", "-c", "git init -q repository && git -C repository status --porcelain"))

        def terminal():
            pid, master = pty.fork()
            if pid == 0:
                os.execve(launcher, command(0, "/bin/bash", "--noprofile", "--norc", "-i"), env)
            output = b""
            try:
                os.write(master, b'cd "$TMPDIR"; cd; printf PTY-OK | cat > pty.txt; cat pty.txt; printf TTY-OK > /dev/tty; exit\n')
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.2)[0]:
                        try:
                            chunk = os.read(master, 4096)
                        except OSError as error:
                            if error.errno == errno.EIO:
                                break
                            raise
                        if not chunk:
                            break
                        output += chunk
                waited, status = os.waitpid(pid, os.WNOHANG)
                if not waited:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                    raise AssertionError("interactive terminal did not exit")
                assert os.waitstatus_to_exitcode(status) == 0, output
                assert (jails[0] / "workspace/pty.txt").read_text() == "PTY-OK", output
                assert b"TTY-OK" in output, output
            finally:
                os.close(master)
        check("actual PTY keeps cd, pipes, redirection and exit working", terminal)

        def cleanup_detached():
            run("/usr/bin/python3", "-c", '''
import os, time
child = os.fork()
if child == 0:
 os.setsid()
 os.close(0); os.close(1); os.close(2)
 time.sleep(60)
 os._exit(0)
open("detached.pid", "w").write(str(child))
''')
            pid = int((jails[0] / "workspace/detached.pid").read_text())
            subprocess.run([launcher, "--kill-workspace", "--uid", str(users[0]), "--gid", str(users[0])], check=True)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    state = pathlib.Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()[0]
                    if state == "Z":
                        return
                except FileNotFoundError:
                    return
                time.sleep(0.05)
            raise AssertionError("detached process survived UID cleanup")
        check("UID cleanup kills detached descendants without another workspace", cleanup_detached)
        assert children[0].poll() is None
        print(f"Sandbox smoke checks: {passed} passed", flush=True)
    finally:
        for uid in cleanup_users:
            subprocess.run([launcher, "--kill-workspace", "--uid", str(uid), "--gid", str(uid)], capture_output=True)
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
