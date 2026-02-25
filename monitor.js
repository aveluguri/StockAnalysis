// Stock SMA Monitor — Node.js script for GitHub Actions
// Fetches daily price data, calculates SMAs + TA indicators, and sends a digest email.

import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// Config — tickers loaded from TICKERS env var (comma-separated)
// ---------------------------------------------------------------------------
const TICKERS = process.env.TICKERS
    ? process.env.TICKERS.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    : ['CRWD', 'GOOG', 'MSFT', 'NVDA'];
const ALPHA_VANTAGE_BASE_URL = 'https://www.alphavantage.co/query';
const API_RATE_LIMIT_DELAY = 12000; // 12 s between calls (free-tier limit)

// ---------------------------------------------------------------------------
// Secrets from environment (set as GitHub Actions repository secrets)
// ---------------------------------------------------------------------------
const API_KEY    = process.env.ALPHA_VANTAGE_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO   = (process.env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean).join(',');

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
// Technical indicator calculations  (prices arrays are newest-first)
// ---------------------------------------------------------------------------

function calculateSMA(prices, period) {
    if (prices.length < period) return null;
    return prices.slice(0, period).reduce((acc, p) => acc + p, 0) / period;
}

// Returns an array of EMAs aligned to `prices` (oldest-first input expected internally)
function _emaArray(oldestFirst, period) {
    if (oldestFirst.length < period) return [];
    const k = 2 / (period + 1);
    const result = new Array(oldestFirst.length).fill(null);
    result[period - 1] = oldestFirst.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < oldestFirst.length; i++) {
        result[i] = oldestFirst[i] * k + result[i - 1] * (1 - k);
    }
    return result;
}

// RSI — Wilder's smoothing, 14-period
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    const oldest = [...prices].reverse();
    const changes = oldest.map((p, i) => i === 0 ? 0 : p - oldest[i - 1]).slice(1);

    // Seed
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    // Wilder smoothing over remaining periods
    for (let i = period; i < changes.length; i++) {
        avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
    }

    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

// MACD — standard (12, 26, 9)
function calculateMACD(prices) {
    if (prices.length < 35) return null; // 26 for MACD line + 9 for signal seed
    const oldest = [...prices].reverse();

    const ema12arr = _emaArray(oldest, 12);
    const ema26arr = _emaArray(oldest, 26);

    // MACD line values (valid from index 25 onwards)
    const macdValues = oldest
        .map((_, i) => (ema12arr[i] !== null && ema26arr[i] !== null) ? ema12arr[i] - ema26arr[i] : null)
        .filter(v => v !== null);

    if (macdValues.length < 9) return null;

    // Signal line = EMA(9) of MACD line
    const signalArr = _emaArray(macdValues, 9);
    const signalLine = signalArr[signalArr.length - 1];
    const macdLine = macdValues[macdValues.length - 1];

    return {
        macd: macdLine,
        signal: signalLine,
        histogram: macdLine - signalLine
    };
}

// Bollinger Bands — 20-period, 2 standard deviations
function calculateBollingerBands(prices, period = 20) {
    if (prices.length < period) return null;
    const recent = prices.slice(0, period);
    const sma = recent.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(recent.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period);
    return {
        upper: sma + 2 * stdDev,
        middle: sma,
        lower: sma - 2 * stdDev,
        bandwidth: ((4 * stdDev) / sma * 100)  // band width as % of middle
    };
}

// Price momentum — % change over 1 week (5 days) and 1 month (21 days)
function calculateMomentum(prices) {
    return {
        week:  prices.length >= 6  ? ((prices[0] - prices[5])  / prices[5]  * 100) : null,
        month: prices.length >= 22 ? ((prices[0] - prices[21]) / prices[21] * 100) : null
    };
}

