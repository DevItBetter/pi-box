import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectSession } from "../src/session.ts";

test("inspection distinguishes no lock from unknown metadata without modifying the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-inspect-"));
  try {
    assert.equal(inspectSession(dir).state, "idle");
    const lock = join(dir, "active.lock"); mkdirSync(lock);
    assert.equal(inspectSession(dir).state, "unknown");
    writeFileSync(join(lock, "session.json"), JSON.stringify({ version: 1, pid: 123, scope: "unrelated.service" }));
    assert.equal(inspectSession(dir).state, "unknown");
    writeFileSync(join(lock, "session.json"), "{");
    assert.equal(inspectSession(dir).locked, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
