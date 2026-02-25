// Alpha Vantage API Configuration
const ALPHA_VANTAGE_API_KEY = 'P5T5K4N0QGLMQ40P'; // Replace with your API key from alphavantage.co
const ALPHA_VANTAGE_BASE_URL = 'https://www.alphavantage.co/query';
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
const API_RATE_LIMIT_DELAY = 12000; // 12 seconds between calls
let lastAPICallTime = 0;

// Cache Management Functions
function getCachedData(ticker) {
    const cacheKey = `stock_${ticker}`;
    const cached = localStorage.getItem(cacheKey);

    if (!cached) {
        return null;
    }

    try {
        const { timestamp, data } = JSON.parse(cached);
        const now = Date.now();

        // Check if cache is still valid (within CACHE_DURATION_MS)
        if (now - timestamp < CACHE_DURATION_MS) {
            console.log(`Using cached data for ${ticker}`);
            return data;
        } else {
            console.log(`Cache expired for ${ticker}`);
            localStorage.removeItem(cacheKey);
            return null;
        }
    } catch (error) {
        console.error('Error reading cache:', error);
        localStorage.removeItem(cacheKey);
        return null;
    }
}

function setCachedData(ticker, data) {
    const cacheKey = `stock_${ticker}`;
    const cacheValue = {
        timestamp: Date.now(),
        data: data
    };

    try {
        localStorage.setItem(cacheKey, JSON.stringify(cacheValue));
        console.log(`Cached data for ${ticker}`);
    } catch (error) {
        console.error('Error setting cache:', error);
    }
}

