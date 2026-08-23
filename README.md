# bitcoincash.ee Pool — Testnet4

**This is the Testnet4 version of bitcoincash.ee Pool.**

A Bitcoin Cash (BCH) mining pool with a 1 BCH block finder bonus, a Top 13 Best Shares payout, and a ~1.4% effective fee.

Run by the developer of [SoloChance.org](https://solochance.org).

## Connect

| Setting  | Value                     |
|----------|---------------------------|
| Stratum  | `testnet4.bitcoincash.ee:3333`    |
| Username | `YOUR_BCH_ADDRESS.worker` |
| Password | `x`                       |

For high-diff rentals (e.g. NiceHash), use port `3334`.

No registration required — your BCH address is your identity.

## Payout Structure

1. **1 BCH** finder bonus to whoever finds the block (fee-free), paid directly in the block's coinbase
2. **2%** pool fee on the remaining reward (Block Reward + Tx Fees - 1 BCH)
3. The remaining **98%** is split among the round's **Top 13 Best Shares** — the 13 highest-difficulty shares submitted since the last block — also paid in the coinbase:

   | Rank      | Share        |
   |-----------|--------------|
   | 1st       | 38.3%        |
   | 2nd       | 23.6%        |
   | 3rd       | 14.6%        |
   | 4th–13th  | 2.35% each   |

Every payout is included directly in the coinbase transaction that finds the block, so it's fully trustless with no ongoing bookkeeping.

## Fee

The effective fee on the full block reward is approximately **~1.4%** because the 1 BCH finder bonus is paid fee-free. The 2% fee applies only to the remaining distributable reward.

## Infrastructure

- **Pool software**: [asicseer-pool](https://github.com/cculianu/asicseer-pool) (based on [ckpool](https://bitbucket.org/ckolivas/ckpool/src/master/) by Con Kolivas)
- **Server**: Frankfurt, Germany
- **Website**: Static site hosted on GitHub Pages — no cookies, no tracking, no analytics

## Website

The frontend is a static site with no build step:

- `index.html` — Home, Connect, My Stats, Blocks
- `faq.html` — Frequently Asked Questions
- `terms.html` — Terms of Service
- `privacy.html` — Privacy Policy
- `app.js` — Pool API integration and UI logic
- `style.css` — Styles (dark glassmorphism theme)

### External APIs

| API                  | Purpose                                                         |
|----------------------|-----------------------------------------------------------------|
| `testnet4.bitcoincash.ee`    | Pool stats, user stats, block data                              |
| `api.solochance.org` | Block rate estimates, block chance, BCH price, network hashrate |
| Google Fonts         | Ubuntu and Ubuntu Mono typefaces                                |

## Links

- **Website**: [test.bch.ee](https://test.bch.ee)
- **Telegram**: [t.me/bitcoincashee](https://t.me/bitcoincashee)
- **FAQ**: [test.bch.ee/faq.html](https://test.bch.ee/faq.html)

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you fork, modify, or run this software as a service, you must make your source code available under the same license.
