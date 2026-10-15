// Raw-mode checkbox TUI for pibox launch-time selections. No deps.
//
// One screen per selection kind (egress endpoints, agent capabilities): rows
// are a "none" action, then profiles (toggle their whole member set), then
// items. Keys: up/down|j/k move · space toggle · a all · n none · enter
// confirm · q/esc/Ctrl-C abort. Resolves to the selected item keys, or null
// on abort.

import { profileDescription, profileLabel, profileMembers, type SelectionProfiles } from "./config.ts";

export interface PickerItem {
  key: string;
  detail: string;
}

export interface PickerSpec {
  title: string;
  /** Label for the clear-everything row, e.g. "OpenAI only — clear all". */
  noneLabel: string;
  emptyLabel?: string;
  items: PickerItem[];
  /** profile name → member item keys */
  profiles: SelectionProfiles;
}

type Row =
  | { kind: "none" }
  | { kind: "profile"; name: string; label: string; description: string; members: string[] }
  | { kind: "item"; item: PickerItem };

export function pickItems(spec: PickerSpec, preselected: ReadonlySet<string>): Promise<Set<string> | null> {
  const keys = spec.items.map((i) => i.key);
  const selected = new Set([...preselected].filter((k) => keys.includes(k)));

  const rows: Row[] = [
    { kind: "none" },
    ...Object.entries(spec.profiles).map(([name, profile]) => ({
      kind: "profile" as const,
      name,
      label: profileLabel(name, profile),
      description: profileDescription(profile),
      members: profileMembers(profile).filter((k) => keys.includes(k)),
    })),
    ...spec.items.map((item) => ({ kind: "item" as const, item })),
  ];
  const labelWidth = Math.max(
    ...rows.map((r) => (r.kind === "profile" ? r.label.length : r.kind === "item" ? r.item.key.length : 0)),
    8,
  );
  let cursor = 0;
  let firstVisible = 0;

  const box = (on: boolean, partial = false): string => (partial ? "[~]" : on ? "[x]" : "[ ]");
  const lines = (): string[] => {
    const visibleRows = Math.max(1, (process.stderr.rows || 24) - 4);
    firstVisible = Math.min(firstVisible, cursor);
    firstVisible = Math.max(firstVisible, cursor - visibleRows + 1);
    const out = [spec.title, ""];
    for (let i = firstVisible; i < Math.min(rows.length, firstVisible + visibleRows); i++) {
      const row = rows[i]!;
      const cur = i === cursor ? "\x1b[7m" : "";
      const end = i === cursor ? "\x1b[0m" : "";
      if (row.kind === "none") {
        out.push(`  ${cur}( ${spec.emptyLabel ?? "none"} )  ${spec.noneLabel}${end}`);
      } else if (row.kind === "profile") {
        const on = row.members.length > 0 && row.members.every((k) => selected.has(k));
        const partial = !on && row.members.some((k) => selected.has(k));
        const detail = row.description || `profile: ${row.members.join(", ")}`;
        const key = row.label === row.name ? "" : ` [${row.name}]`;
        out.push(`  ${cur}${box(on, partial)} ${row.label.padEnd(labelWidth)}${key}  ${detail}${end}`);
      } else {
        out.push(`  ${cur}${box(selected.has(row.item.key))} ${row.item.key.padEnd(labelWidth)}  ${row.item.detail}${end}`);
      }
    }
    out.push("", "  space toggle · enter confirm · n none · a all · q abort");
    return out;
  };

  const paint = (): void => {
    const out = lines();
    process.stderr.write(`\x1b[H\x1b[J${out.join("\r\n")}`);
  };

  const toggle = (): void => {
    const row = rows[cursor]!;
    if (row.kind === "none") {
      selected.clear();
    } else if (row.kind === "profile") {
      const allOn = row.members.length > 0 && row.members.every((k) => selected.has(k));
      for (const k of row.members) allOn ? selected.delete(k) : selected.add(k);
    } else {
      selected.has(row.item.key) ? selected.delete(row.item.key) : selected.add(row.item.key);
    }
  };

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    // Use a separate screen and clip long rows instead of wrapping them.
    process.stderr.write("\x1b[?1049h\x1b[?7l\x1b[?25l");
    process.stderr.on("resize", paint);
    const done = (result: Set<string> | null): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onKey);
      process.stderr.off("resize", paint);
      process.stderr.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
      resolve(result);
    };
    const onKey = (chunk: Buffer): void => {
      const key = chunk.toString("utf8");
      if (key === "\x03" || key === "q" || key === "\x1b") return done(null);
      if (key === "\r" || key === "\n") return done(selected);
      if (key === "\x1b[A" || key === "k") cursor = (cursor + rows.length - 1) % rows.length;
      else if (key === "\x1b[B" || key === "j") cursor = (cursor + 1) % rows.length;
      else if (key === " ") toggle();
      else if (key === "n") selected.clear();
      else if (key === "a") for (const k of keys) selected.add(k);
      else return;
      paint();
    };
    paint();
    stdin.on("data", onKey);
  });
}
