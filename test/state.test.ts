import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { instanceHome, reserveInstance, unlockState, writeJsonAtomic } from "../src/state.ts";

test("automatic slots are distinct while reserved and reused after release", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-slots-"));
  try {
    const first = reserveInstance(dir); const second = reserveInstance(dir);
    assert.equal(first, dir);
    assert.equal(second, join(dir, "instances", "auto-2"));
    assert.notEqual(reserveInstance(dir), second);
    unlockState(second);
    assert.equal(reserveInstance(dir), second);
    assert.equal(instanceHome(dir, "review"), join(dir, "instances", "review"));
    for (const name of ["", "..", "a/b", ".hidden"]) assert.throws(() => instanceHome(dir, name));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic JSON writes replace links without following them and clean failed staging", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-atomic-"));
  try {
    const outside = join(dir, "outside.json"); const path = join(dir, "state.json");
    writeFileSync(outside, "unchanged"); symlinkSync(outside, path);
    writeJsonAtomic(path, { endpoints: ["github"], agent: [] });
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { endpoints: ["github"], agent: [] });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const blocked = join(dir, "directory"); mkdirSync(blocked);
    assert.throws(() => writeJsonAtomic(blocked, {}));
    assert.ok(!readdirSync(dir).some((name) => name.startsWith(".pibox-write-")));
    assert.throws(() => writeJsonAtomic(path, { unsupported: 1n }));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).endpoints, ["github"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
