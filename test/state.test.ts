import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../src/state.ts";

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
