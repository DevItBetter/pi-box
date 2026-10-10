// A seccomp filter for bwrap sandboxes: deny the system calls a sandboxed
// process has no business making, allow the rest.
//
// Why a denylist. The guest is a general-purpose toolchain — Go, Python, Node,
// git, a model harness — and an allowlist for that is either enormous or wrong
// the first time a runtime updates. The denylist is the short set of calls that
// reach for the kernel's larger attack surface or for other processes: tracing,
// mounting, kernel modules, keyrings, bpf, perf, io_uring, handle-based opens,
// and creating NEW user namespaces from inside the one bwrap made (the usual
// first move of a namespace-based kernel exploit). This is the partial answer
// to what moving from a VM gives up: the kernel boundary stays gone, the
// kernel's exposed surface gets smaller.
//
// Built here as raw classic BPF rather than through libseccomp, because there is
// no libseccomp binding in this process and the program is twenty lines of
// arithmetic. x86_64 only: on another architecture `seccompProgram` returns
// null and the caller runs without a filter, loudly.
//
// A denied call returns EPERM — not a kill — so a tool that probes for a
// feature degrades instead of dying. `clone3` is the exception: its flags live
// behind a pointer BPF cannot follow, so it returns ENOSYS and libc falls back
// to `clone`, whose flags ARE inspected. That is what container runtimes do.

const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
const CLONE_NEWUSER = 0x10000000;
const EPERM = 1;
const ENOSYS = 38;

const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const retErrno = (errno: number): number => 0x00050000 | errno;

// struct seccomp_data: nr at 0, arch at 4, args[0] at 16, args[1] at 24 (low
// word first on little-endian).
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0 = 16;
const OFF_ARG1 = 24;

const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;

/** x86_64 system call numbers. */
export const DENIED_SYSCALLS: Readonly<Record<string, number>> = {
  ptrace: 101,
  process_vm_readv: 310,
  process_vm_writev: 311,
  kcmp: 312,
  mount: 165,
  umount2: 166,
  pivot_root: 155,
  chroot: 161,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsconfig: 431,
  fsmount: 432,
  fspick: 433,
  mount_setattr: 442,
  unshare: 272,
  setns: 308,
  init_module: 175,
  finit_module: 313,
  delete_module: 176,
  kexec_load: 246,
  kexec_file_load: 320,
  add_key: 248,
  request_key: 249,
  keyctl: 250,
  bpf: 321,
  perf_event_open: 298,
  userfaultfd: 323,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  open_by_handle_at: 304,
  name_to_handle_at: 303,
  swapon: 167,
  swapoff: 168,
  reboot: 169,
  acct: 163,
  quotactl: 179,
  settimeofday: 164,
  clock_settime: 227,
  clock_adjtime: 305,
  adjtimex: 159,
  vhangup: 153,
  lookup_dcookie: 212,
};

const SYS_CLONE = 56;
const SYS_CLONE3 = 435;
const SYS_IOCTL = 16;

/**
 * btrfs ioctls that create a subvolume or snapshot, from <linux/btrfs.h>
 * (`_IOW(0x94, nr, 4096-byte args)`; values checked against the header).
 *
 * Refused because a subvolume gets its OWN qgroup: files written inside one
 * the sandbox made are not charged to the quota'd parent that holds every run
 * (see disk-quota.ts), so creating one would step
 * outside the host's hard disk limit. The launch check refuses a nested
 * subvolume that already exists; this stops one being made afterwards. The
 * kernel reads `cmd` as 32 bits, so comparing the low word is exact.
 */
export const DENIED_IOCTLS: Readonly<Record<string, number>> = {
  BTRFS_IOC_SNAP_CREATE: 0x50009401,
  BTRFS_IOC_SUBVOL_CREATE: 0x5000940e,
  BTRFS_IOC_SNAP_CREATE_V2: 0x50009417,
  BTRFS_IOC_SUBVOL_CREATE_V2: 0x50009418,
};

type Insn = [code: number, jt: number, jf: number, k: number];

/** The filter as `struct sock_filter[]`, little-endian, or null off x86_64. */
export function seccompProgram(arch: string = process.arch): Buffer | null {
  if (arch !== "x64") return null;
  const prog: Insn[] = [
    [LD_W_ABS, 0, 0, OFF_ARCH],
    [JEQ_K, 1, 0, AUDIT_ARCH_X86_64],
    // A foreign-architecture call is an attempt to use a number table this
    // filter does not describe. Nothing legitimate here does that.
    [RET_K, 0, 0, RET_KILL_PROCESS],
    [LD_W_ABS, 0, 0, OFF_NR],
    // The x32 ABI reaches the same kernel code under numbers with this bit set.
    [JGE_K, 0, 1, X32_SYSCALL_BIT],
    [RET_K, 0, 0, retErrno(EPERM)],
    [JEQ_K, 0, 1, SYS_CLONE3],
    [RET_K, 0, 0, retErrno(ENOSYS)],
    // clone(flags, ...): refuse a new user namespace, allow everything else.
    // Not clone → skip the three instructions that inspect its flags and land
    // on the reload of `nr`, which is harmless to repeat.
    [JEQ_K, 0, 3, SYS_CLONE],
    [LD_W_ABS, 0, 0, OFF_ARG0],
    [JSET_K, 0, 1, CLONE_NEWUSER],
    [RET_K, 0, 0, retErrno(EPERM)],
    [LD_W_ABS, 0, 0, OFF_NR],
  ];
  // ioctl(fd, cmd, ...): refuse the commands above. Not ioctl → skip the load
  // of `cmd` and its compare/return pairs, landing on the reload of `nr`.
  const cmds = Object.values(DENIED_IOCTLS);
  prog.push([JEQ_K, 0, 1 + 2 * cmds.length, SYS_IOCTL], [LD_W_ABS, 0, 0, OFF_ARG1]);
  for (const cmd of cmds) prog.push([JEQ_K, 0, 1, cmd], [RET_K, 0, 0, retErrno(EPERM)]);
  prog.push([LD_W_ABS, 0, 0, OFF_NR]);
  for (const nr of Object.values(DENIED_SYSCALLS)) {
    prog.push([JEQ_K, 0, 1, nr], [RET_K, 0, 0, retErrno(EPERM)]);
  }
  prog.push([RET_K, 0, 0, RET_ALLOW]);

  const buf = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8);
    buf.writeUInt8(jt, i * 8 + 2);
    buf.writeUInt8(jf, i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}
