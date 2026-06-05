# StockAnalysis

Stock EMA analysis tool with a browser UI and an automated daily email digest via GitHub Actions.

## Browser App

- Enter any US market ticker to fetch the latest price from Alpha Vantage
- Displays EMA-10 and EMA-20 with bullish/bearish signals
- Saves search history to a local file (File System Access API, with localStorage fallback)

## Automated Daily Digest (GitHub Actions)

A scheduled workflow runs Monday–Friday at 4 PM ET (after NYSE close) and emails an HTML digest for a configurable watchlist.

### Setup

1. **Fork / clone this repo** and push to GitHub.

2. **Add these 5 secrets** in your repo → Settings → Secrets and variables → Actions:

   | Secret | Description |
   |---|---|
   | `ALPHA_VANTAGE_API_KEY` | Free key from [alphavantage.co](https://www.alphavantage.co) |
   | `EMAIL_USER` | Gmail address used to send the digest |
   | `EMAIL_PASS` | Gmail App Password (see below) |
   | `EMAIL_TO` | Recipient(s) — comma-separated, e.g. `you@gmail.com,friend@gmail.com` |
   | `TICKERS` | Comma-separated ticker list, e.g. `AAPL,MSFT,GOOGL` |

3. **Gmail App Password** — regular Gmail passwords are not accepted:
   - Go to [myaccount.google.com/security](https://myaccount.google.com/security)
   - Enable 2-Step Verification if not already on
   - Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), generate a password for "Mail"
   - Use that 16-character password as `EMAIL_PASS`

4. **Trigger manually** to test: Actions tab → Stock EMA Monitor → Run workflow.

### Changing the watchlist

Update the `TICKERS` secret in GitHub — no code changes needed. Format: `AAPL,MSFT,GOOGL,AMZN,NVDA`.

## Tech Stack

- **Browser**: Vanilla JS, HTML/CSS, Alpha Vantage API
- **Automation**: Node.js 20, Nodemailer, GitHub Actions
