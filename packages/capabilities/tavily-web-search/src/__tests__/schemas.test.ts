import { describe, expect, it } from "vitest";
import {
  FETCH_TOOL_DESCRIPTION,
  FETCH_TOOL_NAME,
  FetchArgsSchema,
  SCHEMA_CONTENT_HASH,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
  SearchArgsSchema,
} from "../schemas.js";

describe("tavily schemas", () => {
  it("exports search tool constants", () => {
    expect(SEARCH_TOOL_NAME).toBe("web_search");
    expect(SEARCH_TOOL_DESCRIPTION).toBeTruthy();
    expect(SearchArgsSchema).toBeDefined();
    expect(SearchArgsSchema.properties.query).toBeDefined();
  });

  it("exports fetch tool constants", () => {
    expect(FETCH_TOOL_NAME).toBe("web_fetch");
    expect(FETCH_TOOL_DESCRIPTION).toBeTruthy();
    expect(FetchArgsSchema).toBeDefined();
    expect(FetchArgsSchema.properties.url).toBeDefined();
  });

  it("exports schema content hash for drift detection", () => {
    expect(SCHEMA_CONTENT_HASH).toBe("tavily-schemas-v1");
  });
});
