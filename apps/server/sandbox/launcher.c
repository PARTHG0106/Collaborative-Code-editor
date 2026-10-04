#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <grp.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
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
#include <sys/sysmacros.h>
#include <unistd.h>

/* Root-only launcher for an offline, single-workspace Landlock domain. No shell
 * parser, host mounts, backend environment, or inherited descriptors are used. */
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
  if (errno || !value[0] || !end || *end || parsed < 10000 || parsed >= 60000UL)
    reject("workspace identities must be integers from 10000 to 59999");
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

/* These rights were introduced after the minimum build headers in Debian.
 * Only include them in the ruleset when the running kernel supports them. */
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif

static void allow_fd(int ruleset, int fd, uint64_t rights) {
  const struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0)
    fail("Landlock path rule");
}

static void allow_public_path(int ruleset, const char *name, int optional) {
  int fd = open(name, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (optional && errno == ENOENT) return;
    fail("open public toolchain path");
  }
  struct stat metadata;
  if (fstat(fd, &metadata) != 0) fail("public toolchain metadata");
  if (metadata.st_uid != 0 || (metadata.st_mode & 0022) ||
      (!S_ISDIR(metadata.st_mode) && !S_ISREG(metadata.st_mode)))
    reject("public toolchain paths must be root-owned and not writable by other users");
  uint64_t rights = LANDLOCK_ACCESS_FS_READ_FILE;
  if (S_ISDIR(metadata.st_mode)) rights |= LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
  allow_fd(ruleset, fd, rights);
  close(fd);
}

static void allow_configuration_glob(int ruleset, const char *pattern) {
  glob_t paths = {0};
  int result = glob(pattern, GLOB_NOSORT, NULL, &paths);
  if (result != 0 && result != GLOB_NOMATCH) reject("cannot inspect public runtime configuration");
  for (size_t index = 0; index < paths.gl_pathc; index++)
    allow_public_path(ruleset, paths.gl_pathv[index], 0);
  globfree(&paths);
}

static void restrict_filesystem(int workspace_fd, int temporary_fd) {
  int abi = (int) syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) reject("Landlock ABI 3 or newer is required; no unsandboxed fallback is available");
  uint64_t handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
    LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
    LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
    LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
    LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) handled |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  const struct landlock_ruleset_attr policy = { .handled_access_fs = handled };
  int ruleset = (int) syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
  if (ruleset < 0) fail("create Landlock ruleset");
  const uint64_t writable = handled & ~(LANDLOCK_ACCESS_FS_MAKE_CHAR |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_IOCTL_DEV);
  allow_fd(ruleset, workspace_fd, writable);
  allow_fd(ruleset, temporary_fd, writable);

  allow_public_path(ruleset, "/usr", 0);
  static const char *configuration[] = {
    "/etc/alternatives", "/etc/ssl/certs", "/etc/ssl/openssl.cnf", "/etc/ld.so.cache", "/etc/ld.so.conf",
    "/etc/ld.so.conf.d", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
    "/etc/hosts", "/etc/gitconfig", "/etc/ca-certificates.conf", "/etc/debian_version", "/etc/mime.types",
  };
  for (size_t index = 0; index < sizeof(configuration) / sizeof(configuration[0]); index++)
    allow_public_path(ruleset, configuration[index], 1);
  allow_configuration_glob(ruleset, "/etc/java-*");
  allow_configuration_glob(ruleset, "/etc/python*");

  int device_directory = open("/dev", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat device_metadata;
  if (device_directory < 0 || fstat(device_directory, &device_metadata) != 0) fail("open trusted device directory");
  if (device_metadata.st_uid != 0 || (device_metadata.st_mode & 0022))
    reject("device directory must be root-owned and not writable by other users");
  static const struct { const char *name; unsigned int major, minor; } devices[] = {
    {"null", 1, 3}, {"zero", 1, 5}, {"random", 1, 8},
    {"urandom", 1, 9}, {"tty", 5, 0},
  };
  for (size_t index = 0; index < sizeof(devices) / sizeof(devices[0]); index++) {
    int fd = openat(device_directory, devices[index].name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    struct stat metadata;
    if (fd < 0 || fstat(fd, &metadata) != 0) fail("open approved device");
    /* User-namespaced hosts expose bind-mounted host devices as overflow UID
     * 65534. No workspace may receive that identity. The trusted /dev parent,
     * non-following open, exact node numbers and mode prevent substitutions. */
    if (!S_ISCHR(metadata.st_mode) || (metadata.st_uid != 0 && metadata.st_uid != 65534) ||
        (metadata.st_mode & 07777) != 0666 ||
        metadata.st_rdev != makedev(devices[index].major, devices[index].minor))
      reject("approved device paths must be the expected character nodes with trusted ownership and mode 0666");
    uint64_t rights = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE;
    if (abi >= 5) rights |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    allow_fd(ruleset, fd, rights);
    close(fd);
  }
  close(device_directory);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("Landlock no_new_privs");
  if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) fail("enforce Landlock ruleset");
  close(ruleset);
}

