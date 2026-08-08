import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Merge forensics",
  description: "Merge health for repos worked by coding agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
