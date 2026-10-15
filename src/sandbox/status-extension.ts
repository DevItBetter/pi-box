import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SandboxStatus {
  network: string;
  workspace: string;
  provider: string;
  hosts: string[];
  localEndpoints: string[];
  capabilities: string[];
}

export default function sandboxStatus(pi: ExtensionAPI): void {
  const raw = process.env["PIBOX_STATUS"];
  if (!raw) return;
  const status = JSON.parse(raw) as SandboxStatus;
  const summary = `pibox: ${status.network} · ${status.workspace} · ${status.provider}`;
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pibox", summary);
  });
  pi.registerCommand("pibox", {
    description: "Show sandbox network, workspace access, and enabled capabilities",
    handler: async (_args, ctx) => {
      ctx.ui.notify([
        summary,
        "Workspace: /workspace",
        `Allowed hosts: ${status.network === "restricted" ? status.hosts.join(", ") || "none" : "endpoint rules inactive"}`,
        `Local provider endpoints: ${status.localEndpoints.join(", ") || "none"}`,
        `Capabilities: ${status.capabilities.join(", ") || "bare pi"}`,
      ].join("\n"), "info");
    },
  });
}
