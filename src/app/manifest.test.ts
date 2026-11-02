import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("PWA manifest", () => {
  it("defines standalone display mode, icons, and quick actions", () => {
    const data = manifest();
    expect(data.short_name).toBe("kaikai");
    expect(data.display).toBe("standalone");
    expect(data.start_url).toBe("/dashboard");
    expect(data.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
      ]),
    );
    expect(data.shortcuts?.map((s) => s.url)).toEqual(["/sales/new", "/expenses", "/reports"]);
  });
});
