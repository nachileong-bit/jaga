// tests/unit/noDirectDate.test.ts
// Spec rule: "No code may call Date.now() directly."
// This test scans all .ts files under src/ (except clock.ts, which is the
// abstraction layer) and fails if it finds `Date.now(` or `new Date()`
// called with no arguments IN CODE (comments are stripped).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "..", "src");

function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...findTsFiles(fullPath));
    } else if (entry.endsWith(".ts") && entry !== "clock.ts") {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Strip comments from TypeScript source so we only check actual code.
 * Handles // line comments and /* block comments.
 */
function stripComments(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    // Line comment
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String literal — skip to closing quote (handles escaped quotes)
    if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      result += source[i];
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          result += source[i];
          i++;
        }
        result += source[i];
        i++;
      }
      if (i < source.length) {
        result += source[i];
        i++;
      }
      continue;
    }
    result += source[i];
    i++;
  }
  return result;
}

describe("No direct Date.now() or new Date() in src/ (except clock.ts)", () => {
  const tsFiles = findTsFiles(SRC_DIR);

  it("found .ts files to scan", () => {
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  for (const file of tsFiles) {
    const relativePath = file.replace(join(__dirname, "..", "..") + "/", "");
    it(`${relativePath} has no Date.now() or bare new Date()`, () => {
      const raw = readFileSync(file, "utf-8");
      const code = stripComments(raw);

      // Check for Date.now(
      expect(
        code.includes("Date.now("),
        `${relativePath} contains Date.now() in code — use Clock instead`
      ).toBe(false);

      // Check for `new Date()` with no arguments.
      // Match `new Date()` and `new Date( )` but NOT `new Date("...")` or
      // `new Date(someVar)`.
      const bareNewDate = /\bnew\s+Date\s*\(\s*\)/g;
      const matches = code.match(bareNewDate);
      expect(
        matches === null,
        `${relativePath} contains bare \`new Date()\` (${matches?.length} occurrence(s)) — use Clock.now() instead`
      ).toBe(true);
    });
  }
});
