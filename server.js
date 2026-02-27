require('dotenv').config();
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 코인원 API 헬퍼 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COINONE_API_BASE = 'https://api.coinone.co.kr';

/**
 * 코인원 Private API 요청 (V2.0)
 * - nonce: Unix timestamp (양의 정수)
 * - 요청: snake_case / 응답: camelCase
 */
async function coinonePrivateV2(endpoint, params = {}) {
  const accessToken = process.env.COINONE_ACCESS_TOKEN;
  const secretKey = process.env.COINONE_SECRET_KEY;

  if (!accessToken || !secretKey || accessToken === 'your_access_token_here') {
    throw new Error('코인원 API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
  }

  const payload = {
    access_token: accessToken,
    nonce: Date.now(),
    ...params
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha512', secretKey.toUpperCase())
    .update(encodedPayload)
    .digest('hex');

  const response = await axios.post(`${COINONE_API_BASE}${endpoint}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-COINONE-PAYLOAD': encodedPayload,
      'X-COINONE-SIGNATURE': signature,
    }
  });

  return response.data;
}

/**
 * 코인원 Private API 요청 (V2.1)
 * - nonce: UUID v4 형식
 * - 요청/응답 모두 snake_case
 */
async function coinonePrivateV2_1(endpoint, params = {}) {
  const accessToken = process.env.COINONE_ACCESS_TOKEN;
  const secretKey = process.env.COINONE_SECRET_KEY;

  if (!accessToken || !secretKey || accessToken === 'your_access_token_here') {
    throw new Error('코인원 API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
  }

  const payload = {
    access_token: accessToken,
    nonce: crypto.randomUUID(),
    ...params
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha512', secretKey.toUpperCase())
    .update(encodedPayload)
    .digest('hex');

  const response = await axios.post(`${COINONE_API_BASE}${endpoint}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-COINONE-PAYLOAD': encodedPayload,
      'X-COINONE-SIGNATURE': signature,
    }
  });

  return response.data;
}

/**
 * 코인원 Public API 요청 (인증 불필요)
 */
async function coinonePublic(endpoint) {
  const response = await axios.get(`${COINONE_API_BASE}${endpoint}`);
  return response.data;
}

/**
 * 거래 로그 기록
 */
function writeTradeLog(logEntry) {
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(logDir, `trades_${today}.json`);

  let logs = [];
  if (fs.existsSync(logFile)) {
    logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  }

  logs.push({
    timestamp: new Date().toISOString(),
    ...logEntry
  });

  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf8');
}

/**
 * 안전장치: 최대 거래 금액 확인
 */
