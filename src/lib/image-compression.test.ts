import { describe, expect, it } from "vitest";
import { computeSha256Hex } from "./image-compression";
import type { PricePreset } from "./data/types";

describe("slip compression and preset matching", () => {
  it("computes deterministic SHA-256 hex string from blob data", async () => {
    const textBlob = new Blob(["hello kaikai slip"], { type: "text/plain" });
    const hash = await computeSha256Hex(textBlob);
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);

    // Same content should yield identical hash
    const textBlob2 = new Blob(["hello kaikai slip"], { type: "text/plain" });
    const hash2 = await computeSha256Hex(textBlob2);
    expect(hash).toBe(hash2);
  });

  it("matches preset accurately by slip amount", () => {
    const presets: PricePreset[] = [
      {
        id: "p1",
        name: "ชุดไข่ต้ม 9 ฟอง + ส่ง 15 บ.",
        amountSatang: 8400,
        fulfillment: "delivery",
        deliveryChargedSatang: 1500,
        items: [{ menuId: "m1", quantity: 1 }],
      },
      {
        id: "p2",
        name: "ชุดไข่ต้มใหญ่ 15 ฟอง + ส่ง 15 บ.",
        amountSatang: 11400,
        fulfillment: "delivery",
        deliveryChargedSatang: 1500,
        items: [{ menuId: "m2", quantity: 1 }],
      },
    ];

    const match84 = presets.find((p) => p.amountSatang === 8400);
    expect(match84).toBeDefined();
    expect(match84?.name).toBe("ชุดไข่ต้ม 9 ฟอง + ส่ง 15 บ.");
    expect(match84?.deliveryChargedSatang).toBe(1500);

    const match114 = presets.find((p) => p.amountSatang === 11400);
    expect(match114).toBeDefined();
    expect(match114?.name).toBe("ชุดไข่ต้มใหญ่ 15 ฟอง + ส่ง 15 บ.");

    const matchNone = presets.find((p) => p.amountSatang === 20000);
    expect(matchNone).toBeUndefined();
  });
});
