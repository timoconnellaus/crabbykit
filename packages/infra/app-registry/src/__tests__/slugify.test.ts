import { describe, expect, it } from "vitest";
import { slugify } from "../slugify.js";

describe("slugify", () => {
  it("lowercases the input", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("replaces spaces with hyphens", () => {
    expect(slugify("my cool app")).toBe("my-cool-app");
  });

  it("replaces special characters with hyphens", () => {
    expect(slugify("my@app!v2")).toBe("my-app-v2");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("my---app")).toBe("my-app");
    expect(slugify("my   app")).toBe("my-app");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("--my-app--")).toBe("my-app");
    expect(slugify("  my app  ")).toBe("my-app");
  });

  it("handles mixed case and special chars", () => {
    expect(slugify("My Cool App (v2)")).toBe("my-cool-app-v2");
  });

  it("preserves numbers", () => {
    expect(slugify("app123")).toBe("app123");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles string with only special chars", () => {
    expect(slugify("@#$%")).toBe("");
  });
});
