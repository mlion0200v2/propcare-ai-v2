import type { Metadata } from "next";
import { Geist, Geist_Mono, Montserrat, Prata } from "next/font/google";
import "./globals.css";
import { DemoBarSlot } from "@/components/demo/demo-bar-slot";
import { SiteFooter } from "@/components/site-footer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const prata = Prata({
  variable: "--font-prata",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "PropCare by Birchwood Management",
  description: "A maintenance desk that never sleeps, for your rentals.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${montserrat.variable} ${prata.variable} antialiased`}
      >
        <DemoBarSlot />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
