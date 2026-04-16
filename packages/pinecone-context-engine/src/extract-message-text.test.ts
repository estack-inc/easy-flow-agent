import { describe, expect, it } from "vitest";
import { extractMessageText } from "./shared.js";

describe("extractMessageText", () => {
  it("returns string content as-is", () => {
    expect(extractMessageText("hello world")).toBe("hello world");
  });

  it("returns empty string for empty string", () => {
    expect(extractMessageText("")).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractMessageText([])).toBe("");
  });

  it("extracts text from array with type:text entries", () => {
    const content = [
      { type: "text", text: "first message" },
      { type: "text", text: "second message" },
    ];
    expect(extractMessageText(content)).toBe("first message\nsecond message");
  });

  it("filters out toolCall entries", () => {
    const content = [
      { type: "text", text: "user question" },
      { type: "toolCall", toolCallId: "tc1", toolName: "read", args: {} },
      { type: "text", text: "follow up" },
    ];
    expect(extractMessageText(content)).toBe("user question\nfollow up");
  });

  it("filters out toolResult entries", () => {
    const content = [
      { type: "toolResult", toolCallId: "tc1", result: "some result" },
      { type: "text", text: "actual message" },
    ];
    expect(extractMessageText(content)).toBe("actual message");
  });

  it("filters out thinking entries", () => {
    const content = [
      { type: "thinking", text: "internal reasoning" },
      { type: "text", text: "visible response" },
    ];
    expect(extractMessageText(content)).toBe("visible response");
  });

  it("returns empty string for array with only non-text types", () => {
    const content = [
      { type: "toolCall", toolCallId: "tc1", toolName: "read", args: {} },
      { type: "toolResult", toolCallId: "tc1", result: "result" },
    ];
    expect(extractMessageText(content)).toBe("");
  });

  it("handles mixed content with single text entry", () => {
    const content = [
      { type: "toolCall", toolCallId: "tc1", toolName: "bash", args: {} },
      { type: "toolResult", toolCallId: "tc1", result: "ok" },
      { type: "text", text: "done with task" },
    ];
    expect(extractMessageText(content)).toBe("done with task");
  });

  it("returns empty string for non-array non-string content", () => {
    // @ts-expect-error testing invalid input
    expect(extractMessageText(42)).toBe("");
    // @ts-expect-error testing invalid input
    expect(extractMessageText(null)).toBe("");
    // @ts-expect-error testing invalid input
    expect(extractMessageText(undefined)).toBe("");
  });

  it("handles array entries missing text field gracefully", () => {
    const content = [
      { type: "text" }, // missing text field
      { type: "text", text: "valid" },
    ];
    expect(extractMessageText(content)).toBe("valid");
  });
});
