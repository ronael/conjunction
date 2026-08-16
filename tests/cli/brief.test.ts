import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BRIEF_MAX_BYTES,
  BriefError,
  deriveTitle,
  inlineBrief,
  loadBrief,
  looksLikeBriefPath,
  resolveBrief,
} from "../../src/cli/brief.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "conjunction-brief-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeBrief(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadBrief", () => {
  it("loads a valid file, keeps the content verbatim and records the absolute path", async () => {
    const dir = await makeDir();
    const content = "# ChessQuest\n\n## Objective\n\nTeach chess to kids.\n\n- one\n- two\n";
    const file = await writeBrief(dir, "brief.md", content);

    const brief = await loadBrief(file, dir);

    expect(brief.content).toBe(content); // byte-for-byte, no parsing
    expect(brief.title).toBe("ChessQuest");
    expect(brief.source).toEqual({ kind: "file", path: file });
    expect(path.isAbsolute((brief.source as { path: string }).path)).toBe(true);
  });

  it("rejects a missing file", async () => {
    const dir = await makeDir();
    await expect(loadBrief(path.join(dir, "nope.md"), dir)).rejects.toThrow(BriefError);
    await expect(loadBrief(path.join(dir, "nope.md"), dir)).rejects.toThrow(/brief file not found/);
  });

  it("rejects a directory", async () => {
    const dir = await makeDir();
    const sub = path.join(dir, "briefs");
    await mkdir(sub);
    await expect(loadBrief(sub, dir)).rejects.toThrow(/is a directory, expected a file/);
  });

  it("rejects an empty and a whitespace-only file", async () => {
    const dir = await makeDir();
    const empty = await writeBrief(dir, "empty.md", "");
    const blank = await writeBrief(dir, "blank.md", "   \n\n\t\n");
    await expect(loadBrief(empty, dir)).rejects.toThrow(/brief file is empty/);
    await expect(loadBrief(blank, dir)).rejects.toThrow(/brief file is empty/);
  });

  it("rejects a file over the size limit", async () => {
    const dir = await makeDir();
    const big = await writeBrief(dir, "big.md", "x".repeat(BRIEF_MAX_BYTES + 1));
    await expect(loadBrief(big, dir)).rejects.toThrow(/too large/);
  });

  it("accepts a file exactly at the size limit", async () => {
    const dir = await makeDir();
    const exact = await writeBrief(dir, "exact.md", "x".repeat(BRIEF_MAX_BYTES));
    const brief = await loadBrief(exact, dir);
    expect(brief.content).toHaveLength(BRIEF_MAX_BYTES);
  });

  it("rejects binary content (NUL byte)", async () => {
    const dir = await makeDir();
    const binary = await writeBrief(dir, "binary.md", "# Title\n\u0000garbage");
    await expect(loadBrief(binary, dir)).rejects.toThrow(/does not look like UTF-8 text/);
  });

  it("preserves unicode and strips only a leading BOM", async () => {
    const dir = await makeDir();
    const body = "# Échecs pour enfants 🧒♟️\n\nApprendre les règles — sans écran de connexion.\n";
    const file = await writeBrief(dir, "unicode.md", `\uFEFF${body}`);

    const brief = await loadBrief(file, dir);

    expect(brief.content).toBe(body);
    expect(brief.content.charCodeAt(0)).not.toBe(0xfeff);
    expect(brief.content).toContain("règles");
    expect(brief.content).toContain("🧒♟️");
    expect(brief.title).toBe("Échecs pour enfants 🧒♟️");
  });

  it("resolves a relative path against cwd, and an absolute path as-is", async () => {
    const dir = await makeDir();
    const nested = path.join(dir, "briefs");
    await mkdir(nested);
    const file = await writeBrief(nested, "x.md", "# Relative\n\nbody\n");

    const relative = await loadBrief(path.join("briefs", "x.md"), dir);
    expect(relative.source).toEqual({ kind: "file", path: file });

    const absolute = await loadBrief(file, path.join(dir, "unrelated"));
    expect(absolute.source).toEqual({ kind: "file", path: file });
  });
});

describe("deriveTitle", () => {
  it("uses the first ATX heading", () => {
    expect(deriveTitle("\n\n# ChessQuest\n\n## Objective\n", "/x/brief.md")).toBe("ChessQuest");
  });

  it("falls back to the basename when there is no heading", () => {
    expect(deriveTitle("just a paragraph of text\n", "/x/my-brief.md")).toBe("my-brief.md");
  });

  it("ignores non-ATX and deeper headings", () => {
    expect(deriveTitle("## Sub\n#NoSpace\n", "/x/brief.md")).toBe("brief.md");
  });

  it("truncates a very long heading", () => {
    const title = deriveTitle(`# ${"word ".repeat(50)}\n`, "/x/brief.md");
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("looksLikeBriefPath", () => {
  it("accepts path-like values and known text extensions", () => {
    for (const value of ["./brief.md", "../a/b.md", "/abs/brief.md", "~/x.md", "notes.txt"]) {
      expect(looksLikeBriefPath(value)).toBe(true);
    }
  });

  it("rejects ordinary task descriptions", () => {
    for (const value of [
      "fix authentication bug",
      "add a dark-mode toggle",
      "refactor",
      // a multi-word description that happens to end in a text extension
      "create a file hello.txt",
      "update README.md",
    ]) {
      expect(looksLikeBriefPath(value)).toBe(false);
    }
  });
});

describe("resolveBrief", () => {
  it("treats a single path-like positional as a file", async () => {
    const dir = await makeDir();
    await writeBrief(dir, "brief.md", "# Positional\n\nbody\n");
    const brief = await resolveBrief({ positionals: ["./brief.md"] }, dir);
    expect(brief.source.kind).toBe("file");
    expect(brief.title).toBe("Positional");
  });

  it("never falls back to a description when a path-like positional is missing", async () => {
    const dir = await makeDir();
    await expect(resolveBrief({ positionals: ["./typo.md"] }, dir)).rejects.toThrow(
      /brief file not found/,
    );
  });

  it("keeps the historic inline form working", async () => {
    const dir = await makeDir();
    const brief = await resolveBrief({ positionals: ["fix", "authentication", "bug"] }, dir);
    expect(brief).toEqual({
      source: { kind: "inline" },
      content: "fix authentication bug",
      title: "fix authentication bug",
    });
  });

  it("loads --brief without any heuristic", async () => {
    const dir = await makeDir();
    await writeBrief(dir, "plain-name", "# Explicit\n\nbody\n");
    const brief = await resolveBrief({ briefOption: "plain-name", positionals: [] }, dir);
    expect(brief.title).toBe("Explicit");
  });

  it("refuses --brief together with a description", async () => {
    const dir = await makeDir();
    await writeBrief(dir, "brief.md", "# X\n\nbody\n");
    await expect(
      resolveBrief({ briefOption: "./brief.md", positionals: ["also a task"] }, dir),
    ).rejects.toThrow(/not both/);
  });

  it("refuses an empty invocation", async () => {
    const dir = await makeDir();
    await expect(resolveBrief({ positionals: [] }, dir)).rejects.toThrow(
      /requires a task description or a brief file/,
    );
  });
});

describe("inlineBrief", () => {
  it("truncates the title but never the content", () => {
    const long = "a".repeat(300);
    const brief = inlineBrief(long);
    expect(brief.content).toBe(long);
    expect(brief.title).toHaveLength(80);
  });
});
