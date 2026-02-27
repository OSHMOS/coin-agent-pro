require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const CONFIG = {
  ACCESS_TOKEN: process.env.COINONE_ACCESS_TOKEN,
  SECRET_KEY: process.env.COINONE_SECRET_KEY,
  API_BASE: 'https://api.coinone.co.kr',
};

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

async function test() {
  try {
    const balanceData = await coinonePrivateV2_1('/v2.1/account/balance');
    console.log(JSON.stringify(balanceData, null, 2));
  } catch (e) {
    console.log("Error:", e.response?.data || e.message);
  }
}

test();
