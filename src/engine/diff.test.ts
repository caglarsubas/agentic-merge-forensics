import { describe, expect, it } from "vitest";

import {
  isUninterestingPath,
  oldSideLineNumbers,
  parseNumstat,
  parseUnifiedZeroDiff,
  resolveRenamePath,
} from "./diff";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,5 @@
@@ -40 +42,2 @@
diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,20 @@
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

describe("parseUnifiedZeroDiff", () => {
  it("captures per-file hunk ranges", () => {
    const files = parseUnifiedZeroDiff(DIFF);
    expect(files).toHaveLength(3);
    expect(files[0].oldPath).toBe("src/a.ts");
    expect(files[0].hunks).toEqual([
      { oldStart: 10, oldLines: 3, newStart: 10, newLines: 5 },
      { oldStart: 40, oldLines: 1, newStart: 42, newLines: 2 },
    ]);
  });

  it("marks an added file as having no old side", () => {
    const files = parseUnifiedZeroDiff(DIFF);
    expect(files[1].oldPath).toBeNull();
    expect(files[1].newPath).toBe("src/new.ts");
  });

  it("flags binary files so blame is never attempted on them", () => {
    const files = parseUnifiedZeroDiff(DIFF);
    expect(files[2].binary).toBe(true);
  });
});

describe("oldSideLineNumbers", () => {
  it("expands hunks into the line numbers blame should be asked about", () => {
    const [file] = parseUnifiedZeroDiff(DIFF);
    expect(oldSideLineNumbers(file)).toEqual([10, 11, 12, 40]);
  });

  it("returns nothing for a pure insertion, which displaces no existing line", () => {
    const files = parseUnifiedZeroDiff(DIFF);
    expect(oldSideLineNumbers(files[1])).toEqual([]);
  });
});

describe("parseNumstat", () => {
  it("parses counts and resolves renames to the new path", () => {
    const entries = parseNumstat(
      ["10\t2\tsrc/a.ts", "-\t-\timg.png", "3\t1\tsrc/{old => new}/b.ts"].join("\n"),
    );
    expect(entries[0]).toEqual({ path: "src/a.ts", additions: 10, deletions: 2 });
    expect(entries[1].additions).toBeNull();
    expect(entries[2].path).toBe("src/new/b.ts");
  });
});

describe("resolveRenamePath", () => {
  it("handles brace and arrow rename forms", () => {
    expect(resolveRenamePath("src/{a => b}/f.ts")).toBe("src/b/f.ts");
    expect(resolveRenamePath("old.ts => new.ts")).toBe("new.ts");
    expect(resolveRenamePath("plain.ts")).toBe("plain.ts");
  });

  it("collapses the doubled slash a removed brace segment leaves behind", () => {
    expect(resolveRenamePath("src/{old => }/f.ts")).toBe("src/f.ts");
  });
});

describe("isUninterestingPath", () => {
  it("skips generated and vendored files whose blame is noise", () => {
    expect(isUninterestingPath("prometa-platform/package-lock.json")).toBe(true);
    expect(isUninterestingPath("a/__snapshots__/x.snap")).toBe(true);
    expect(isUninterestingPath("vendor/lib/x.go")).toBe(true);
    expect(isUninterestingPath("src/lib/real-code.ts")).toBe(false);
  });
});
