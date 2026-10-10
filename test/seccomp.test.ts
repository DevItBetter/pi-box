import { DENIED_IOCTLS, DENIED_SYSCALLS, seccompProgram } from "../src/sandbox/seccomp.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

const prog = seccompProgram("x64")!;
const insns = Array.from({ length: prog.length / 8 }, (_, i) => ({
  code: prog.readUInt16LE(i * 8),
  jt: prog.readUInt8(i * 8 + 2),
  jf: prog.readUInt8(i * 8 + 3),
  k: prog.readUInt32LE(i * 8 + 4),
}));

/** Interpret the program for one call. Classic BPF, the five opcodes this file emits. */
function run(nr: number, arch = 0xc000003e, arg0 = 0, arg1 = 0): number {
  const data: Record<number, number> = { 0: nr, 4: arch, 16: arg0, 24: arg1 };
  let acc = 0;
  for (let pc = 0; pc < insns.length; ) {
    const { code, jt, jf, k } = insns[pc]!;
    if (code === 0x06) return k;
    if (code === 0x20) acc = data[k]!;
    const taken = code === 0x15 ? acc === k : code === 0x35 ? acc >= k : code === 0x45 ? (acc & k) !== 0 : null;
    pc += 1 + (taken === null ? 0 : taken ? jt : jf);
  }
  return -1;
}
const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;
const ENOSYS = 0x00050026;

check("shape: whole instructions, and every jump lands inside the program",
  prog.length % 8 === 0 && insns.every((x, i) => i + 1 + Math.max(x.jt, x.jf) < insns.length || x.code === 0x06));
check("ordinary calls are allowed: read, write, openat, execve, mmap, futex",
  [0, 1, 257, 59, 9, 202].every((nr) => run(nr) === ALLOW));
const wrong = Object.entries(DENIED_SYSCALLS).filter(([, nr]) => run(nr) !== EPERM).map(([n]) => n);
check("every denied call gets EPERM", wrong.length === 0, wrong.join(","));
check("clone3 gets ENOSYS, so libc falls back to clone", run(435) === ENOSYS);
check("clone is allowed for threads and forks, refused with CLONE_NEWUSER",
  run(56, undefined, 0x003d0f00) === ALLOW && run(56, undefined, 0x11) === ALLOW && run(56, undefined, 0x10000011) === EPERM);
check("the call after clone in the table is still reachable (the skip lands on the reload)", run(57) === ALLOW && run(101) === EPERM);
const ioctl = (cmd: number): number => run(16, undefined, 3, cmd);
const unrefused = Object.entries(DENIED_IOCTLS).filter(([, cmd]) => ioctl(cmd) !== EPERM).map(([n]) => n);
check("every btrfs subvolume/snapshot-creating ioctl gets EPERM", unrefused.length === 0, unrefused.join(","));
check(
  "other ioctls are allowed: TCGETS, FIONREAD, and btrfs's own clone-range and subvolume lookups",
  [0x5401, 0x541b, 0x4020940d, 0xd0009412].every((cmd) => ioctl(cmd) === ALLOW),
);
check("the call after ioctl is still reachable (the skip lands on the reload)", run(17) === ALLOW && run(101) === EPERM && run(56, undefined, 0x10000011) === EPERM);
check("an x32 call is refused and a foreign architecture is killed", run(0x40000000 + 1) === EPERM && run(1, 0x40000003) === 0x80000000);
check("no program off x86_64", seccompProgram("arm64") === null);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
