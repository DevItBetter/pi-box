import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sandboxStatus from "../src/sandbox/status-extension.ts";

test("status extension reports launch settings without registering model tools", async () => {
  const previous = process.env["PIBOX_STATUS"];
  process.env["PIBOX_STATUS"] = JSON.stringify({ network: "restricted", workspace: "read-only", provider: "openai", hosts: ["api.openai.com"], localEndpoints: [], capabilities: ["web-access"] });
  try {
    let start: Function | undefined; let command: { handler: Function } | undefined;
    const api = {
      on: (event: string, handler: Function) => { assert.equal(event, "session_start"); start = handler; },
      registerCommand: (name: string, spec: { handler: Function }) => { assert.equal(name, "pibox"); command = spec; },
    } as unknown as ExtensionAPI;
    sandboxStatus(api);
    const messages: string[] = [];
    const ctx = { ui: { setStatus: (_key: string, value: string) => messages.push(value), notify: (value: string) => messages.push(value) } };
    await start!({}, ctx);
    await command!.handler("", ctx);
    assert.match(messages[0]!, /restricted.*read-only.*openai/);
    assert.match(messages[1]!, /Allowed hosts: api.openai.com/);
    assert.match(messages[1]!, /Capabilities: web-access/);
  } finally {
    if (previous === undefined) delete process.env["PIBOX_STATUS"];
    else process.env["PIBOX_STATUS"] = previous;
  }
});
