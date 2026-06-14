import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'POIDHMP — POIDH Claim NFT Marketplace',
  description: 'Browse POIDH v3 claim NFTs across Ethereum, Arbitrum, Base, and Degen Chain.',
  metadataBase: new URL('https://poidhmp.arcabot.ai'),
  openGraph: {
    title: 'POIDHMP',
    description: 'Marketplace/discovery layer for POIDH claim NFTs.',
    url: 'https://poidhmp.arcabot.ai',
    siteName: 'POIDHMP',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'POIDHMP',
    description: 'Marketplace/discovery layer for POIDH claim NFTs.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
