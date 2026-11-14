import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDbPath } from "@agent-replay-lab/core";

export interface ProjectConfig {
  projectId: string;
  name: string;
  createdAt: string;
  dbPath: string;
}

export const CONFIG_DIR = ".agent-replay";
export const CONFIG_FILE = "config.json";

export function resolveProjectRoot(cwd: string = process.cwd()): string {
  return cwd;
}

export function configPath(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function loadConfig(cwd: string = process.cwd()): ProjectConfig | undefined {
  const path = configPath(cwd);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
}

export function saveConfig(cfg: ProjectConfig, cwd: string = process.cwd()): void {
  const dir = join(cwd, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(cwd), JSON.stringify(cfg, null, 2), "utf8");
}

export function requireConfig(cwd: string = process.cwd()): ProjectConfig {
  const cfg = loadConfig(cwd);
  if (!cfg) {
    throw new Error("No Agent Replay Lab project found. Run: agent-replay init");
  }
  return cfg;
}

export function resolveDbPath(cfg: ProjectConfig, cwd: string = process.cwd()): string {
  if (cfg.dbPath.startsWith("/")) return cfg.dbPath;
  return join(cwd, cfg.dbPath);
}

export function defaultConfig(name: string, cwd: string = process.cwd()): ProjectConfig {
  return {
    projectId: name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase() || "default",
    name,
    createdAt: new Date().toISOString(),
    dbPath: join(CONFIG_DIR, "store.sqlite"),
  };
}

export { defaultDbPath };
