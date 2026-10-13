import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "kaikai — จัดการร้านให้เห็นกำไรจริง",
  description: "จัดการยอดขาย ต้นทุน ค่าใช้จ่าย และกำไรร้านอาหาร",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#fff9f1" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
