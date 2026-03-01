const axios = require('axios');

async function coinonePublic(endpoint) {
  const response = await axios.get(`https://api.coinone.co.kr${endpoint}`, { timeout: 10000 });
  return response.data;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0);
  const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

function calculateMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function analyzeMarket(currency) {
  const data = await coinonePublic(`/trades/?currency=${currency.toLowerCase()}&format=json`);
  const trades = data.completeOrders || [];

  if (trades.length < 20) {
    const tickerData = await coinonePublic(`/public/v2/ticker_new/KRW/${currency}`);
    const ticker = tickerData.tickers?.[0];
    const price = ticker ? parseFloat(ticker.last) : null;
    return { signal: 'HOLD', reason: '체결 데이터 부족', rsi: null, ma20: null, price, currency };
  }

  const prices = trades.map(t => parseFloat(t.price)).reverse();
  const currentPrice = prices[prices.length - 1];
  const rsi = calculateRSI(prices);
  const ma20 = calculateMA(prices, 20);

  return {
    currency,
    price: currentPrice,
    rsi,
    ma20: ma20 ? Math.round(ma20) : null,
    priceVsMa: ma20 ? ((currentPrice - ma20) / ma20 * 100).toFixed(2) : null,
  };
}

async function main() {
  const eth = await analyzeMarket('ETH');
  console.log('ETH Analysis:', eth);

  const sol = await analyzeMarket('SOL');
  console.log('SOL Analysis:', sol);
}

main();
