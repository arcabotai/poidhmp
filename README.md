# POIDHMP

Standalone POIDH claim NFT marketplace/discovery MVP for `poidhmp.arcabot.ai`.

## What it does

- Lists the canonical POIDH v3 claim NFT contracts across Ethereum, Arbitrum, Base, and Degen Chain.
- Lets users look up a claim NFT by chain + token ID.
- Reads `ownerOf` and `tokenURI` directly from the NFT contracts through public RPCs.
- Resolves HTTP/IPFS/Arweave metadata and image URLs.
- Links each NFT to the relevant explorer and marketplace surface.

This first version does **not** deploy a native listing/escrow contract. It is the safe discovery layer Kenny asked for before money-moving marketplace work.

## Run locally

```bash
npm install
npm run dev
```

Open the local Next.js dev URL printed by the terminal.

## Verify

```bash
npm run typecheck
npm run build
```

## Canonical POIDH v3 NFT contracts

- Ethereum: `0x9c5f45d5e1382e4058d334d93c6c01442012a4d9`
- Arbitrum: `0x27e117cc9a8da363442e7bd0618939e3eeeacf6a`
- Base: `0x27e117cc9a8da363442e7bd0618939e3eeeacf6a`
- Degen Chain: `0x39F04b7897DCAf9Dc454E433F43Fb1C3bB528E11`
