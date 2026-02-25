// Stock SMA Monitor — Node.js script for GitHub Actions
// Fetches daily price data, calculates SMAs, and sends a digest email.

import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// Config — edit tickers and thresholds here
// ---------------------------------------------------------------------------
const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'];
const ALPHA_VANTAGE_BASE_URL = 'https://www.alphavantage.co/query';
const API_RATE_LIMIT_DELAY = 12000; // 12 s between calls (free-tier limit)

// ---------------------------------------------------------------------------
// Secrets from environment (set as GitHub Actions repository secrets)
// ---------------------------------------------------------------------------
const API_KEY   = process.env.ALPHA_VANTAGE_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO   = process.env.EMAIL_TO;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
async function fetchStockData(ticker) {
    const url = `${ALPHA_VANTAGE_BASE_URL}?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${API_KEY}`;

    console.log(`Fetching data for ${ticker}...`);
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`NETWORK_ERROR: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data['Error Message']) throw new Error(`INVALID_TICKER: ${ticker}`);
    if (data['Note'])          throw new Error(`RATE_LIMIT: ${data['Note']}`);
    if (data['Information'])   throw new Error(`API_KEY_ERROR: ${data['Information']}`);

    const timeSeries = data['Time Series (Daily)'];
    if (!timeSeries || Object.keys(timeSeries).length === 0) {
        throw new Error(`NO_DATA: ${ticker}`);
    }

    return data;
}

// ---------------------------------------------------------------------------
// SMA — copied verbatim from script.js:125
// ---------------------------------------------------------------------------
function calculateSMA(prices, period) {
    if (prices.length < period) {
        return null;
    }
    const sum = prices.slice(0, period).reduce((acc, price) => acc + price, 0);
    return sum / period;
}

// ---------------------------------------------------------------------------
// Process — adapted from script.js:134 (DOM logic removed)
// ---------------------------------------------------------------------------
function processStockData(data, ticker) {
    const timeSeries = data['Time Series (Daily)'];
    const dates = Object.keys(timeSeries).sort((a, b) => new Date(b) - new Date(a));

    const latestDate  = dates[0];
    const latestPrice = parseFloat(timeSeries[latestDate]['4. close']);
    const closingPrices = dates.map(date => parseFloat(timeSeries[date]['4. close']));

    const sma50  = calculateSMA(closingPrices, 50);
    const sma200 = calculateSMA(closingPrices, 200);

    const signals = [];

    // Data freshness
    const daysDiff = Math.floor((Date.now() - new Date(latestDate)) / (1000 * 60 * 60 * 24));
    if (daysDiff > 3) {
        signals.push({ text: `Warning: Data is ${daysDiff} days old`, type: 'warning' });
    }

    // Price vs 50-day SMA
    if (sma50 !== null) {
        const diffPercent = ((latestPrice - sma50) / sma50 * 100).toFixed(2);
        if (latestPrice > sma50) {
            signals.push({ text: `${Math.abs(diffPercent)}% above 50-day SMA ($${sma50.toFixed(2)}) — Bullish`, type: 'bullish' });
        } else {
            signals.push({ text: `${Math.abs(diffPercent)}% below 50-day SMA ($${sma50.toFixed(2)}) — Bearish`, type: 'bearish' });
        }
    } else {
        signals.push({ text: `Insufficient data for 50-day SMA (have ${closingPrices.length} days)`, type: 'warning' });
    }

    // Price vs 200-day SMA
    if (sma200 !== null) {
        const diffPercent = ((latestPrice - sma200) / sma200 * 100).toFixed(2);
        if (latestPrice > sma200) {
            signals.push({ text: `${Math.abs(diffPercent)}% above 200-day SMA ($${sma200.toFixed(2)}) — Bullish`, type: 'bullish' });
        } else {
            signals.push({ text: `${Math.abs(diffPercent)}% below 200-day SMA ($${sma200.toFixed(2)}) — Bearish`, type: 'bearish' });
        }
    } else {
        signals.push({ text: `Insufficient data for 200-day SMA (have ${closingPrices.length} days)`, type: 'warning' });
    }

    // Golden Cross / Death Cross
    if (sma50 !== null && sma200 !== null) {
        if (sma50 > sma200) {
            signals.push({ text: 'Golden Cross: 50-day SMA above 200-day SMA — Bullish', type: 'bullish' });
        } else {
            signals.push({ text: 'Death Cross: 50-day SMA below 200-day SMA — Bearish', type: 'bearish' });
        }
    }

    return {
        ticker: ticker.toUpperCase(),
        latestDate,
        latestPrice,
        sma50,
        sma200,
        signals,
        dataPoints: closingPrices.length,
        error: null
    };
}

// ---------------------------------------------------------------------------
// Email formatting
// ---------------------------------------------------------------------------
function buildEmailBody(results) {
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Plain-text version
    const divider = '='.repeat(72);
    let text = `Stock SMA Daily Digest — ${dateStr}\n${divider}\n\n`;

    for (const r of results) {
        if (r.error) {
            text += `${r.ticker}: ERROR — ${r.error}\n\n`;
            continue;
        }
        text += `${r.ticker}  |  Price: $${r.latestPrice.toFixed(2)}  |  As of ${r.latestDate}\n`;
        text += `  SMA-50:  ${r.sma50  !== null ? '$' + r.sma50.toFixed(2)  : 'N/A'}\n`;
        text += `  SMA-200: ${r.sma200 !== null ? '$' + r.sma200.toFixed(2) : 'N/A'}\n`;
        for (const s of r.signals) {
            text += `  [${s.type.toUpperCase()}] ${s.text}\n`;
        }
        text += '\n';
    }

    // HTML version
    const signalColor = { bullish: '#16a34a', bearish: '#dc2626', warning: '#d97706' };

    let rows = '';
    for (const r of results) {
        if (r.error) {
            rows += `<tr><td colspan="5" style="color:#dc2626;padding:8px 12px">${r.ticker}: ${r.error}</td></tr>`;
            continue;
        }
        const signalsHtml = r.signals.map(s =>
            `<span style="color:${signalColor[s.type] || '#374151'}">${s.text}</span>`
        ).join('<br>');

        rows += `
        <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:8px 12px;font-weight:600">${r.ticker}</td>
            <td style="padding:8px 12px">$${r.latestPrice.toFixed(2)}</td>
            <td style="padding:8px 12px">${r.sma50  !== null ? '$' + r.sma50.toFixed(2)  : 'N/A'}</td>
            <td style="padding:8px 12px">${r.sma200 !== null ? '$' + r.sma200.toFixed(2) : 'N/A'}</td>
            <td style="padding:8px 12px;font-size:0.9em">${signalsHtml}</td>
        </tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;color:#111827;max-width:900px;margin:0 auto;padding:20px">
        <h2 style="border-bottom:2px solid #3b82f6;padding-bottom:8px">
            Stock SMA Daily Digest
        </h2>
        <p style="color:#6b7280">${dateStr}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
            <thead>
                <tr style="background:#f3f4f6">
                    <th style="padding:10px 12px;text-align:left">Ticker</th>
                    <th style="padding:10px 12px;text-align:left">Price</th>
                    <th style="padding:10px 12px;text-align:left">SMA-50</th>
                    <th style="padding:10px 12px;text-align:left">SMA-200</th>
                    <th style="padding:10px 12px;text-align:left">Signals</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:24px;font-size:0.8em;color:#9ca3af">
            Generated by Stock SMA Monitor · GitHub Actions
        </p>
    </body>
    </html>`;

    return { text, html };
}

// ---------------------------------------------------------------------------
// Email sending
// ---------------------------------------------------------------------------
async function sendEmail(subject, body) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });

    const info = await transporter.sendMail({
        from: `"Stock SMA Monitor" <${EMAIL_USER}>`,
        to: EMAIL_TO,
        subject,
        text: body.text,
        html: body.html
    });

    console.log(`Email sent: ${info.messageId}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    // Validate required secrets
    if (!API_KEY || !EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
        console.error('Missing required environment variables. Check ALPHA_VANTAGE_API_KEY, EMAIL_USER, EMAIL_PASS, EMAIL_TO.');
        process.exit(1);
    }

    console.log(`Starting SMA monitor for: ${TICKERS.join(', ')}`);

    const results = [];

    for (let i = 0; i < TICKERS.length; i++) {
        const ticker = TICKERS[i];

        // Rate-limit delay between calls (skip before first call)
        if (i > 0) {
            console.log(`Waiting ${API_RATE_LIMIT_DELAY / 1000}s before next API call...`);
            await new Promise(resolve => setTimeout(resolve, API_RATE_LIMIT_DELAY));
        }

        try {
            const data = await fetchStockData(ticker);
            const analysis = processStockData(data, ticker);
            console.log(`  ${ticker}: $${analysis.latestPrice.toFixed(2)} | SMA-50: ${analysis.sma50?.toFixed(2) ?? 'N/A'} | SMA-200: ${analysis.sma200?.toFixed(2) ?? 'N/A'}`);
            results.push(analysis);
        } catch (err) {
            console.error(`  ${ticker}: ${err.message}`);
            results.push({ ticker: ticker.toUpperCase(), error: err.message, signals: [] });
        }
    }

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const subject = `Stock SMA Digest — ${dateStr}`;
    const body = buildEmailBody(results);

    console.log('\nSending digest email...');
    await sendEmail(subject, body);
    console.log('Done.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
