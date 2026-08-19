import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic, simple verification auto-detection. No AI, no running a dozen
 * arbitrary commands: it reads the lockfiles to pick the package manager and
 * proposes the relevant scripts. If there is no clear signal the caller falls
 * back to Custom / None.
 */

export interface VerifyCandidate {
  name: string;
  command: string;
  args: string[];
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export async function autoDetectVerification(repoRoot: string): Promise<VerifyCandidate[]> {
  const manager = await detectPackageManager(repoRoot);
  const scripts = await readPackageScripts(repoRoot);
  if (manager === undefined || scripts === undefined) {
    return [];
  }
  const preferred = ["test", "check", "typecheck", "lint"];
  const candidates: VerifyCandidate[] = [];
  for (const name of preferred) {
    const script = scripts[name];
    if (typeof script === "string" && script.trim().length > 0) {
      candidates.push({ name: `${manager} ${name}`, command: manager, args: [name] });
    }
  }
  return candidates;
}

async function detectPackageManager(repoRoot: string): Promise<PackageManager | undefined> {
  const has = async (file: string): Promise<boolean> => {
    try {
      await readFile(path.join(repoRoot, file));
      return true;
    } catch {
      return false;
    }
  };
  if (await has("pnpm-lock.yaml")) return "pnpm";
  if (await has("bun.lockb")) return "bun";
  if (await has("yarn.lock")) return "yarn";
  if (await has("package-lock.json")) return "npm";
  return undefined;
}

async function readPackageScripts(repoRoot: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    if (parsed.scripts !== undefined && typeof parsed.scripts === "object") {
      for (const [name, value] of Object.entries(parsed.scripts)) {
        if (typeof value === "string") {
          scripts[name] = value;
        }
      }
    }
    return scripts;
  } catch {
    return undefined;
  }
}
