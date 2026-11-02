import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "kaikai — จัดการร้านให้เห็นกำไรจริง",
    short_name: "kaikai",
    description: "จัดการยอดขาย ต้นทุน ค่าใช้จ่าย และกำไรร้านอาหาร",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f5f0",
    theme_color: "#fffdfa",
    lang: "th",
    categories: ["business", "finance", "food", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "เปิดบิลใหม่",
        short_name: "เปิดบิล",
        description: "บันทึกรายการขายใหม่ทันที",
        url: "/sales/new",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "บันทึกค่าใช้จ่าย",
        short_name: "ค่าใช้จ่าย",
        description: "แนบสลิปและบันทึกค่าใช้จ่ายหรือซื้อวัตถุดิบ",
        url: "/expenses",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "รายงานผลประกอบการ",
        short_name: "รายงาน",
        description: "ดูสรุปยอดขาย ต้นทุน และกำไรสุทธิ",
        url: "/reports",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
