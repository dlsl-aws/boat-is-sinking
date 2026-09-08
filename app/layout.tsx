import type { Metadata, Viewport } from "next";
import { Fredoka, Inter } from "next/font/google";
import "./globals.css";

/**
 * Fredoka for anything that shouts, Inter for anything that is read.
 *
 * Fredoka is round, heavy and slightly goofy — it stops the game reading as
 * corporate software, which matters when the whole point is to loosen a room up.
 * Inter carries the dashboard, where density and legibility beat personality.
 *
 * Both are self-hosted at build time by `next/font`, so there is no runtime
 * request to Google and no flash of unstyled text on venue wifi.
 */
const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-fredoka",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "The Boat Is Sinking",
  description: "A live icebreaker for a room full of people.",
};

export const viewport: Viewport = {
  themeColor: "#020a14",
  width: "device-width",
  initialScale: 1,
  // Players tap a four-character code under time pressure; a stray double-tap
  // zooming the page would be its own small disaster.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fredoka.variable} ${inter.variable}`}>
      <body className="caustics">{children}</body>
    </html>
  );
}
