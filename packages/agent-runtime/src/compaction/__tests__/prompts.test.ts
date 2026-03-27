import { describe, it, expect } from "vitest";
import {
  IDENTIFIER_PRESERVATION_INSTRUCTIONS,
  buildSummarizationPrompt,
  MERGE_SUMMARIES_PROMPT,
} from "../prompts.js";

describe("Compaction Prompts", () => {
  describe("IDENTIFIER_PRESERVATION_INSTRUCTIONS", () => {
    it("mentions UUIDs", () => {
      expect(IDENTIFIER_PRESERVATION_INSTRUCTIONS).toContain("UUID");
    });

    it("mentions file paths", () => {
      expect(IDENTIFIER_PRESERVATION_INSTRUCTIONS).toContain("File paths");
    });

    it("mentions URLs", () => {
      expect(IDENTIFIER_PRESERVATION_INSTRUCTIONS).toContain("URL");
    });
  });

  describe("buildSummarizationPrompt", () => {
    it("builds prompt without previous summary", () => {
      const prompt = buildSummarizationPrompt();
      expect(prompt).toContain("summarizing a conversation");
      expect(prompt).toContain("Active tasks");
      expect(prompt).not.toContain("Previous summary");
    });

    it("includes previous summary when provided", () => {
      const prompt = buildSummarizationPrompt("Previously discussed auth flow");
      expect(prompt).toContain("Previous summary");
      expect(prompt).toContain("Previously discussed auth flow");
    });
  });

  describe("MERGE_SUMMARIES_PROMPT", () => {
    it("includes merge instructions", () => {
      expect(MERGE_SUMMARIES_PROMPT).toContain("merging multiple partial summaries");
    });

    it("includes identifier preservation", () => {
      expect(MERGE_SUMMARIES_PROMPT).toContain("UUID");
    });
  });
});
