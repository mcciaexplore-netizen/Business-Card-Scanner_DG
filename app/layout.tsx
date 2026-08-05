import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuraScan — Business Card Scanner",
  description: "Scan business cards and save them automatically to Google Sheets.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Outfit:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="ambient-glow glow-1" />
        <div className="ambient-glow glow-2" />
        {children}
      </body>
    </html>
  );
}
