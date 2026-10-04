#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Root-only launcher for an offline, single-workspace chroot. No shell parser,
 * host mounts, backend environment, or inherited descriptors enter the jail. */
static void fail(const char *operation) {
  fprintf(stderr, "Sandbox unavailable (%s): %s\n", operation, strerror(errno));
  exit(126);
}

static void reject(const char *message) {
  fprintf(stderr, "Sandbox unavailable: %s\n", message);
  exit(126);
}

static unsigned int identity(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno || !value[0] || !end || *end || parsed < 200000 || parsed > 2147483646UL)
    reject("workspace identities must be integers from 200000 to 2147483646");
  return (unsigned int) parsed;
}

static void limit(int resource, rlim_t amount) {
  struct rlimit value = { amount, amount };
  if (setrlimit(resource, &value) != 0) fail("resource limits");
}

static void drop_identity(unsigned int uid, unsigned int gid) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no_new_privs");
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) fail("ambient capabilities");
  for (int capability = 0; capability < 64; capability++) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) fail("capability bounding set");
  }
  if (setgroups(0, NULL) != 0 || setresgid(gid, gid, gid) != 0 || setresuid(uid, uid, uid) != 0)
    fail("workspace identity");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, &capabilities) != 0) fail("drop capabilities");
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail("process boundary");
}

#define DENY(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static void restrict_syscalls(void) {
#if defined(__x86_64__)
  const unsigned int architecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const unsigned int architecture = AUDIT_ARCH_AARCH64;
#else
#error Unsupported sandbox architecture
#endif
  const unsigned int namespaces = CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET |
    CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS;
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* Do not permit the x32 syscall ABI to bypass the native syscall numbers. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
#ifdef __NR_clone3
    /* libc falls back to ordinary clone on ENOSYS, preserving normal threads. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, namespaces, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

    /* Only anonymous Unix socket pairs are useful offline. No created socket
     * can reach another workspace, API loopback, metadata, or the Internet. */
    DENY(__NR_socket),
    DENY(__NR_connect),
    DENY(__NR_bind),
    DENY(__NR_listen),
#ifdef __NR_accept
    DENY(__NR_accept),
#endif
    DENY(__NR_accept4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

    /* Block terminal injection while retaining normal PTY/job-control ioctls. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TIOCSTI, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x541c /* TIOCLINUX */, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

    DENY(__NR_ptrace),
    DENY(__NR_process_vm_readv),
    DENY(__NR_process_vm_writev),
    DENY(__NR_shmget),
    DENY(__NR_shmat),
    DENY(__NR_shmdt),
    DENY(__NR_shmctl),
    DENY(__NR_semget),
    DENY(__NR_semop),
    DENY(__NR_semctl),
    DENY(__NR_semtimedop),
    DENY(__NR_msgget),
    DENY(__NR_msgsnd),
    DENY(__NR_msgrcv),
    DENY(__NR_msgctl),
#ifdef __NR_pidfd_getfd
    DENY(__NR_pidfd_getfd),
#endif
#ifdef __NR_process_madvise
    DENY(__NR_process_madvise),
#endif
    DENY(__NR_bpf),
    DENY(__NR_perf_event_open),
    DENY(__NR_userfaultfd),
    DENY(__NR_mount),
    DENY(__NR_umount2),
    DENY(__NR_chroot),
    DENY(__NR_pivot_root),
    DENY(__NR_unshare),
    DENY(__NR_setns),
    DENY(__NR_open_by_handle_at),
    DENY(__NR_name_to_handle_at),
    DENY(__NR_keyctl),
    DENY(__NR_add_key),
    DENY(__NR_request_key),
    DENY(__NR_reboot),
    DENY(__NR_swapon),
    DENY(__NR_swapoff),
    DENY(__NR_syslog),
    DENY(__NR_personality),
    DENY(__NR_init_module),
    DENY(__NR_finit_module),
    DENY(__NR_delete_module),
    DENY(__NR_kexec_load),
    DENY(__NR_fanotify_init),
    DENY(__NR_fanotify_mark),
#ifdef __NR_kexec_file_load
    DENY(__NR_kexec_file_load),
#endif
#ifdef __NR_iopl
    DENY(__NR_iopl),
    DENY(__NR_ioperm),
#endif
#ifdef __NR_io_uring_setup
    DENY(__NR_io_uring_setup),
    DENY(__NR_io_uring_enter),
    DENY(__NR_io_uring_register),
#endif
#ifdef __NR_fsopen
    DENY(__NR_fsopen),
    DENY(__NR_fsconfig),
    DENY(__NR_fsmount),
    DENY(__NR_fspick),
    DENY(__NR_open_tree),
    DENY(__NR_move_mount),
#endif
#ifdef __NR_mount_setattr
    DENY(__NR_mount_setattr),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog policy = {
    .len = (unsigned short) (sizeof(rules) / sizeof(rules[0])), .filter = rules,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &policy) != 0) fail("seccomp");
}

