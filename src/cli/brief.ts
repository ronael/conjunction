import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

import type { TaskSource } from "../core/index.js";

/**
 * A brief is the run's source of truth: the user's request, kept VERBATIM.
 *
 * It is deliberately not a core entity — it has no identity, no lifecycle and
 * no state; it is the input from which a Task is normalized. Loading it is
 * input resolution, which is the composition root's job (same as `--verify`
 * strings becoming VerificationCommands).
 *
 * The content is NEVER parsed. See docs/brief-workflow-design.md §4.1 for why
 * heading extraction (`## Constraints`, …) was rejected.
 */
export interface Brief {
  readonly source: TaskSource;
  /** The full, unmodified brief text (BOM stripped, nothing else touched). */
  readonly content: string;
  /** Display label only — never read for semantics. */
  readonly title: string;
}

/** Guard rail, not a budget: ~60k tokens of prose, far beyond any sane brief. */
export const BRIEF_MAX_BYTES = 256 * 1024;

export const BRIEF_TITLE_MAX_CHARS = 80;

/** Lines scanned for a leading `# Heading` when deriving the display title. */
const TITLE_SCAN_LINES = 20;

/** Extensions that make a lone positional argument read as a brief path. */
const BRIEF_EXTENSIONS = [".md", ".markdown", ".txt"];

/** A brief could not be resolved or read. Maps to exit code 2 (setup error). */
export class BriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefError";
  }
}

function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > BRIEF_TITLE_MAX_CHARS
    ? `${collapsed.slice(0, BRIEF_TITLE_MAX_CHARS - 1)}…`
    : collapsed;
}

/**
 * Display label for a file brief: the first ATX `# Heading` near the top,
 * else the file's basename.
 *
 * This is ONE REGEX FOR A LABEL, not a markdown parser: no prompt, branch or
 * verification decision reads the title, and this must not grow into extraction.
 */
export function deriveTitle(content: string, filePath: string): string {
  for (const line of content.split("\n", TITLE_SCAN_LINES)) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined && heading[1].trim().length > 0) {
      return truncateTitle(heading[1]);
    }
  }
  return truncateTitle(path.basename(filePath));
}

/** Expands a leading `~` so `~/briefs/x.md` works when the shell did not. */
function expandHome(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  return filePath.startsWith("~/") ? path.join(homedir(), filePath.slice(2)) : filePath;
}

/**
 * Reads a brief from disk. Filesystem only — no network, ever: a remote brief
 * would make a run depend on a mutable source and break reproducibility.
 *
 * Relative paths resolve against `cwd` (the process working directory), NOT
 * against `--repo`: the user types the path where they are standing.
 */
export async function loadBrief(filePath: string, cwd: string): Promise<Brief> {
  const resolved = path.resolve(cwd, expandHome(filePath));

  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new BriefError(`brief file not found: ${filePath}`);
  }
  if (stats.isDirectory()) {
    throw new BriefError(`brief path is a directory, expected a file: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new BriefError(`brief path is not a regular file: ${filePath}`);
  }
  if (stats.size > BRIEF_MAX_BYTES) {
    const kib = Math.ceil(stats.size / 1024);
    throw new BriefError(
      `brief file is too large (${kib} KiB > ${BRIEF_MAX_BYTES / 1024} KiB): ${filePath}`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    throw new BriefError(`could not read brief file ${filePath}: ${(error as Error).message}`);
  }

  // Strip a UTF-8 BOM; leave every other byte of the brief untouched.
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (content.includes("\u0000")) {
    throw new BriefError(`brief file does not look like UTF-8 text: ${filePath}`);
  }
  if (content.trim().length === 0) {
    throw new BriefError(`brief file is empty: ${filePath}`);
  }

  return {
    source: { kind: "file", path: resolved },
    content,
    title: deriveTitle(content, resolved),
  };
}

/** A description typed directly on the command line (the historic form). */
export function inlineBrief(description: string): Brief {
  return {
    source: { kind: "inline" },
    content: description,
    title: truncateTitle(description),
  };
}

/**
 * Whether a lone positional argument should be read as a brief path.
 *
 * Deliberately syntactic — stat()ing every positional was rejected because the
 * task description "README.md" would become a brief by accident. If this
 * returns true the file MUST exist: there is no fallback to "treat it as a
 * description", because a typo'd path would otherwise burn a real agent call
 * on a garbage objective.
 */
export function looksLikeBriefPath(value: string): boolean {
  if (/^(\.\.?\/|\/|~\/)/.test(value)) {
    return true;
  }
  // A bare extension is only a path signal when the value contains no
  // whitespace: "create hello.txt" is a task description, "brief.md" is a file.
  // An extension-less path with spaces must use ./ or --brief.
  if (/\s/.test(value)) {
    return false;
  }
  const lower = value.toLowerCase();
  return BRIEF_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface BriefArgs {
  /** Value of `--brief`, when given. */
  briefOption?: string;
  positionals: readonly string[];
}

/**
 * Resolves CLI arguments into the run's brief.
 *
 * - `--brief <path>` — always a file, never guessed;
 * - a single path-like positional — a file (see looksLikeBriefPath);
 * - anything else — the positionals joined as an inline description.
 */
export async function resolveBrief(args: BriefArgs, cwd: string): Promise<Brief> {
  const { briefOption, positionals } = args;
  if (briefOption !== undefined) {
    if (positionals.length > 0) {
      throw new BriefError(
        "pass either --brief <file> or a task description, not both " +
          `(got --brief ${briefOption} and "${positionals.join(" ")}")`,
      );
    }
    return await loadBrief(briefOption, cwd);
  }

  const only = positionals.length === 1 ? positionals[0] : undefined;
  if (only !== undefined && looksLikeBriefPath(only)) {
    return await loadBrief(only, cwd);
  }

  const description = positionals.join(" ").trim();
  if (description.length === 0) {
    throw new BriefError("run requires a task description or a brief file");
  }
  return inlineBrief(description);
}
