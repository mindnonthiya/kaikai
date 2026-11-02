import type { Metadata, Viewport } from "next";
import { PwaServiceWorkerRegister } from "@/components/pwa-install";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "kaikai",
  title: "kaikai — จัดการร้านให้เห็นกำไรจริง",
  description: "จัดการยอดขาย ต้นทุน ค่าใช้จ่าย และกำไรร้านอาหาร",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "kaikai",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fffdfa",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <body>
        <PwaServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
