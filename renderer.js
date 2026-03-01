// DOM 요소 가져오기
const inAccess = document.getElementById('access_token');
const inSecret = document.getElementById('secret_key');
const inGemini = document.getElementById('gemini_key');
const containerTargetCoins = document.getElementById('target_coins');
const inBuyAmount = document.getElementById('buy_amount');
const inTargetAsset = document.getElementById('target_asset');
const btnSave = document.getElementById('btn_save');

const led = document.getElementById('status_led');
const statusText = document.getElementById('status_text');
const btnToggle = document.getElementById('btn_toggle_bot');
const consoleOutput = document.getElementById('console_output');

const POPULAR_COINS = [
  { symbol: 'BTC', name: '비트코인' },
  { symbol: 'ETH', name: '이더리움' },
  { symbol: 'XRP', name: '리플' },
  { symbol: 'SOL', name: '솔라나' },
  { symbol: 'DOGE', name: '도지코인' },
  { symbol: 'AVAX', name: '아발란체' },
  { symbol: 'LINK', name: '체인링크' },
  { symbol: 'DOT', name: '폴카닷' },
  { symbol: 'ADA', name: '에이다' },
  { symbol: 'TRX', name: '트론' }
];
let selectedCoins = ['BTC', 'ETH', 'SOL'];

function renderCoinButtons() {
  containerTargetCoins.innerHTML = '';
  POPULAR_COINS.forEach(coin => {
    const btn = document.createElement('button');
    btn.className = `coin-btn ${selectedCoins.includes(coin.symbol) ? 'selected' : ''}`;
    btn.innerText = `${coin.name} (${coin.symbol})`;
    btn.onclick = () => {
      if (selectedCoins.includes(coin.symbol)) {
        selectedCoins = selectedCoins.filter(c => c !== coin.symbol);
      } else {
        selectedCoins.push(coin.symbol);
      }
      renderCoinButtons();
    };
    containerTargetCoins.appendChild(btn);
  });
}

async function init() {
  // 1. 기존 .env 설정 불러와서 인풋에 채우기
  const config = await window.electronAPI.getConfig();
  if (config) {
    inAccess.value = config.COINONE_ACCESS_TOKEN || '';
    inSecret.value = config.COINONE_SECRET_KEY || '';
    inGemini.value = config.GEMINI_API_KEY || '';
    if (config.BOT_TARGET_COINS) {
      selectedCoins = config.BOT_TARGET_COINS.split(',').map(c => c.trim()).filter(c => c);
    }
    inBuyAmount.value = config.BOT_BUY_AMOUNT_KRW || '10000';
    inTargetAsset.value = config.BOT_TARGET_ASSET_KRW || '100000';
  }
  renderCoinButtons();

  // 2. 현재 봇 실행 상태 체크
  const isRunning = await window.electronAPI.getBotStatus();
  updateUIStatus(isRunning);
}

// "설정 저장하기" 버튼
btnSave.addEventListener('click', async () => {
  btnSave.innerText = "저장 중...";
  const newConfig = {
    COINONE_ACCESS_TOKEN: inAccess.value,
    COINONE_SECRET_KEY: inSecret.value,
    GEMINI_API_KEY: inGemini.value,
    BOT_TARGET_COINS: selectedCoins.join(','),
    BOT_BUY_AMOUNT_KRW: inBuyAmount.value,
    BOT_TARGET_ASSET_KRW: inTargetAsset.value
  };

  await window.electronAPI.saveConfig(newConfig);

  setTimeout(() => {
    btnSave.innerText = "설정 저장하기";
    appendLog("SYSTEM", "API 및 봇 설정이 성공적으로 저장되었습니다!");
  }, 500);
});

// "봇 가동/중지" 버튼
btnToggle.addEventListener('click', async () => {
  btnToggle.innerText = "처리 중...";
  const isRunning = await window.electronAPI.toggleBot();
  updateUIStatus(isRunning);

  if (isRunning) {
    appendLog("SYSTEM", "AI 트레이딩 봇 엔진이 시작되었습니다.");
  } else {
    appendLog("SYSTEM", "AI 트레이딩 봇 엔진 종료 요청됨.");
  }
});

function updateUIStatus(isRunning) {
  if (isRunning) {
    led.className = 'led active';
    statusText.innerText = '동작 중 (LIVE)';
    statusText.style.color = 'var(--success)';
    btnToggle.className = 'btn btn-stop';
    btnToggle.innerHTML = '🛑 봇 중지하기';
  } else {
    led.className = 'led danger';
    statusText.innerText = '오프라인 (OFF)';
    statusText.style.color = 'var(--danger)';
    btnToggle.className = 'btn btn-start';
    btnToggle.innerHTML = '🚀 봇 가동하기';
  }
}

// 봇에서 올라오는 로그를 터미널 창에 추가하는 함수
function appendLog(rawTime, rawMessage) {
  const div = document.createElement('div');
  div.className = 'log-line';

  let timeStr = rawTime;
  let msgStr = rawMessage;

  // bot.js의 기존 로깅 포맷 ([날짜] 🚀 메세지) 파싱 시도
  if (!timeStr && rawMessage.startsWith('[')) {
    const closeIdx = rawMessage.indexOf(']');
    if (closeIdx > -1) {
      timeStr = rawMessage.substring(1, closeIdx);
      msgStr = rawMessage.substring(closeIdx + 1).trim();
    }
  }

  if (!timeStr) timeStr = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

  // 색상 입히기 (약간의 하이라이트 효과)
  if (msgStr.includes('매수')) msgStr = `<span style="color:var(--success)">${msgStr}</span>`;
  else if (msgStr.includes('매도')) msgStr = `<span style="color:#f38ba8">${msgStr}</span>`;
  else if (msgStr.includes('AI 판단')) msgStr = `<span style="color:#f9e2af">${msgStr}</span>`;
  else if (msgStr.includes('ERROR')) msgStr = `<span style="color:var(--danger)">${msgStr}</span>`;

  div.innerHTML = `<span class="timestamp">[${timeStr}]</span> ${msgStr}`;
  consoleOutput.appendChild(div);

  // 자동 스크롤
  consoleOutput.scrollTop = consoleOutput.scrollHeight;

  // 브라우저 렉을 막기 위해 1000줄 넘어가면 예전 로그 삭제
  if (consoleOutput.children.length > 1000) {
    consoleOutput.removeChild(consoleOutput.firstChild);
  }
}

// IPC 통신 이벤트 리스너 (bot.js가 뱉는 로그들)
window.electronAPI.onBotLog((event, msg) => {
  appendLog(null, msg);
});

// 백그라운드 봇 상태 변경 시 (예: 강제종료 시)
window.electronAPI.onBotStatus((event, isRunning) => {
  updateUIStatus(isRunning);
});

// 초기 실행
init();