static int owned_leaf(int root_fd, const char *name, unsigned int uid, unsigned int gid) {
  int fd = openat(root_fd, name, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat metadata;
  if (fd < 0 || fstat(fd, &metadata) != 0) fail("open workspace writable directory");
  if (metadata.st_uid != uid || metadata.st_gid != gid || (metadata.st_mode & 07777) != 0700)
    reject("writable directories must belong to the workspace UID/GID with mode 0700");
  return fd;
}

static int beneath(const char *name, const char *parent) {
  size_t length = strlen(parent);
  return strncmp(name, parent, length) == 0 && (name[length] == '/' || name[length] == '\0');
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
  const char *root = NULL, *cwd = NULL;
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
  if (!root || root[0] != '/' || !uid || gid != uid || !command || command >= argc || argv[command][0] != '/' || (cwd && cwd[0] != '/'))
    reject("expected --root PATH --uid UID --gid UID --cwd PATH -- /absolute/command");

  int root_fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) fail("open workspace root");
  struct stat metadata;
  if (fstat(root_fd, &metadata) != 0) fail("workspace root metadata");
  if (metadata.st_uid != 0 || (metadata.st_mode & 0022)) reject("workspace root must be root-owned and not writable by other users");
  int workspace_fd = owned_leaf(root_fd, "workspace", uid, gid);
  int temporary_fd = owned_leaf(root_fd, "tmp", uid, gid);
  char canonical_root[PATH_MAX], workspace[PATH_MAX], temporary[PATH_MAX], canonical_cwd[PATH_MAX];
  if (!realpath(root, canonical_root)) fail("resolve workspace root");
  if (snprintf(workspace, sizeof(workspace), "%s/workspace", canonical_root) >= (int) sizeof(workspace) ||
      snprintf(temporary, sizeof(temporary), "%s/tmp", canonical_root) >= (int) sizeof(temporary))
    reject("workspace path is too long");
  if (!realpath(cwd ? cwd : workspace, canonical_cwd)) fail("resolve workspace cwd");
  if (!beneath(canonical_cwd, workspace) && !beneath(canonical_cwd, temporary))
    reject("cwd must remain within this workspace or its temporary directory");
  if (chdir(canonical_cwd) != 0) fail("workspace cwd");
  restrict_filesystem(workspace_fd, temporary_fd);

  /* Already-open descriptors bypass Landlock path checks, so none from the
   * API filesystem or its sockets may survive beyond standard PTY/pipes. */
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
  char java_options[PATH_MAX + 256];
  if (snprintf(java_options, sizeof(java_options), "-Xmx256m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -XX:CompressedClassSpaceSize=64m -XX:ActiveProcessorCount=2 -Djava.io.tmpdir=%s", temporary) >= (int) sizeof(java_options))
    reject("Java temporary path is too long");
  if (setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) ||
      setenv("HOME", workspace, 1) || setenv("PWD", canonical_cwd, 1) ||
      setenv("TMPDIR", temporary, 1) || setenv("TERM", "xterm-256color", 1) ||
      setenv("LANG", "C.UTF-8", 1) || setenv("SHELL", "/bin/bash", 1) ||
      setenv("PS1", "\\w\\$ ", 1) || setenv("PYTHONUNBUFFERED", "1", 1) ||
      setenv("NODE_OPTIONS", "--max-old-space-size=256 --disable-wasm-trap-handler", 1) ||
      setenv("JAVA_TOOL_OPTIONS", java_options, 1))
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
