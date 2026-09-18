import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "How tall can you build? — Portland, Maine",
  description:
    "Enter a Portland, Maine address and get an estimate of the tallest apartment building that current zoning and site constraints would plausibly allow on that parcel.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
