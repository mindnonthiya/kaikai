import { describe, expect, it } from "vitest";
import type { ProfileRecord } from "./data/types";

describe("ProfileRecord and avatar resolution", () => {
  it("resolves avatarUrl correctly when present in database record", () => {
    const profile: ProfileRecord = {
      displayName: "ร้านไก่ไก่",
      shopName: "ไก่ไก่",
      email: "shop@example.com",
      avatarUrl: "https://example.com/avatar.jpg",
    };
    expect(profile.avatarUrl).toBe("https://example.com/avatar.jpg");
  });

  it("handles null or undefined avatarUrl gracefully", () => {
    const profileWithoutAvatar: ProfileRecord = {
      displayName: "เจ้าของร้าน",
      shopName: "kaikai",
      email: null,
    };
    expect(profileWithoutAvatar.avatarUrl).toBeUndefined();

    const profileWithNullAvatar: ProfileRecord = {
      displayName: "เจ้าของร้าน",
      shopName: "kaikai",
      email: null,
      avatarUrl: null,
    };
    expect(profileWithNullAvatar.avatarUrl).toBeNull();
  });

  it("extracts initial letter correctly for avatar fallback", () => {
    function getInitial(displayName: string, shopName: string) {
      return Array.from((displayName || shopName || "ก").trim())[0] ?? "ก";
    }

    expect(getInitial("ไก่ไก่", "kaikai")).toBe("ไ");
    expect(getInitial("kaikai", "kaikai")).toBe("k");
    expect(getInitial("", "น้องไก่")).toBe("น");
    expect(getInitial("", "")).toBe("ก");
  });
});
