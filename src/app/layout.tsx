import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { DARK_SCHEME_QUERY, THEME_BOOT_SCRIPT, THEME_COLORS } from "./theme/initialTheme";
import { BRAND_BASE_PATH, BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `${BRAND_NAME} Editor — Pure TypeScript PDF Engine`,
  description:
    "Edit PDFs in your browser. Optional timestamping contacts external services.",
  manifest: `${BRAND_BASE_PATH}/manifest.webmanifest`,
  icons: {
    icon: [
      { url: `${BRAND_BASE_PATH}/brand/paperloom-icon.svg`, type: "image/svg+xml", sizes: "any" },
    ],
    shortcut: `${BRAND_BASE_PATH}/brand/paperloom-icon.svg`,
    apple: { url: `${BRAND_BASE_PATH}/apple-icon.png`, sizes: "180x180", type: "image/png" },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: DARK_SCHEME_QUERY, color: THEME_COLORS.dark },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" style={{ colorScheme: "light" }} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ServiceWorkerRegistration />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
