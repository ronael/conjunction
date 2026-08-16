import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = path.join(fileURLToPath(new URL("../../src/", import.meta.url)));

async function tsSources(relativeDir: string): Promise<{ file: string; source: string }[]> {
  const dir = path.join(srcDir, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        return tsSources(relativePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return [];
      }
      return [
        { file: relativePath, source: await readFile(path.join(srcDir, relativePath), "utf8") },
      ];
    }),
  );
  return nested.flat();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

describe("architecture boundaries", () => {
  it("core imports no concrete adapters or CLI/UI modules", async () => {
    const sources = await tsSources("core");
    expect(sources.length).toBeGreaterThan(5);
    for (const { file, source } of sources) {
      const imports = importSpecifiers(source);
      expect(
        imports.some(
          (specifier) => specifier.includes("/adapters/") || specifier.startsWith("../adapters"),
        ),
        `${file} must not import concrete adapters`,
      ).toBe(false);
      expect(
        imports.some((specifier) => specifier.includes("/cli/") || specifier.startsWith("../cli")),
        `${file} must not import CLI or UI modules`,
      ).toBe(false);
    }
  });

  it("workspace and verification stay leaf modules that do not import core", async () => {
    const sources = [...(await tsSources("workspace")), ...(await tsSources("verification"))];
    expect(sources.length).toBeGreaterThan(2);
    for (const { file, source } of sources) {
      expect(
        importSpecifiers(source).some(
          (specifier) => specifier.includes("/core/") || specifier.startsWith("../core"),
        ),
        `${file} must not import core`,
      ).toBe(false);
    }
  });
});
