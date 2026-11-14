export type OutputFormat = "human" | "json";

export function parseFormat(argv: string[]): OutputFormat {
  if (argv.includes("--json")) return "json";
  const idx = argv.indexOf("--format");
  if (idx >= 0) {
    const v = argv[idx + 1];
    if (v === "json" || v === "human") return v;
  }
  return "human";
}

export function emit(format: OutputFormat, human: string, data: unknown): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(human + (human.endsWith("\n") ? "" : "\n"));
  }
}

export function stripFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") continue;
    if (a === "--format") {
      i++;
      continue;
    }
    if (a.startsWith("--format=")) continue;
    out.push(a);
  }
  return out;
}

export function getFlag(argv: string[], name: string): string | undefined {
  const long = `--${name}`;
  const idx = argv.indexOf(long);
  if (idx >= 0) return argv[idx + 1];
  const prefix = `${long}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  return undefined;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