// ---------------------------------------------------------------------------
// Process stock data — returns analysis object
// ---------------------------------------------------------------------------
function processStockData(data, ticker) {
    const timeSeries = data['Time Series (Daily)'];
    const dates = Object.keys(timeSeries).sort((a, b) => new Date(b) - new Date(a));

    const latestDate    = dates[0];
    const latestPrice   = parseFloat(timeSeries[latestDate]['4. close']);
    const closingPrices = dates.map(date => parseFloat(timeSeries[date]['4. close']));

    const sma50  = calculateSMA(closingPrices, 50);
    const sma100 = calculateSMA(closingPrices, 100);
    const rsi    = calculateRSI(closingPrices);
    const macd   = calculateMACD(closingPrices);
    const bb     = calculateBollingerBands(closingPrices);
    const mom    = calculateMomentum(closingPrices);

    const signals = [];

    // Data freshness
    const daysDiff = Math.floor((Date.now() - new Date(latestDate)) / (1000 * 60 * 60 * 24));
    if (daysDiff > 3) {
        signals.push({ text: `Warning: Data is ${daysDiff} days old`, type: 'warning' });
    }

    // Price vs SMA-50
    if (sma50 !== null) {
        const diff = ((latestPrice - sma50) / sma50 * 100).toFixed(2);
        signals.push(latestPrice > sma50
            ? { text: `${Math.abs(diff)}% above 50-day SMA ($${sma50.toFixed(2)}) — Bullish`, type: 'bullish' }
            : { text: `${Math.abs(diff)}% below 50-day SMA ($${sma50.toFixed(2)}) — Bearish`, type: 'bearish' });
    }

    // Price vs SMA-100
    if (sma100 !== null) {
        const diff = ((latestPrice - sma100) / sma100 * 100).toFixed(2);
        signals.push(latestPrice > sma100
            ? { text: `${Math.abs(diff)}% above 100-day SMA ($${sma100.toFixed(2)}) — Bullish`, type: 'bullish' }
            : { text: `${Math.abs(diff)}% below 100-day SMA ($${sma100.toFixed(2)}) — Bearish`, type: 'bearish' });
    }

    // Golden / Death Cross
    if (sma50 !== null && sma100 !== null) {
        signals.push(sma50 > sma100
            ? { text: 'Golden Cross: 50-day SMA above 100-day SMA — Bullish', type: 'bullish' }
            : { text: 'Death Cross: 50-day SMA below 100-day SMA — Bearish', type: 'bearish' });
    }

    // RSI
    if (rsi !== null) {
        const r = rsi.toFixed(1);
        if (rsi > 70)      signals.push({ text: `RSI ${r} — Overbought`, type: 'bearish' });
        else if (rsi < 30) signals.push({ text: `RSI ${r} — Oversold`, type: 'bullish' });
        else               signals.push({ text: `RSI ${r} — Neutral`, type: 'warning' });
    }

    // MACD
    if (macd !== null) {
        signals.push(macd.histogram > 0
            ? { text: `MACD ${macd.macd.toFixed(3)} above signal (${macd.signal.toFixed(3)}) — Bullish momentum`, type: 'bullish' }
            : { text: `MACD ${macd.macd.toFixed(3)} below signal (${macd.signal.toFixed(3)}) — Bearish momentum`, type: 'bearish' });
    }

    // Bollinger Bands
    if (bb !== null) {
        if (latestPrice > bb.upper) {
            signals.push({ text: `Price above upper Bollinger Band ($${bb.upper.toFixed(2)}) — Overbought`, type: 'bearish' });
        } else if (latestPrice < bb.lower) {
            signals.push({ text: `Price below lower Bollinger Band ($${bb.lower.toFixed(2)}) — Oversold`, type: 'bullish' });
        } else {
            const pct = ((latestPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(0);
            signals.push({ text: `Price at ${pct}% within Bollinger Bands ($${bb.lower.toFixed(2)} – $${bb.upper.toFixed(2)})`, type: 'warning' });
        }
    }

    return {
        ticker: ticker.toUpperCase(),
        latestDate,
        latestPrice,
        sma50,
        sma100,
        rsi,
        macd,
        bb,
        mom,
        signals,
        dataPoints: closingPrices.length,
        error: null
    };
}

// ---------------------------------------------------------------------------
// Email formatting
// ---------------------------------------------------------------------------
function fmt(val, decimals = 2, prefix = '') {
    return val !== null && val !== undefined ? `${prefix}${val.toFixed(decimals)}` : 'N/A';
}

function fmtPct(val) {
    if (val === null || val === undefined) return 'N/A';
    const sign = val >= 0 ? '+' : '';
    return `${sign}${val.toFixed(2)}%`;
}

function buildEmailBody(results) {
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const signalColor = { bullish: '#16a34a', bearish: '#dc2626', warning: '#d97706' };

    // --- Plain text ---
    const divider = '='.repeat(72);
    let text = `Stock Technical Analysis Digest — ${dateStr}\n${divider}\n\n`;

    for (const r of results) {
        if (r.error) { text += `${r.ticker}: ERROR — ${r.error}\n\n`; continue; }
        text += `${r.ticker}  |  $${r.latestPrice.toFixed(2)}  |  As of ${r.latestDate}\n`;
        text += `  SMA-50: ${fmt(r.sma50, 2, '$')}  |  SMA-100: ${fmt(r.sma100, 2, '$')}\n`;
        text += `  RSI(14): ${fmt(r.rsi, 1)}  |  MACD: ${r.macd ? r.macd.macd.toFixed(3) : 'N/A'}  |  Signal: ${r.macd ? r.macd.signal.toFixed(3) : 'N/A'}\n`;
        text += `  Bollinger: $${fmt(r.bb?.lower, 2)} – $${fmt(r.bb?.upper, 2)}\n`;
        text += `  Momentum — 1W: ${fmtPct(r.mom?.week)}  |  1M: ${fmtPct(r.mom?.month)}\n`;
        text += `  Signals:\n`;
        for (const s of r.signals) text += `    [${s.type.toUpperCase()}] ${s.text}\n`;
        text += '\n';
    }

    // --- HTML ---
    // Table 1: Price + SMAs + Signals
    let smaRows = '';
    for (const r of results) {
        if (r.error) {
            smaRows += `<tr><td colspan="5" style="color:#dc2626;padding:8px 12px">${r.ticker}: ${r.error}</td></tr>`;
            continue;
        }
        const signalsHtml = r.signals.map(s =>
            `<span style="color:${signalColor[s.type] || '#374151'}">${s.text}</span>`
        ).join('<br>');
        smaRows += `
        <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:8px 12px;font-weight:600">${r.ticker}</td>
            <td style="padding:8px 12px">$${r.latestPrice.toFixed(2)}<br><span style="font-size:0.8em;color:#6b7280">${r.latestDate}</span></td>
            <td style="padding:8px 12px">${fmt(r.sma50, 2, '$')}</td>
            <td style="padding:8px 12px">${fmt(r.sma100, 2, '$')}</td>
            <td style="padding:8px 12px;font-size:0.85em;line-height:1.6">${signalsHtml}</td>
        </tr>`;
    }

    // Table 2: Indicators
    let indRows = '';
    for (const r of results) {
        if (r.error) continue;

        const rsiVal  = r.rsi !== null ? r.rsi.toFixed(1) : 'N/A';
        const rsiColor = r.rsi === null ? '#374151' : r.rsi > 70 ? '#dc2626' : r.rsi < 30 ? '#16a34a' : '#374151';

        const macdColor = r.macd ? (r.macd.histogram > 0 ? '#16a34a' : '#dc2626') : '#374151';
        const macdStr   = r.macd ? `${r.macd.macd.toFixed(3)} / ${r.macd.signal.toFixed(3)}` : 'N/A';
        const histStr   = r.macd ? (r.macd.histogram >= 0 ? '+' : '') + r.macd.histogram.toFixed(3) : '';

        const bbStr = r.bb ? `$${r.bb.lower.toFixed(2)} – $${r.bb.upper.toFixed(2)}<br><span style="font-size:0.8em;color:#6b7280">BW: ${r.bb.bandwidth.toFixed(1)}%</span>` : 'N/A';

        const weekColor  = r.mom?.week  >= 0 ? '#16a34a' : '#dc2626';
        const monthColor = r.mom?.month >= 0 ? '#16a34a' : '#dc2626';

        indRows += `
        <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:8px 12px;font-weight:600">${r.ticker}</td>
            <td style="padding:8px 12px;color:${rsiColor};font-weight:600">${rsiVal}</td>
            <td style="padding:8px 12px;color:${macdColor}">${macdStr}<br><span style="font-size:0.8em">${histStr}</span></td>
            <td style="padding:8px 12px;font-size:0.9em">${bbStr}</td>
            <td style="padding:8px 12px;color:${weekColor};font-weight:600">${fmtPct(r.mom?.week)}</td>
            <td style="padding:8px 12px;color:${monthColor};font-weight:600">${fmtPct(r.mom?.month)}</td>
        </tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;color:#111827;max-width:960px;margin:0 auto;padding:20px">
        <h2 style="border-bottom:2px solid #3b82f6;padding-bottom:8px">
            Stock Technical Analysis Digest
        </h2>
        <p style="color:#6b7280;margin-top:4px">${dateStr}</p>

        <h3 style="margin-top:28px;margin-bottom:8px">Moving Averages &amp; Signals</h3>
        <table style="width:100%;border-collapse:collapse">
            <thead>
                <tr style="background:#f3f4f6">
                    <th style="padding:10px 12px;text-align:left">Ticker</th>
                    <th style="padding:10px 12px;text-align:left">Price</th>
                    <th style="padding:10px 12px;text-align:left">SMA-50</th>
                    <th style="padding:10px 12px;text-align:left">SMA-100</th>
                    <th style="padding:10px 12px;text-align:left">Signals</th>
                </tr>
            </thead>
            <tbody>${smaRows}</tbody>
        </table>

        <h3 style="margin-top:28px;margin-bottom:8px">Technical Indicators</h3>
        <table style="width:100%;border-collapse:collapse">
            <thead>
                <tr style="background:#f3f4f6">
                    <th style="padding:10px 12px;text-align:left">Ticker</th>
                    <th style="padding:10px 12px;text-align:left">RSI (14)</th>
                    <th style="padding:10px 12px;text-align:left">MACD / Signal</th>
                    <th style="padding:10px 12px;text-align:left">Bollinger Bands (20)</th>
                    <th style="padding:10px 12px;text-align:left">1-Week</th>
                    <th style="padding:10px 12px;text-align:left">1-Month</th>
                </tr>
            </thead>
            <tbody>${indRows}</tbody>
        </table>

        <p style="margin-top:28px;font-size:0.75em;color:#9ca3af">
            RSI &gt; 70 overbought · RSI &lt; 30 oversold · MACD histogram positive = bullish momentum · Bollinger BW = band width
            <br>Generated by Stock SMA Monitor · GitHub Actions
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
        auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });

    const info = await transporter.sendMail({
        from: `"Stock Monitor" <${EMAIL_USER}>`,
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
    if (!API_KEY || !EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
        console.error('Missing required environment variables. Check ALPHA_VANTAGE_API_KEY, EMAIL_USER, EMAIL_PASS, EMAIL_TO.');
        process.exit(1);
    }

    console.log(`Starting monitor for: ${TICKERS.join(', ')}`);

    const results = [];

    for (let i = 0; i < TICKERS.length; i++) {
        const ticker = TICKERS[i];

        if (i > 0) {
            console.log(`Waiting ${API_RATE_LIMIT_DELAY / 1000}s before next API call...`);
            await new Promise(resolve => setTimeout(resolve, API_RATE_LIMIT_DELAY));
        }

        try {
            const data = await fetchStockData(ticker);
            const analysis = processStockData(data, ticker);
            console.log(`  ${ticker}: $${analysis.latestPrice.toFixed(2)} | RSI: ${analysis.rsi?.toFixed(1) ?? 'N/A'} | MACD hist: ${analysis.macd?.histogram.toFixed(3) ?? 'N/A'} | 1M: ${fmtPct(analysis.mom?.month)}`);
            results.push(analysis);
        } catch (err) {
            console.error(`  ${ticker}: ${err.message}`);
            results.push({ ticker: ticker.toUpperCase(), error: err.message, signals: [] });
        }
    }

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const subject = `Stock Digest — ${dateStr}`;
    const body = buildEmailBody(results);

    console.log('\nSending digest email...');
    await sendEmail(subject, body);
    console.log('Done.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
