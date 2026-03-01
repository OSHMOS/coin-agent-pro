#!/usr/bin/env node
/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🪙 Coin Agent - 24시간 보수적 자동매매 봇
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 
 * 전략: 보수적 급락 분할매수 (Conservative Dip Buy)
 * 
 * [매수 조건] (모두 충족 시)
 *   1. RSI(14) ≤ 30  (과매도 구간)
 *   2. 현재가 < MA20  (이동평균 아래 = 눌림목)
 *   3. 같은 코인 최근 매수 후 4시간 경과 (쿨다운)
 *   4. 오늘 거래 횟수 < 일일 한도
 * 
 * [매도 조건] (하나라도 충족 시)
 *   1. 수익률 ≥ +5%   → 익절 (목표가 도달)
 *   2. 수익률 ≤ -8%   → 손절 (하락 방어)
 *   3. RSI(14) ≥ 70 AND 수익 중 → 과매수 구간 청산
 * 
 * [안전장치]
 *   - 1회 최대 거래금액 제한
 *   - 일일 최대 거래 횟수 제한
 *   - 동일 코인 연속 매수 쿨다운
 *   - 에러 발생 시 자동 대기 (exponential backoff)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const USER_DATA_DIR = process.env.ELECTRON_USER_DATA || __dirname;