// API Fetch Function
async function fetchStockData(ticker) {
    // Check cache first
    const cachedData = getCachedData(ticker);
    if (cachedData) {
        return cachedData;
    }

    // Rate limiting - wait if necessary
    const now = Date.now();
    const timeSinceLastCall = now - lastAPICallTime;
    if (timeSinceLastCall < API_RATE_LIMIT_DELAY) {
        const waitTime = API_RATE_LIMIT_DELAY - timeSinceLastCall;
        console.log(`Rate limiting: waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Update last API call time
    lastAPICallTime = Date.now();

    // Build API URL
    const url = `${ALPHA_VANTAGE_BASE_URL}?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${ALPHA_VANTAGE_API_KEY}`;

    try {
        console.log(`Fetching data for ${ticker} from Alpha Vantage...`);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error('NETWORK_ERROR');
        }

        const data = await response.json();

        // Error detection
        if (data['Error Message']) {
            console.error('Invalid ticker:', data['Error Message']);
            throw new Error('INVALID_TICKER');
        }

        if (data['Note']) {
            console.error('Rate limit exceeded:', data['Note']);
            throw new Error('RATE_LIMIT');
        }

        if (data['Information']) {
            console.error('API key error:', data['Information']);
            throw new Error('API_KEY_ERROR');
        }

        const timeSeries = data['Time Series (Daily)'];
        if (!timeSeries || Object.keys(timeSeries).length === 0) {
            console.error('No data available for ticker:', ticker);
            throw new Error('NO_DATA');
        }

        // Cache successful response
        setCachedData(ticker, data);

        return data;

    } catch (error) {
        console.error('Error fetching stock data:', error);
        if (error.message.startsWith('INVALID_TICKER') ||
            error.message.startsWith('RATE_LIMIT') ||
            error.message.startsWith('API_KEY_ERROR') ||
            error.message.startsWith('NO_DATA')) {
            throw error;
        }
        throw new Error('NETWORK_ERROR');
    }
}

// SMA Calculation Functions
function calculateSMA(prices, period) {
    if (prices.length < period) {
        return null;
    }

    const sum = prices.slice(0, period).reduce((acc, price) => acc + price, 0);
    return sum / period;
}

function processStockData(data, ticker) {
    const timeSeries = data['Time Series (Daily)'];
    const dates = Object.keys(timeSeries).sort((a, b) => new Date(b) - new Date(a));

    // Get latest price and date
    const latestDate = dates[0];
    const latestPrice = parseFloat(timeSeries[latestDate]['4. close']);

    // Extract closing prices (newest first)
    const closingPrices = dates.map(date => parseFloat(timeSeries[date]['4. close']));

    // Calculate SMAs
    const sma50 = calculateSMA(closingPrices, 50);
    const sma200 = calculateSMA(closingPrices, 200);

    // Generate technical signals
    const signals = [];

    // Check data freshness
    const latestDateObj = new Date(latestDate);
    const today = new Date();
    const daysDiff = Math.floor((today - latestDateObj) / (1000 * 60 * 60 * 24));

    if (daysDiff > 3) {
        signals.push({
            text: `Warning: Data is ${daysDiff} days old. Market may be closed or data is stale.`,
            type: 'warning'
        });
    }

    // Price vs 50-day SMA
    if (sma50 !== null) {
        const diffPercent = ((latestPrice - sma50) / sma50 * 100).toFixed(2);
        if (latestPrice > sma50) {
            signals.push({
                text: `Price is ${Math.abs(diffPercent)}% above 50-day SMA ($${sma50.toFixed(2)}) - Bullish`,
                type: 'bullish'
            });
        } else {
            signals.push({
                text: `Price is ${Math.abs(diffPercent)}% below 50-day SMA ($${sma50.toFixed(2)}) - Bearish`,
                type: 'bearish'
            });
        }
    } else {
        signals.push({
            text: `Insufficient data for 50-day SMA (need 50 days, have ${closingPrices.length})`,
            type: 'warning'
        });
    }

    // Price vs 200-day SMA
    if (sma200 !== null) {
        const diffPercent = ((latestPrice - sma200) / sma200 * 100).toFixed(2);
        if (latestPrice > sma200) {
            signals.push({
                text: `Price is ${Math.abs(diffPercent)}% above 200-day SMA ($${sma200.toFixed(2)}) - Bullish`,
                type: 'bullish'
            });
        } else {
            signals.push({
                text: `Price is ${Math.abs(diffPercent)}% below 200-day SMA ($${sma200.toFixed(2)}) - Bearish`,
                type: 'bearish'
            });
        }
    } else {
        signals.push({
            text: `Insufficient data for 200-day SMA (need 200 days, have ${closingPrices.length}). Consider fetching full dataset.`,
            type: 'warning'
        });
    }

    // Golden Cross / Death Cross
    if (sma50 !== null && sma200 !== null) {
        if (sma50 > sma200) {
            signals.push({
                text: 'Golden Cross: 50-day SMA is above 200-day SMA - Bullish',
                type: 'bullish'
            });
        } else {
            signals.push({
                text: 'Death Cross: 50-day SMA is below 200-day SMA - Bearish',
                type: 'bearish'
            });
        }
    }

    return {
        ticker: ticker.toUpperCase(),
        latestDate: latestDate,
        latestPrice: latestPrice,
        sma50: sma50,
        sma200: sma200,
        signals: signals,
        dataPoints: closingPrices.length
    };
}

// File Handle Storage
let fileHandle = null;

// File Export Functions
async function saveToFile(ticker, currentPrice, sma50) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Create the line to append
    const newLine = `${timestamp} | Ticker: ${ticker} | Current Price: $${currentPrice.toFixed(2)} | 50-Day SMA: ${sma50 !== null ? '$' + sma50.toFixed(2) : 'N/A'}\n`;

    // Check if File System Access API is supported
    if ('showSaveFilePicker' in window) {
        try {
            // If we don't have a file handle yet, get one
            if (!fileHandle) {
                fileHandle = await window.showSaveFilePicker({
                    suggestedName: 'output.txt',
                    types: [{
                        description: 'Text Files',
                        accept: { 'text/plain': ['.txt'] }
                    }]
                });

                // If this is a new file, write header
                const writable = await fileHandle.createWritable();
                await writable.write('Stock Analysis Search History\n');
                await writable.write('='.repeat(80) + '\n');
                await writable.write(newLine);
                await writable.close();
                console.log('Created output.txt and saved first entry');
            } else {
                // Append to existing file
                const file = await fileHandle.getFile();
                const existingContent = await file.text();

                const writable = await fileHandle.createWritable();
                await writable.write(existingContent + newLine);
                await writable.close();
                console.log('Appended search data to output.txt');
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('File selection cancelled by user');
            } else {
                console.error('Error saving to file:', error);
                alert('Error saving to file: ' + error.message);
            }
        }
    } else {
        // Fallback for browsers that don't support File System Access API
        console.warn('File System Access API not supported, falling back to download');
        fallbackSaveToFile(ticker, currentPrice, sma50, timestamp, newLine);
    }
}

// Fallback function for browsers without File System Access API
function fallbackSaveToFile(ticker, currentPrice, sma50, timestamp, newLine) {
    // Get existing data from localStorage
    let searchHistory = [];
    try {
        const stored = localStorage.getItem('search_history');
        if (stored) {
            searchHistory = JSON.parse(stored);
        }
    } catch (error) {
        console.error('Error reading search history:', error);
    }

    // Add new entry
    const newEntry = {
        timestamp: timestamp,
        ticker: ticker,
        currentPrice: currentPrice,
        sma50: sma50
    };
    searchHistory.push(newEntry);

    // Save updated history to localStorage
    try {
        localStorage.setItem('search_history', JSON.stringify(searchHistory));
    } catch (error) {
        console.error('Error saving search history:', error);
    }

    // Create text file content with all history
    let fileContent = 'Stock Analysis Search History\n';
    fileContent += '='.repeat(80) + '\n';

    searchHistory.forEach(entry => {
        fileContent += `${entry.timestamp} | Ticker: ${entry.ticker} | Current Price: $${entry.currentPrice.toFixed(2)} | 50-Day SMA: ${entry.sma50 !== null ? '$' + entry.sma50.toFixed(2) : 'N/A'}\n`;
    });

    // Create a blob and trigger download
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'output.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('Search data downloaded as output.txt (fallback mode)');
}

// UI Display Functions
function showLoading(ticker) {
    const loadingContainer = document.getElementById('loadingContainer');
    const loadingMessage = document.getElementById('loadingMessage');
    const resultsContainer = document.getElementById('resultsContainer');
    const tickerInput = document.getElementById('tickerInput');
    const enterButton = document.getElementById('enterButton');

    loadingMessage.textContent = `Fetching data for ${ticker.toUpperCase()}...`;
    loadingContainer.classList.remove('hidden');
    resultsContainer.classList.add('hidden');

    // Disable input during loading
    tickerInput.disabled = true;
    enterButton.disabled = true;
}

function hideLoading() {
    const loadingContainer = document.getElementById('loadingContainer');
    const tickerInput = document.getElementById('tickerInput');
    const enterButton = document.getElementById('enterButton');

    loadingContainer.classList.add('hidden');

    // Re-enable input
    tickerInput.disabled = false;
    enterButton.disabled = false;
}

function displayResults(analysis) {
    const resultsContainer = document.getElementById('resultsContainer');
    const resultTicker = document.getElementById('resultTicker');
    const currentPrice = document.getElementById('currentPrice');
    const priceDate = document.getElementById('priceDate');
    const sma50 = document.getElementById('sma50');
    const sma50Status = document.getElementById('sma50Status');
    const sma200 = document.getElementById('sma200');
    const sma200Status = document.getElementById('sma200Status');
    const technicalSignals = document.getElementById('technicalSignals');

    // Populate results
    resultTicker.textContent = analysis.ticker;
    currentPrice.textContent = `$${analysis.latestPrice.toFixed(2)}`;
    priceDate.textContent = `As of ${analysis.latestDate}`;

    // 50-day SMA
    if (analysis.sma50 !== null) {
        sma50.textContent = `$${analysis.sma50.toFixed(2)}`;
        const diff50 = ((analysis.latestPrice - analysis.sma50) / analysis.sma50 * 100).toFixed(2);
        if (analysis.latestPrice > analysis.sma50) {
            sma50Status.textContent = `${Math.abs(diff50)}% above`;
            sma50Status.className = 'sma-status bullish';
        } else {
            sma50Status.textContent = `${Math.abs(diff50)}% below`;
            sma50Status.className = 'sma-status bearish';
        }
    } else {
        sma50.textContent = 'N/A';
        sma50Status.textContent = 'Insufficient data';
        sma50Status.className = 'sma-status warning';
    }

    // 200-day SMA
    if (analysis.sma200 !== null) {
        sma200.textContent = `$${analysis.sma200.toFixed(2)}`;
        const diff200 = ((analysis.latestPrice - analysis.sma200) / analysis.sma200 * 100).toFixed(2);
        if (analysis.latestPrice > analysis.sma200) {
            sma200Status.textContent = `${Math.abs(diff200)}% above`;
            sma200Status.className = 'sma-status bullish';
        } else {
            sma200Status.textContent = `${Math.abs(diff200)}% below`;
            sma200Status.className = 'sma-status bearish';
        }
    } else {
        sma200.textContent = 'N/A';
        sma200Status.textContent = 'Insufficient data';
        sma200Status.className = 'sma-status warning';
    }

    // Technical signals
    technicalSignals.innerHTML = '';
    analysis.signals.forEach(signal => {
        const li = document.createElement('li');
        li.textContent = signal.text;
        li.className = signal.type;
        technicalSignals.appendChild(li);
    });

    // Show results
    resultsContainer.classList.remove('hidden');

    // Smooth scroll to results
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function displayError(errorType, ticker) {
    const resultsContainer = document.getElementById('resultsContainer');
    resultsContainer.innerHTML = '';

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-container';

    let errorTitle = 'Error';
    let errorMessage = 'An error occurred while fetching stock data.';

    switch (errorType) {
        case 'INVALID_TICKER':
            errorTitle = 'Ticker Not Found';
            errorMessage = `The ticker symbol "${ticker.toUpperCase()}" was not found. Please check the symbol and try again.`;
            break;
        case 'RATE_LIMIT':
            errorTitle = 'Rate Limit Exceeded';
            errorMessage = 'Too many requests. Alpha Vantage free tier allows 25 requests per day. Please wait and try again later.';
            break;
        case 'API_KEY_ERROR':
            errorTitle = 'API Key Error';
            errorMessage = 'There is an issue with the API key configuration. Please check that you have entered a valid Alpha Vantage API key in script.js.';
            break;
        case 'NO_DATA':
            errorTitle = 'No Data Available';
            errorMessage = `No data is available for "${ticker.toUpperCase()}". This ticker may not be supported by Alpha Vantage.`;
            break;
        case 'NETWORK_ERROR':
            errorTitle = 'Connection Error';
            errorMessage = 'Failed to connect to Alpha Vantage. Please check your internet connection and try again.';
            break;
    }

    errorDiv.innerHTML = `
        <h3>${errorTitle}</h3>
        <p>${errorMessage}</p>
        <button id="newAnalysisButton">Try Another Ticker</button>
    `;

    resultsContainer.appendChild(errorDiv);
    resultsContainer.classList.remove('hidden');
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetForm() {
    const resultsContainer = document.getElementById('resultsContainer');
    const tickerInput = document.getElementById('tickerInput');
    const validationMessage = document.getElementById('validationMessage');

    resultsContainer.classList.add('hidden');
    tickerInput.value = '';
    validationMessage.textContent = '';
    validationMessage.className = 'validation-message empty';
    tickerInput.classList.remove('error', 'success');
    tickerInput.focus();
}

document.addEventListener('DOMContentLoaded', function() {
    const tickerInput = document.getElementById('tickerInput');
    const enterButton = document.getElementById('enterButton');
    const validationMessage = document.getElementById('validationMessage');

    // Validate ticker - only English alphabet characters
    function validateTicker(ticker) {
        // Remove whitespace
        ticker = ticker.trim();

        // Check if empty
        if (ticker.length === 0) {
            return {
                valid: false,
                message: 'Please enter a stock ticker'
            };
        }

        // Check if only English alphabet characters (A-Z, a-z)
        const alphabetOnlyRegex = /^[A-Za-z]+$/;
        if (!alphabetOnlyRegex.test(ticker)) {
            return {
                valid: false,
                message: 'Ticker must contain only English alphabet characters (A-Z)'
            };
        }

        // Check minimum length
        if (ticker.length < 1) {
            return {
                valid: false,
                message: 'Ticker must be at least 1 character long'
            };
        }

        // Check maximum length (most US tickers are 1-5 characters)
        if (ticker.length > 5) {
            return {
                valid: true,
                message: 'Valid ticker entered'
            };
        }

        return {
            valid: true,
            message: 'Valid ticker entered'
        };
    }

    // Display validation message
    function displayValidation(result) {
        validationMessage.textContent = result.message;
        validationMessage.className = 'validation-message';

        if (result.message === '') {
            validationMessage.classList.add('empty');
        } else if (result.valid) {
            validationMessage.classList.add('success');
            tickerInput.classList.remove('error');
            tickerInput.classList.add('success');
            enterButton.disabled = false;
        } else {
            validationMessage.classList.add('error');
            tickerInput.classList.remove('success');
            tickerInput.classList.add('error');
            enterButton.disabled = true;
        }
    }

    // Real-time validation as user types
    tickerInput.addEventListener('input', function(e) {
        // Convert to uppercase automatically
        this.value = this.value.toUpperCase();

        const ticker = this.value;

        if (ticker.length === 0) {
            validationMessage.textContent = '';
            validationMessage.className = 'validation-message empty';
            tickerInput.classList.remove('error', 'success');
            enterButton.disabled = false;
            return;
        }

        const result = validateTicker(ticker);
        displayValidation(result);
    });

    // Handle Enter key press in input
    tickerInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            enterButton.click();
        }
    });

    // Handle button click
    enterButton.addEventListener('click', function() {
        const ticker = tickerInput.value.trim();

        if (ticker.length === 0) {
            displayValidation({
                valid: false,
                message: 'Please enter a stock ticker'
            });
            return;
        }

        const result = validateTicker(ticker);

        if (result.valid) {
            showLoading(ticker);

            fetchStockData(ticker)
                .then(data => {
                    const analysis = processStockData(data, ticker);
                    hideLoading();
                    displayResults(analysis);

                    // Save ticker data to file
                    saveToFile(analysis.ticker, analysis.latestPrice, analysis.sma50);
                })
                .catch(error => {
                    hideLoading();
                    const errorType = error.message || 'NETWORK_ERROR';
                    displayError(errorType, ticker);
                });
        } else {
            displayValidation(result);
        }
    });

    // Initial state
    enterButton.disabled = false;

    // Event delegation for dynamically created buttons
    document.addEventListener('click', function(e) {
        if (e.target && e.target.id === 'newAnalysisButton') {
            resetForm();
        }
    });
});