int main(int argc, char **argv) {
  const char *root = NULL, *cwd = "/workspace";
  unsigned int uid = 0, gid = 0;
  int command = 0, kill_workspace = 0;
  pid_t process_group = 0;
  pid_t parent = getppid();
  if (getuid() != 0 || geteuid() != 0) reject("the launcher requires a root broker");
  for (int index = 1; index < argc; index++) {
    if (!strcmp(argv[index], "--kill-workspace")) { kill_workspace = 1; continue; }
    if (!strcmp(argv[index], "--")) { command = index + 1; break; }
    if (index + 1 >= argc) reject("missing launcher option value");
    if (!strcmp(argv[index], "--root")) root = argv[++index];
    else if (!strcmp(argv[index], "--uid")) uid = identity(argv[++index]);
    else if (!strcmp(argv[index], "--gid")) gid = identity(argv[++index]);
    else if (!strcmp(argv[index], "--cwd")) cwd = argv[++index];
    else if (!strcmp(argv[index], "--process-group")) {
      char *end = NULL;
      long parsed = strtol(argv[++index], &end, 10);
      if (!argv[index][0] || !end || *end || parsed < 2 || parsed > 2147483646L)
        reject("invalid process group");
      process_group = (pid_t) parsed;
    }
    else reject("unknown launcher option");
  }
  if (kill_workspace) {
    if (!uid || gid != uid || command || root) reject("expected --kill-workspace --uid UID --gid UID");
    /* This path does not exec or inherit an RLIMIT_NPROC restriction. It still
     * works after a workspace exhausts its process budget. Kernel UID checks
     * apply the kill to this workspace only, including detached descendants. */
    drop_identity(uid, gid);
    if (kill(process_group ? -process_group : -1, SIGKILL) != 0 && errno != ESRCH) fail("workspace cleanup");
    return 0;
  }
  if (process_group) reject("--process-group requires --kill-workspace");
  if (!root || root[0] != '/' || !uid || gid != uid || !command || command >= argc || argv[command][0] != '/' || cwd[0] != '/')
    reject("expected --root PATH --uid UID --gid UID --cwd PATH -- /absolute/command");

  int root_fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) fail("open jail root");
  struct stat metadata;
  if (fstat(root_fd, &metadata) != 0) fail("jail metadata");
  if (metadata.st_uid != 0 || (metadata.st_mode & 0022)) reject("jail root must be root-owned and not writable by other users");
  if (fchdir(root_fd) != 0 || chroot(".") != 0 || chdir(cwd) != 0) fail("filesystem boundary");

  /* No descriptor into the API filesystem or its sockets may survive chroot. */
#ifdef __NR_close_range
  if (syscall(__NR_close_range, 3U, ~0U, 0U) != 0) {
    if (errno != ENOSYS) fail("close inherited descriptors");
    long maximum = sysconf(_SC_OPEN_MAX);
    for (long fd = 3; fd < (maximum > 0 ? maximum : 1048576); fd++) close((int) fd);
  }
#else
  long maximum = sysconf(_SC_OPEN_MAX);
  for (long fd = 3; fd < (maximum > 0 ? maximum : 1048576); fd++) close((int) fd);
#endif

  if (clearenv() != 0) fail("clear environment");
  if (setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) ||
      setenv("HOME", "/workspace", 1) || setenv("PWD", cwd, 1) ||
      setenv("TMPDIR", "/tmp", 1) || setenv("TERM", "xterm-256color", 1) ||
      setenv("LANG", "C.UTF-8", 1) || setenv("SHELL", "/bin/bash", 1) ||
      setenv("PS1", "\\w\\$ ", 1) || setenv("PYTHONUNBUFFERED", "1", 1) ||
      setenv("NODE_OPTIONS", "--max-old-space-size=256 --disable-wasm-trap-handler", 1) ||
      setenv("JAVA_TOOL_OPTIONS", "-Xmx256m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -XX:CompressedClassSpaceSize=64m -XX:ActiveProcessorCount=2", 1))
    fail("safe environment");

  limit(RLIMIT_CORE, 0);
  limit(RLIMIT_NOFILE, 256);
  limit(RLIMIT_NPROC, 128);
  limit(RLIMIT_FSIZE, 64ULL * 1024 * 1024);
  limit(RLIMIT_CPU, 60);
  /* V8 loader workers reserve large, mostly-uncommitted virtual regions. Keep
   * enough address space for TypeScript while the broker monitors actual RSS. */
  limit(RLIMIT_AS, 32ULL * 1024 * 1024 * 1024);
  umask(0022);

  drop_identity(uid, gid);
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0)
    fail("process boundary");
  if (getppid() != parent) reject("broker exited during launch");
  restrict_syscalls();
  execv(argv[command], argv + command);
  fail("start command");
  return 126;
}