function checkTradeLimit(amountKRW) {
  const maxAmount = parseInt(process.env.MAX_TRADE_AMOUNT_KRW || '100000');
  if (amountKRW > maxAmount) {
    throw new Error(
      `⚠️ 안전장치 발동! 1회 거래 한도 ${maxAmount.toLocaleString()}원을 초과했습니다. ` +
      `요청 금액: ${amountKRW.toLocaleString()}원. ` +
      `.env의 MAX_TRADE_AMOUNT_KRW 값을 조정하세요.`
    );
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 스킬(Tool) 구현
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const toolImplementations = {

  // ───────────────────────────────
  // Phase 1: 시세 조회 (Public API)
  // ───────────────────────────────

  coinone_get_ticker: async ({ currency }) => {
    try {
      const data = await coinonePublic(`/public/v2/ticker_new/KRW/${currency.toUpperCase()}`);
      const ticker = data.tickers?.[0] || data;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            코인: currency.toUpperCase(),
            현재가: ticker.last,
            고가_24h: ticker.high,
            저가_24h: ticker.low,
            거래량_24h: ticker.volume,
            변동률_24h: ticker.yesterday_last
              ? `${(((ticker.last - ticker.yesterday_last) / ticker.yesterday_last) * 100).toFixed(2)}%`
              : 'N/A',
            시간: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `시세 조회 실패: ${e.message}` }] };
    }
  },

  coinone_get_orderbook: async ({ currency }) => {
    try {
      const data = await coinonePublic(`/public/v2/orderbook/${currency.toUpperCase()}?currency=${currency.toUpperCase()}`);
      const asks = (data.asks || []).slice(0, 5);
      const bids = (data.bids || []).slice(0, 5);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            코인: currency.toUpperCase(),
            매도호가_상위5: asks.map(a => ({ 가격: a.price, 수량: a.qty })),
            매수호가_상위5: bids.map(b => ({ 가격: b.price, 수량: b.qty })),
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `호가창 조회 실패: ${e.message}` }] };
    }
  },

  coinone_get_trades: async ({ currency, limit }) => {
    try {
      const data = await coinonePublic(`/public/v2/trades/${currency.toUpperCase()}?currency=${currency.toUpperCase()}`);
      const trades = (data.trades || []).slice(0, limit || 20);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            코인: currency.toUpperCase(),
            최근체결: trades.map(t => ({
              가격: t.price,
              수량: t.qty,
              타입: t.is_seller_maker ? '매도' : '매수',
              시간: new Date(t.timestamp * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
            }))
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `체결 내역 조회 실패: ${e.message}` }] };
    }
  },

  // ───────────────────────────────
  // Phase 1: 계좌 조회 (Private API)
  // ───────────────────────────────

  coinone_get_balance: async ({ currencies }) => {
    try {
      const currencyList = currencies
        ? currencies.split(',').map(c => c.trim().toUpperCase())
        : ['BTC', 'ETH', 'XRP', 'KRW'];

      const data = await coinonePrivateV2_1('/v2.1/account/balance', {
        currencies: currencyList
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            잔고: data.balances
              ? data.balances.map(b => ({
                코인: b.currency,
                사용가능: b.available,
                주문중: b.limit,
                평균매수가: b.average_price
              }))
              : data,
            조회시간: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `잔고 조회 실패: ${e.message}` }] };
    }
  },

  // ───────────────────────────────
  // Phase 2: 기술적 분석
  // ───────────────────────────────

  coinone_analyze: async ({ currency, indicators }) => {
    try {
      // 캔들 데이터를 체결 내역으로부터 간접적으로 구성
      const data = await coinonePublic(`/public/v2/trades/${currency.toUpperCase()}?currency=${currency.toUpperCase()}`);
      const trades = data.trades || [];

      if (trades.length === 0) {
        return { content: [{ type: "text", text: "거래 데이터가 없습니다." }] };
      }

      const prices = trades.map(t => parseFloat(t.price)).reverse();
      const currentPrice = prices[prices.length - 1];

      const result = {
        코인: currency.toUpperCase(),
        현재가: currentPrice,
        분석데이터_개수: prices.length,
      };

      // 간단한 이동평균 계산
      if (prices.length >= 5) {
        const ma5 = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
        result['MA5'] = Math.round(ma5);
        result['MA5_시그널'] = currentPrice > ma5 ? '📈 가격이 MA5 위 (상승세)' : '📉 가격이 MA5 아래 (하락세)';
      }

      if (prices.length >= 10) {
        const ma10 = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
        result['MA10'] = Math.round(ma10);
        result['MA10_시그널'] = currentPrice > ma10 ? '📈 가격이 MA10 위 (상승세)' : '📉 가격이 MA10 아래 (하락세)';
      }

      // 간단한 RSI 계산 (14기간)
      if (prices.length >= 15) {
        const changes = [];
        for (let i = 1; i < prices.length; i++) {
          changes.push(prices[i] - prices[i - 1]);
        }
        const period = Math.min(14, changes.length);
        const recentChanges = changes.slice(-period);
        const gains = recentChanges.filter(c => c > 0);
        const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
        const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

        if (avgLoss === 0) {
          result['RSI'] = 100;
        } else {
          const rs = avgGain / avgLoss;
          result['RSI'] = Math.round(100 - (100 / (1 + rs)));
        }

        if (result['RSI'] >= 70) {
          result['RSI_시그널'] = '🔴 과매수 구간 (매도 고려)';
        } else if (result['RSI'] <= 30) {
          result['RSI_시그널'] = '🟢 과매도 구간 (매수 고려)';
        } else {
          result['RSI_시그널'] = '⚪ 중립 구간';
        }
      }

      // 최고/최저
      result['최근_최고가'] = Math.max(...prices);
      result['최근_최저가'] = Math.min(...prices);
      result['분석시간'] = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `분석 실패: ${e.message}` }] };
    }
  },

  // ───────────────────────────────
  // Phase 3: 주문 실행 ⚠️
  // ───────────────────────────────

  coinone_limit_buy: async ({ currency, price, qty }) => {
    try {
      const totalKRW = parseFloat(price) * parseFloat(qty);
      checkTradeLimit(totalKRW);

      const data = await coinonePrivateV2('/v2/order/limit_buy', {
        currency: currency.toUpperCase(),
        price: String(price),
        qty: String(qty),
      });

      const logEntry = {
        action: '지정가_매수',
        currency: currency.toUpperCase(),
        price, qty,
        totalKRW: Math.round(totalKRW),
        result: data.result,
        orderId: data.orderId,
      };
      writeTradeLog(logEntry);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            결과: data.result === 'success' ? '✅ 매수 주문 성공' : `❌ 실패: ${data.errorCode}`,
            주문ID: data.orderId,
            코인: currency.toUpperCase(),
            주문가격: `${parseInt(price).toLocaleString()}원`,
            주문수량: qty,
            총금액: `${Math.round(totalKRW).toLocaleString()}원`,
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `매수 주문 실패: ${e.message}` }] };
    }
  },

  coinone_limit_sell: async ({ currency, price, qty }) => {
    try {
      const totalKRW = parseFloat(price) * parseFloat(qty);
      checkTradeLimit(totalKRW);

      const data = await coinonePrivateV2('/v2/order/limit_sell', {
        currency: currency.toUpperCase(),
        price: String(price),
        qty: String(qty),
      });

      const logEntry = {
        action: '지정가_매도',
        currency: currency.toUpperCase(),
        price, qty,
        totalKRW: Math.round(totalKRW),
        result: data.result,
        orderId: data.orderId,
      };
      writeTradeLog(logEntry);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            결과: data.result === 'success' ? '✅ 매도 주문 성공' : `❌ 실패: ${data.errorCode}`,
            주문ID: data.orderId,
            코인: currency.toUpperCase(),
            주문가격: `${parseInt(price).toLocaleString()}원`,
            주문수량: qty,
            총금액: `${Math.round(totalKRW).toLocaleString()}원`,
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `매도 주문 실패: ${e.message}` }] };
    }
  },

  coinone_cancel_order: async ({ orderId, currency }) => {
    try {
      const data = await coinonePrivateV2('/v2/order/cancel', {
        order_id: orderId,
        currency: currency.toUpperCase(),
      });

      writeTradeLog({
        action: '주문_취소',
        orderId,
        currency: currency.toUpperCase(),
        result: data.result,
      });

      return {
        content: [{
          type: "text",
          text: data.result === 'success'
            ? `✅ 주문 취소 성공 (주문ID: ${orderId})`
            : `❌ 취소 실패: ${JSON.stringify(data)}`
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `주문 취소 실패: ${e.message}` }] };
    }
  },

  // ───────────────────────────────
  // Phase 3: 주문 조회
  // ───────────────────────────────

  coinone_get_order: async ({ orderId, currency }) => {
    try {
      const data = await coinonePrivateV2('/v2/order/query_order', {
        order_id: orderId,
        currency: currency.toUpperCase(),
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            주문ID: data.orderId,
            코인: data.baseCurrency,
            방향: data.side === 'bid' ? '매수' : '매도',
            주문가격: data.price,
            주문수량: data.originalQty,
            체결수량: data.executedQty,
            미체결수량: data.remainQty,
            상태: data.status,
            평균체결가: data.averageExecutedPrice,
            수수료: data.fee,
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `주문 조회 실패: ${e.message}` }] };
    }
  },

  // ───────────────────────────────
  // 유틸: 거래 로그 조회
  // ───────────────────────────────

  coinone_get_trade_logs: async ({ date }) => {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];
      const logFile = path.join(__dirname, 'logs', `trades_${targetDate}.json`);

      if (!fs.existsSync(logFile)) {
        return { content: [{ type: "text", text: `${targetDate}의 거래 로그가 없습니다.` }] };
      }

      const logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            날짜: targetDate,
            총거래수: logs.length,
            거래내역: logs
          }, null, 2)
        }]
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `로그 조회 실패: ${e.message}` }] };
    }
  },
};

