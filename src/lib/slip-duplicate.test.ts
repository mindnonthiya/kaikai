import { describe, expect, it } from "vitest";
import { checkIntraBatchDuplicate } from "./slip-duplicate";

describe("checkIntraBatchDuplicate", () => {
  it("flags identical bank reference numbers as duplicate", () => {
    const existing = [
      { id: "1", referenceNumber: "016285194602CPP08790", hash: "hash1" },
    ];
    const candidate = { id: "2", referenceNumber: "016285194602CPP08790", hash: "hash2" };

    const result = checkIntraBatchDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain("016285194602CPP08790");
    expect(result.reason).toContain("ซ้ำกับสลิปอีกใบในชุดนี้");
  });

  it("flags identical case-insensitive bank reference numbers", () => {
    const existing = [
      { id: "1", referenceNumber: "016285194602cpp08790", hash: "hash1" },
    ];
    const candidate = { id: "2", referenceNumber: "016285194602CPP08790", hash: "hash2" };

    const result = checkIntraBatchDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(true);
  });

  it("flags identical file hashes as duplicate", () => {
    const existing = [
      { id: "1", referenceNumber: "REF111111", hash: "abc123sha256" },
    ];
    const candidate = { id: "2", referenceNumber: "REF222222", hash: "abc123sha256" };

    const result = checkIntraBatchDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain("ไฟล์รูปภาพนี้ซ้ำกับสลิปอีกใบในชุดนี้");
  });

  it("does NOT flag different slips with different refs and hashes", () => {
    const existing = [
      { id: "1", referenceNumber: "016285194602CPP08790", hash: "hash1" },
    ];
    const candidate = { id: "2", referenceNumber: "016285194602CPP08791", hash: "hash2" };

    const result = checkIntraBatchDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(false);
  });

  it("ignores comparing a candidate against itself", () => {
    const existing = [
      { id: "1", referenceNumber: "016285194602CPP08790", hash: "hash1" },
    ];
    const candidate = { id: "1", referenceNumber: "016285194602CPP08790", hash: "hash1" };

    const result = checkIntraBatchDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(false);
  });

  it("does not flag short or missing reference numbers as duplicates", () => {
    const existing = [{ id: "1", referenceNumber: "123", hash: "h1" }];
    const candidate = { id: "2", referenceNumber: "123", hash: "h2" };

    const result = checkIntraBatchDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(false);
  });
});