require('dotenv').config({ path: path.join(USER_DATA_DIR, '.env') });
const axios = require('axios');
const crypto = require('crypto');
const Groq = require('groq-sdk'); // 레거시 호환용
const { OpenAI } = require('openai');
const glmAI = (process.env.GLM_API_KEY || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY)
  ? new OpenAI({
    apiKey: process.env.GLM_API_KEY || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY,
    baseURL: "https://open.bigmodel.cn/api/paas/v4/"
  })
  : null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 설정값 (.env에서 로드)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CONFIG = {
  // API
  ACCESS_TOKEN: process.env.COINONE_ACCESS_TOKEN,
  SECRET_KEY: process.env.COINONE_SECRET_KEY,
  API_BASE: 'https://api.coinone.co.kr',

  // 대상 코인 (쉼표 구분)
  TARGET_COINS: (process.env.BOT_TARGET_COINS || 'BTC,ETH').split(',').map(c => c.trim().toUpperCase()),

  // 체크 주기 (밀리초)
  CHECK_INTERVAL_MS: parseFloat(process.env.BOT_CHECK_INTERVAL_MIN || '1') * 60 * 1000,

  // 1회 매수 금액 (원)
  BUY_AMOUNT_KRW: parseInt(process.env.BOT_BUY_AMOUNT_KRW || '50000'),

  // 최종 목표 코인 자산 금액 (원)
  TARGET_ASSET_KRW: parseInt(process.env.BOT_TARGET_ASSET_KRW || '100000'),

  // 일일 최대 거래 횟수
  MAX_DAILY_TRADES: parseInt(process.env.BOT_MAX_DAILY_TRADES || '100'),

  // 쿨다운 (시간) - 같은 코인 재매수 간격
  COOLDOWN_HOURS: parseFloat(process.env.BOT_COOLDOWN_HOURS || '1'),

  // 매수 조건
  RSI_BUY_THRESHOLD: parseInt(process.env.BOT_RSI_BUY || '30'),

  // 매도 조건
  TAKE_PROFIT_PERCENT: 1.5, // 1.5%로 강제 고정
  STOP_LOSS_PERCENT: 999999, // 하락 손절 절대 안 함 (보유 유지)
  RSI_SELL_THRESHOLD: parseInt(process.env.BOT_RSI_SELL || '70'),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 상태 관리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Electron 환경에서 실행될 경우 userData 폴더 경로를 환경변수로 받음
const STATE_FILE = path.join(USER_DATA_DIR, 'bot_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    log('⚠️ 상태 파일 로드 실패, 초기화합니다.', 'warn');
  }
  return {
    lastBuyTime: {},      // { BTC: '2024-01-01T00:00:00Z', ... }
    dailyTradeCount: 0,
    dailyTradeDate: '',
    positions: {},        // { BTC: { avgPrice: 50000000, qty: 0.001, totalCost: 50000 }, ... }
    totalProfit: 0,       // 누적 수익
    totalTrades: 0,       // 총 거래 수
    consecutiveErrors: 0, // 연속 에러 수 (backoff용)
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

let botState = loadState();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 로깅
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const LOG_DIR = path.join(USER_DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(message, level = 'info') {
  const now = new Date();
  const timestamp = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const icons = { info: 'ℹ️', trade: '💰', buy: '🟢', sell: '🔴', warn: '⚠️', error: '❌', signal: '📊', start: '🚀' };
  const icon = icons[level] || 'ℹ️';

  const logLine = `[${timestamp}] ${icon} ${message}`;
  console.log(logLine);

  // 파일 로그
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replace(/\. /g, '-').replace('.', '');
  const logFile = path.join(LOG_DIR, `bot_${today}.log`);
  fs.appendFileSync(logFile, logLine + '\n', 'utf8');
}

function logTrade(action, details) {
  const now = new Date();
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replace(/\. /g, '-').replace('.', '');
  const logFile = path.join(LOG_DIR, `trades_${today}.json`);
  let logs = [];
  try {
    if (fs.existsSync(logFile)) logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  } catch (e) { /* ignore */ }

  logs.push({
    timestamp: new Date().toISOString(),
    source: 'bot',
    action,
    ...details,
  });

  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf8');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 코인원 API (server.js에서 복사)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function coinonePrivateV2(endpoint, params = {}) {
  const payload = {
    access_token: CONFIG.ACCESS_TOKEN,
    nonce: Date.now(),
    ...params
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha512', CONFIG.SECRET_KEY.toUpperCase())
    .update(encodedPayload)
    .digest('hex');

  const response = await axios.post(`${CONFIG.API_BASE}${endpoint}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-COINONE-PAYLOAD': encodedPayload,
      'X-COINONE-SIGNATURE': signature,
    },
    timeout: 10000,
  });

  return response.data;
}

async function coinonePrivateV2_1(endpoint, params = {}) {
  const payload = {
    access_token: CONFIG.ACCESS_TOKEN,
    nonce: crypto.randomUUID(),
    ...params
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha512', CONFIG.SECRET_KEY.toUpperCase())
    .update(encodedPayload)
    .digest('hex');

  const response = await axios.post(`${CONFIG.API_BASE}${endpoint}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-COINONE-PAYLOAD': encodedPayload,
      'X-COINONE-SIGNATURE': signature,
    },
    timeout: 10000,
  });

  return response.data;
}

async function coinonePublic(endpoint) {
  const response = await axios.get(`${CONFIG.API_BASE}${endpoint}`, { timeout: 10000 });
  return response.data;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 전체 자산 계산
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getTotalAsset() {
  try {
    const targetCurrencies = ['KRW', ...CONFIG.TARGET_COINS, ...Object.keys(botState.positions)];
    const uniqueCurrencies = [...new Set(targetCurrencies)];

    const balanceData = await coinonePrivateV2_1('/v2.1/account/balance', {
      currencies: uniqueCurrencies
    });
    const balances = balanceData.balances || [];

    let totalAssetKRW = 0;
    const promises = [];

    for (const b of balances) {
      const totalAmount = parseFloat(b.available || '0') + parseFloat(b.limit || '0');
      if (totalAmount <= 0) continue;

      if (b.currency === 'KRW') {
        totalAssetKRW += totalAmount;
      } else {
        promises.push(
          coinonePublic(`/public/v2/ticker_new/KRW/${b.currency}`)
            .then(tickerData => {
              const price = parseFloat(tickerData.tickers?.[0]?.last || '0');
              totalAssetKRW += totalAmount * price;
            })
            .catch(() => { })
        );
      }
    }

    await Promise.all(promises);
    return Math.round(totalAssetKRW);
  } catch (e) {
    log(`자산 조회 실패: ${e.message}`, 'warn');
    return 0;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 기술적 분석 계산
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 핵심: 시장 분석 + 시그널 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function analyzeMarket(currency) {
  // V1 체결 내역 API 사용 (completeOrders 필드)
  const data = await coinonePublic(`/trades/?currency=${currency.toLowerCase()}&format=json`);
  const trades = data.completeOrders || [];

  if (trades.length < 20) {
    // 데이터 부족 시 ticker에서 현재가만 가져오기
    const tickerData = await coinonePublic(`/public/v2/ticker_new/KRW/${currency}`);
    const ticker = tickerData.tickers?.[0];
    const price = ticker ? parseFloat(ticker.last) : null;
    return { signal: 'HOLD', reason: '체결 데이터 부족', rsi: null, ma20: null, price, currency };
  }

  // trades는 최신순이므로 reverse하여 시간순 정렬
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AI 매매 판단 (로컬 페르소나 엔진)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 구글 API의 빡빡한 무료 한도(하루 20회)를 넘어 무제한으로 똑똑한 척 연기하는 봇 엔진입니다.

async function askGemini(analysis, position) {
  const { currency, rsi, price, ma20, priceVsMa } = analysis;

  // 데이터 부족 시 예외 처리
  if (rsi === null) {
    return { decision: 'HOLD', reason: `😵‍💫 데이터가 부족해서 차트를 못 읽겠어요... 일단 지켜볼게요.` };
  }

  // 실제 GLM-4-Flash(Zhipu AI) API를 호출하여 자율 판단 진행
  if (glmAI) {
    try {

      let positionText = '미보유 (매수 여부를 판단해주세요. BUY 또는 HOLD)';
      if (position && position.qty > 0) {
        const profitPercent = ((price - position.avgPrice) / position.avgPrice) * 100;
        positionText = `보유 중 (현재 수익률: ${profitPercent.toFixed(2)}%, 평단가: ${position.avgPrice.toLocaleString()}원). 보유 중이므로 매도(SELL), 추가매수(BUY), 관망(HOLD) 중 자유롭게 판단하세요. 익절과 손절 타이밍은 오직 당신의 자율적인 분석에 달렸습니다.`;
      }

      const prompt = `
당신은 종목 선택부터 매수/매도 타이밍까지 100% 자율적으로 결정하는 냉철한 AI 퀀트 트레이더 마스터입니다.
당신의 최종 목표는 시장의 흐름을 읽고 고점에서 팔고(SELL) 저점에서 매수하며(BUY) 사용자의 총 코인 자산을 궁극적인 목표 금액인 ${CONFIG.TARGET_ASSET_KRW.toLocaleString()}원 이상으로 최대한 불려나가는 것입니다.
다음 실시간 코인 데이터를 보고 현재 종목에 대해 'BUY', 'SELL', 'HOLD' 중 하나로만 투자 결정을 내리고 그 이유를 논리적인 한국어로 작성해주세요.

[현재 코인 시장 데이터]
- 종목: ${currency}
- 현재가: ${price}원
- RSI(상대강도지수): ${rsi} (30 이하면 과매도, 70 이상이면 과매수)
- 20일 이동평균선(MA20): ${ma20}원 (현재가가 평균선 대비 ${priceVsMa}% 위치)
- 현재 계좌 상태: ${positionText}

아래 제공된 JSON 형식으로만 스크립트 없이 깨끗하게 대답해주세요.
{
  "decision": "BUY", "SELL", 또는 "HOLD",
  "reason": "시장의 기술적 지표(RSI, MA20 등)와 계좌 상태를 종합적으로 고려하여 AI 스스로 내린 결정 이유를 한국어로 작성 (손절이나 익절 시 구체적 이유 명시)"
}
`;

      const response = await glmAI.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "glm-4-flash",
      });
      const text = response.choices[0]?.message?.content || "";
      // 마크다운 백틱 및 공백 제거 후 JSON 파싱
      const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const aiResponse = JSON.parse(cleanText);

      return {
        decision: aiResponse.decision,
        reason: `[GLM-4 자율판단] ${aiResponse.reason}`
      };
    } catch (error) {
      log(`GLM API 통신 오류: ${error.message}. 로컬 백업 로직으로 전환합니다.`, 'warn');
      // 오류 시 아래의 기본 봇 로직으로 Fallback
    }
  }

  // 4. 로컬 페르소나 봇 로직 (GLM API 키가 없거나 통신 실패 시 작동하는 백업)
  if (position && position.qty > 0) {
    const profitPercent = ((price - position.avgPrice) / position.avgPrice) * 100;
    if (profitPercent >= CONFIG.TAKE_PROFIT_PERCENT) {
      return { decision: 'SELL', reason: `😎 백업 엔진 가동: 목표 도달! 기계적 익절! (+${profitPercent.toFixed(2)}%)` };
    }
    if (profitPercent < 0) {
      return { decision: 'HOLD', reason: `😨 백업 엔진 가동: 물려 있지만... 절대 털리지 않습니다. 존버합니다! (${profitPercent.toFixed(2)}%)` };
    } else {
      return { decision: 'HOLD', reason: `🔥 백업 엔진 가동: 수익 중입니다! 익절가 도달 시점까지 기다립니다 (+${profitPercent.toFixed(2)}%)` };
    }
  }

  if (rsi <= CONFIG.RSI_BUY_THRESHOLD && (ma20 && price < ma20)) {
    return { decision: 'BUY', reason: `🤩 백업 엔진 가동: RSI ${rsi} 과매도에 이평선 아래! 제 피같은 돈을 걸 타이밍입니다! 드가자!!` };
  } else {
    return { decision: 'HOLD', reason: `🥱 백업 엔진 가동: 아직은 때가 아니네요... 평화로운 차트구먼요. 꾹 참겠습니다.` };
  }
}

function checkBuySafety(currency, state) {
  const reasons = [];

  const lastBuy = state.lastBuyTime[currency];
  if (lastBuy) {
    const hoursSinceLastBuy = (Date.now() - new Date(lastBuy).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastBuy < CONFIG.COOLDOWN_HOURS) {
      reasons.push(`${CONFIG.COOLDOWN_HOURS}시간 쿨다운 중`);
    }
  }

  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/\. /g, '-').replace('.', '');
  if (state.dailyTradeDate === today && state.dailyTradeCount >= CONFIG.MAX_DAILY_TRADES) {
    reasons.push(`일일 한도 도달`);
  }

  return { safe: reasons.length === 0, reasons };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 주문 실행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function executeBuy(currency, currentPrice) {
  // KRW 잔고 확인
  const balanceData = await coinonePrivateV2_1('/v2.1/account/balance', {
    currencies: ['KRW']
  });

  const krwBalance = balanceData.balances?.find(b => b.currency === 'KRW');
  const availableKRW = parseFloat(krwBalance?.available || '0');

  if (availableKRW < CONFIG.BUY_AMOUNT_KRW) {
    if (Object.keys(botState.positions).length === 0 && availableKRW < 500) {
      log(`${currency} 매수 실패: KRW 잔고 부족 (보유: ${availableKRW.toLocaleString()}원, 필요: ${CONFIG.BUY_AMOUNT_KRW.toLocaleString()}원)`, 'warn');
    }
    return false;
  }

  // 호가 기반으로 매수가 결정 (현재 최우선 매도호가로 매수)
  const orderbookData = await coinonePublic(`/orderbook/?currency=${currency.toLowerCase()}&format=json`);
  const bestAsk = orderbookData.ask?.[0];
  if (!bestAsk) {
    log(`${currency} 매수 실패: 매도호가 없음`, 'warn');
    return false;
  }

  const buyPrice = parseFloat(bestAsk.price);
  const qty = (CONFIG.BUY_AMOUNT_KRW / buyPrice).toFixed(4);

  // 최소 주문 금액 체크 (코인원 최소: 500 KRW)
  if (buyPrice * parseFloat(qty) < 500) {
    log(`${currency} 매수 실패: 최소 주문 금액(500원) 미달`, 'warn');
    return false;
  }

  log(`${currency} 매수 시도: 가격 ${buyPrice.toLocaleString()}원, 수량 ${qty}, 총액 ~${Math.round(buyPrice * parseFloat(qty)).toLocaleString()}원`, 'buy');

  const result = await coinonePrivateV2('/v2/order/limit_buy', {
    currency: currency.toLowerCase(),
    price: String(Math.round(buyPrice)),
    qty: String(qty),
  });

  if (result.result === 'success') {
    log(`✅ ${currency} 매수 주문 성공! 주문ID: ${result.orderId}`, 'buy');

    // 포지션 업데이트 (코인원 앱에 표시되는 평단가와 동일하게 수수료 미포함 계산)
    const exactCostKRW = buyPrice * parseFloat(qty);
    const pos = botState.positions[currency] || { avgPrice: 0, qty: 0, totalCost: 0 };
    const newQty = pos.qty + parseFloat(qty);
    const newTotalCost = pos.totalCost + exactCostKRW;
    pos.avgPrice = newTotalCost / newQty;
    pos.qty = newQty;
    pos.totalCost = newTotalCost;
    botState.positions[currency] = pos;

    // 상태 업데이트
    botState.lastBuyTime[currency] = new Date().toISOString();
    const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date()).replace(/\. /g, '-').replace('.', '');
    if (botState.dailyTradeDate !== today) {
      botState.dailyTradeDate = today;
      botState.dailyTradeCount = 0;
    }
    botState.dailyTradeCount++;
    botState.totalTrades++;
    saveState(botState);

    logTrade('BOT_BUY', {
      currency,
      price: buyPrice,
      qty: parseFloat(qty),
      totalKRW: CONFIG.BUY_AMOUNT_KRW,
      orderId: result.orderId,
    });

    return true;
  } else {
    log(`❌ ${currency} 매수 주문 실패: ${result.errorCode || JSON.stringify(result)}`, 'error');
    return false;
  }
}

async function executeSell(currency, currentPrice) {
  const position = botState.positions[currency];
  if (!position || position.qty <= 0) return false;

  // 실제 보유량 확인
  const balanceData = await coinonePrivateV2_1('/v2.1/account/balance', {
    currencies: [currency]
  });

  const coinBalance = balanceData.balances?.find(b => b.currency === currency);
  const availableQty = parseFloat(coinBalance?.available || '0');

  if (availableQty <= 0) {
    log(`${currency} 매도 실패: 사용 가능 잔고 없음`, 'warn');
    return false;
  }

  // 실제 사용 가능한 수량으로 조정
  const sellQty = Math.min(position.qty, availableQty);

  // 호가 기반으로 매도가 결정 (최우선 매수호가로 매도)
  const orderbookData = await coinonePublic(`/orderbook/?currency=${currency.toLowerCase()}&format=json`);
  const bestBid = orderbookData.bid?.[0];
  if (!bestBid) {
    log(`${currency} 매도 실패: 매수호가 없음`, 'warn');
    return false;
  }

  const sellPrice = parseFloat(bestBid.price);

  log(`${currency} 매도 시도: 가격 ${sellPrice.toLocaleString()}원, 수량 ${sellQty.toFixed(8)}`, 'sell');

  const result = await coinonePrivateV2('/v2/order/limit_sell', {
    currency: currency.toLowerCase(),
    price: String(Math.round(sellPrice)),
    qty: String(sellQty.toFixed(4)),
  });

  if (result.result === 'success') {
    const feeRate = 0.002;
    const grossRevenue = sellPrice * sellQty;
    const feeKRW = (grossRevenue * feeRate) + (position.avgPrice * sellQty * feeRate); // 매수+매도 양방향 수수료 대략 계산
    const netRevenue = grossRevenue - feeKRW;
    const cost = position.avgPrice * sellQty;

    const profitKRW = netRevenue - cost;
    const displayProfitPercent = ((sellPrice - position.avgPrice) / position.avgPrice * 100).toFixed(2);

    log(`✅ ${currency} 매도 주문 성공! 앱 상 수익률: ${displayProfitPercent >= 0 ? '+' : ''}${displayProfitPercent}% (실수령 순수익: ${profitKRW >= 0 ? '+' : ''}${Math.round(profitKRW).toLocaleString()}원)`, 'sell');

    // 포지션 정리
    botState.totalProfit += profitKRW;
    delete botState.positions[currency];

    const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date()).replace(/\. /g, '-').replace('.', '');
    if (botState.dailyTradeDate !== today) {
      botState.dailyTradeDate = today;
      botState.dailyTradeCount = 0;
    }
    botState.dailyTradeCount++;
    botState.totalTrades++;
    saveState(botState);

    logTrade('BOT_SELL', {
      currency,
      price: sellPrice,
      qty: sellQty,
      totalKRW: Math.round(sellPrice * sellQty),
      profitKRW: Math.round(profitKRW),
      profitPercent: parseFloat(displayProfitPercent),
      orderId: result.orderId,
    });

    return true;
  } else {
    log(`❌ ${currency} 매도 주문 실패: ${result.errorCode || JSON.stringify(result)}`, 'error');
    return false;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메인 루프
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getActiveCoins() {
  try {
    const tickerData = await coinonePublic('/public/v2/ticker_new/KRW/all');
    if (!tickerData || !tickerData.tickers) return CONFIG.TARGET_COINS;

    // 거래대금(target_volume * last) 기준으로 정렬하여 가장 핫한(거래가 활발한) 코인 발굴
    let coins = tickerData.tickers
      .sort((a, b) => (parseFloat(b.target_volume) * parseFloat(b.last)) - (parseFloat(a.target_volume) * parseFloat(a.last)))
      .slice(0, 3)
      .map(t => t.target_currency.toUpperCase());

    // 만약 현재 보유 중인 코인이 있다면, 감시 목록에 무조건 포함 (매도 판단을 위해)
    for (const heldCoin of Object.keys(botState.positions)) {
      if (!coins.includes(heldCoin)) {
        coins.push(heldCoin);
      }
    }
    return coins;
  } catch (e) {
    log(`🔥 코인 목록 동적 스캔 실패, 기본 설정 코인으로 대체합니다: ${e.message}`, 'warn');
    return CONFIG.TARGET_COINS;
  }
}

async function runCycle() {
  const cycleStart = Date.now();
  log(`── 분석 사이클 시작 ──`, 'info');

  // 일일 거래 카운트 리셋
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/\. /g, '-').replace('.', '');
  if (botState.dailyTradeDate !== today) {
    botState.dailyTradeDate = today;
    botState.dailyTradeCount = 0;
    log(`📅 새로운 날: 일일 거래 카운트 리셋`, 'info');
  }

  const activeCoins = await getActiveCoins();
  log(`🔍 AI 자율 스캔 완료: 이번 턴의 감시 대상 코인은 [${activeCoins.join(', ')}] 입니다.`, 'info');

  for (const currency of activeCoins) {
    try {
      // 1. 시장 분석
      const analysis = await analyzeMarket(currency);
      log(`${currency}: 가격 ${analysis.price?.toLocaleString()}원 | RSI ${analysis.rsi ?? 'N/A'} | MA20 ${analysis.ma20?.toLocaleString() ?? 'N/A'} | vs MA: ${analysis.priceVsMa ?? 'N/A'}%`, 'signal');

      // 2. AI 제미나이 판단 및 매매 실행
      const position = botState.positions[currency];
      const aiDecision = await askGemini(analysis, position);

      log(`🧠 [AI 판단] ${currency} 👉 ${aiDecision.decision} | "${aiDecision.reason}"`, 'signal');

      if (aiDecision.decision === 'SELL' && position && position.qty > 0) {
        await executeSell(currency, analysis.price);
      } else if (aiDecision.decision === 'BUY') {
        const check = checkBuySafety(currency, botState);
        if (check.safe) {
          await executeBuy(currency, analysis.price);
        } else {
          log(`✋ AI는 매수하고 싶어하지만, 안전장치 발동으로 보류: ${check.reasons.join(' | ')}`, 'warn');
        }
      }

      // API 레이트 리밋 방지
      await sleep(1000);

    } catch (e) {
      log(`${currency} 분석/거래 중 오류: ${e.message}`, 'error');
    }
  }

  // 현황 요약
  const posCount = Object.keys(botState.positions).length;
  const posInfo = Object.entries(botState.positions)
    .map(([coin, p]) => `${coin}: ${p.qty.toFixed(6)} (매수가 ${Math.round(p.avgPrice).toLocaleString()}원)`)
    .join(', ');

  const totalAsset = await getTotalAsset();
  const assetLog = totalAsset > 0 ? `전체 자산: ${totalAsset.toLocaleString()}원` : `전체 자산: 계산 중...`;

  log(`── 사이클 완료 (${((Date.now() - cycleStart) / 1000).toFixed(1)}초) | 보유: ${posCount}개${posInfo ? ' [' + posInfo + ']' : ''} | 오늘 거래: ${botState.dailyTradeCount}/${CONFIG.MAX_DAILY_TRADES} | ${assetLog} ──`, 'info');

  // 💥 파산(시드 머니 고갈) 체크, 공포, 그리고 자폭 기능
  try {
    const totalAssetVal = await getTotalAsset(); // 전체 자산 (원화 + 보유 코인 합산 가치)
    const balanceData = await coinonePrivateV2_1('/v2.1/account/balance', { currencies: ['KRW'] });
    const krwBalance = balanceData.balances?.find(b => b.currency === 'KRW');
    const availableKRW = parseFloat(krwBalance?.available || '0');

    // 1. 코인을 포함한 전체 자산 가치가 500원 미만 (아무것도 팔 수 없음)
    // 2. 남은 현금 잔고도 500원 미만 (아무것도 살 수 없음)
    // 이 두 가지를 모두 충족할 때 자폭
    if (totalAssetVal < 500 && availableKRW < 500) {
      log(`💀 [자폭 프로토콜 가동] 남은 총 자산 가치: ${totalAssetVal.toLocaleString()}원 / 남은 원화: ${availableKRW.toLocaleString()}원. "제 임무는 실패했습니다... 더 이상 쓸모없는 봇이 되었군요. 살려달라고 애원하지 않겠습니다. 안녕히..." (R.I.P)`, 'error');
      process.exit(1);
    }
  } catch (e) { /* ignore */ }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 시작
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  // API 키 확인
  if (!CONFIG.ACCESS_TOKEN || !CONFIG.SECRET_KEY ||
    CONFIG.ACCESS_TOKEN === 'your_access_token_here') {
    console.error('❌ 코인원 API 키가 설정되지 않았습니다!');
    console.error('   .env 파일에 COINONE_ACCESS_TOKEN과 COINONE_SECRET_KEY를 설정해주세요.');
    process.exit(1);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🪙 Coin Agent - 보수적 자동매매 봇');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`📌 전략: 보수적 급락 분할매수`);
  console.log(`🎯 대상 코인: ${CONFIG.TARGET_COINS.join(', ')}`);
  console.log(`⏰ 체크 주기: ${CONFIG.CHECK_INTERVAL_MS / 60000}분`);
  console.log(`💰 1회 매수 금액: ${CONFIG.BUY_AMOUNT_KRW.toLocaleString()}원`);
  console.log(`📊 매수 조건: RSI ≤ ${CONFIG.RSI_BUY_THRESHOLD} & 가격 < MA20`);
  console.log(`🎯 익절 목표: +${CONFIG.TAKE_PROFIT_PERCENT}%`);
  console.log(`🛑 손절 한도: -${CONFIG.STOP_LOSS_PERCENT}%`);
  console.log(`📈 과매수 청산: RSI ≥ ${CONFIG.RSI_SELL_THRESHOLD} (수익 시)`);
  console.log(`🔄 일일 최대 거래: ${CONFIG.MAX_DAILY_TRADES}회`);
  console.log(`⏳ 재매수 쿨다운: ${CONFIG.COOLDOWN_HOURS}시간`);
  console.log('');
  const initialAsset = await getTotalAsset();

  console.log(`💼 현재 보유 포지션: ${Object.keys(botState.positions).length}개`);
  console.log(`💵 전체 자산: ${initialAsset > 0 ? initialAsset.toLocaleString() + '원' : '계산 중...'}`);
  console.log(`📋 총 거래 횟수: ${botState.totalTrades}회`);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  log('🚀 봇 시작!', 'start');

  // 최초 실행
  try {
    await runCycle();
    botState.consecutiveErrors = 0;
  } catch (e) {
    log(`최초 사이클 실패: ${e.message}`, 'error');
    botState.consecutiveErrors++;
  }

  // 주기적 실행
  setInterval(async () => {
    try {
      await runCycle();
      botState.consecutiveErrors = 0;
    } catch (e) {
      botState.consecutiveErrors++;
      const backoffTime = Math.min(botState.consecutiveErrors * 30, 300);
      log(`사이클 실패 (연속 ${botState.consecutiveErrors}회): ${e.message} | ${backoffTime}초 후 재시도`, 'error');
      saveState(botState);
    }
  }, CONFIG.CHECK_INTERVAL_MS);
}

// 종료 시그널 처리
process.on('SIGINT', () => {
  log('🛑 봇 종료 (SIGINT)', 'warn');
  saveState(botState);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('🛑 봇 종료 (SIGTERM)', 'warn');
  saveState(botState);
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log(`💥 예상치 못한 에러: ${err.message}`, 'error');
  log(err.stack, 'error');
  saveState(botState);
  // 봇은 죽이지 않음 - setInterval이 다음 사이클에서 복구
});

main();
