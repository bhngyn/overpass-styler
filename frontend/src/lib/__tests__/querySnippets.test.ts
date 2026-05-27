import { describe, expect, it } from "vitest";
import { QUERY_SNIPPETS } from "../querySnippets";

describe("QUERY_SNIPPETS", () => {
  it("exports at least one snippet", () => {
    expect(QUERY_SNIPPETS.length).toBeGreaterThan(0);
  });

  it("every snippet has a non-empty QL body", () => {
    for (const s of QUERY_SNIPPETS) {
      expect(s.ql.trim().length, `snippet ${s.id} should have non-empty QL`).toBeGreaterThan(0);
    }
  });

  it("every snippet has a non-empty title and description", () => {
    for (const s of QUERY_SNIPPETS) {
      expect(s.title.length, `snippet ${s.id} title`).toBeGreaterThan(0);
      expect(s.description.length, `snippet ${s.id} description`).toBeGreaterThan(0);
    }
  });

  it("every applicable snippet contains the {{bbox}} token", () => {
    // The "custom" scaffold doesn't reference {{bbox}} — it's an empty seed
    // that the investigator fills in. Every domain snippet should be
    // bbox-scoped so it doesn't accidentally query the whole planet.
    for (const s of QUERY_SNIPPETS) {
      if (s.id === "custom") continue;
      expect(s.ql, `snippet ${s.id} should reference {{bbox}}`).toContain("{{bbox}}");
    }
  });

  it("snippet ids are unique", () => {
    const ids = QUERY_SNIPPETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every snippet includes an [out:json] header", () => {
    for (const s of QUERY_SNIPPETS) {
      expect(s.ql, `snippet ${s.id} should set [out:json]`).toMatch(/\[out:json\]/);
    }
  });
});
