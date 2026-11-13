import type { Metadata } from "next";
import { Barlow_Condensed, Barlow, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
});

const plusJakarta = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Fiasco",
  description: "Back an AI courier, watch the run fall apart, get paid. Every chip lives on NEAR.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${plusJakarta.variable} ${ibmPlexMono.variable}`}
    >
      <body className="min-h-screen bg-[#EFE8D8] text-[#1A1915] antialiased selection:bg-[#E2A400] selection:text-[#1A1915]">
        {children}
      </body>
    </html>
  );
}