module.exports = { toolImplementations };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MCP 서버 설정
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const server = new Server(
  {
    name: "coin-agent-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool 목록 정의
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ── 시세 조회 ──
      {
        name: "coinone_get_ticker",
        description: "코인원에서 특정 코인의 현재 시세를 조회합니다 (현재가, 고가, 저가, 거래량, 변동률)",
        inputSchema: {
          type: "object",
          properties: {
            currency: { type: "string", description: "코인 심볼 (예: BTC, ETH, XRP, DOGE)" }
          },
          required: ["currency"]
        }
      },
      {
        name: "coinone_get_orderbook",
        description: "코인원에서 특정 코인의 호가창(매수/매도 대기 주문)을 조회합니다",
        inputSchema: {
          type: "object",
          properties: {
            currency: { type: "string", description: "코인 심볼 (예: BTC, ETH)" }
          },
          required: ["currency"]
        }
      },
      {
        name: "coinone_get_trades",
        description: "코인원에서 특정 코인의 최근 체결 내역을 조회합니다",
        inputSchema: {
          type: "object",
          properties: {
            currency: { type: "string", description: "코인 심볼 (예: BTC, ETH)" },
            limit: { type: "number", description: "조회할 체결 내역 수 (기본값: 20)" }
          },
          required: ["currency"]
        }
      },

      // ── 계좌 조회 ──
      {
        name: "coinone_get_balance",
        description: "코인원 계좌의 잔고를 조회합니다 (보유 코인, 원화 잔액, 평균매수가 등)",
        inputSchema: {
          type: "object",
          properties: {
            currencies: {
              type: "string",
              description: "조회할 코인들 (쉼표 구분, 예: 'BTC,ETH,XRP'). 미입력 시 BTC,ETH,XRP,KRW 조회"
            }
          }
        }
      },

      // ── 기술적 분석 ──
      {
        name: "coinone_analyze",
        description: "특정 코인의 기술적 분석을 수행합니다 (이동평균선 MA5/MA10, RSI, 최고/최저가 등)",
        inputSchema: {
          type: "object",
          properties: {
            currency: { type: "string", description: "분석할 코인 심볼 (예: BTC, ETH)" },
            indicators: { type: "string", description: "분석할 지표 (현재: MA, RSI 지원)" }
          },
          required: ["currency"]
        }
      },

      // ── 주문 실행 ──
      {
        name: "coinone_limit_buy",
        description: "⚠️ 코인원에서 지정가 매수 주문을 실행합니다. 실제 돈이 사용됩니다! 안전장치: MAX_TRADE_AMOUNT_KRW 초과 시 자동 차단",
        inputSchema: {
          type: "object",
          properties: {
            currency: { type: "string", description: "매수할 코인 심볼 (예: BTC, ETH)" },
            price: { type: "string", description: "매수 희망가격 (원, 예: '50000000')" },
            qty: { type: "string", description: "매수 수량 (예: '0.001')" }
          },
          required: ["currency", "price", "qty"]
        }
      },
      {
        name: "coinone_limit_sell",
        description: "⚠️ 코인원에서 지정가 매도 주문을 실행합니다. 실제 코인이 판매됩니다! 안전장치: MAX_TRADE_AMOUNT_KRW 초과 시 자동 차단",
        inputSchema: {
          type: "object",
          properties: {
            currency: { type: "string", description: "매도할 코인 심볼 (예: BTC, ETH)" },
            price: { type: "string", description: "매도 희망가격 (원, 예: '55000000')" },
            qty: { type: "string", description: "매도 수량 (예: '0.001')" }
          },
          required: ["currency", "price", "qty"]
        }
      },
      {
        name: "coinone_cancel_order",
        description: "코인원에서 미체결 주문을 취소합니다",
        inputSchema: {
          type: "object",
          properties: {
            orderId: { type: "string", description: "취소할 주문 ID" },
            currency: { type: "string", description: "코인 심볼 (예: BTC)" }
          },
          required: ["orderId", "currency"]
        }
      },

      // ── 주문 조회 ──
      {
        name: "coinone_get_order",
        description: "코인원에서 특정 주문의 상태를 조회합니다 (체결 여부, 수량, 가격 등)",
        inputSchema: {
          type: "object",
          properties: {
            orderId: { type: "string", description: "조회할 주문 ID" },
            currency: { type: "string", description: "코인 심볼 (예: BTC)" }
          },
          required: ["orderId", "currency"]
        }
      },

      // ── 거래 로그 ──
      {
        name: "coinone_get_trade_logs",
        description: "특정 날짜의 자동매매 거래 로그를 조회합니다 (날짜 미입력 시 오늘 로그)",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "조회할 날짜 (YYYY-MM-DD 형식, 미입력 시 오늘)" }
          }
        }
      },
    ]
  };
});

// Tool 실행 핸들러
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const implementation = toolImplementations[name];
  if (!implementation) throw new Error(`Unknown tool: ${name}`);
  return implementation(args || {});
});

// 서버 시작
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🪙 Coin Agent MCP server running on stdio (코인원 전용)");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
