const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let botProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1e1e2e',
      symbolColor: '#cdd6f4'
    },
    backgroundColor: '#11111b'
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 환경변수(.env) 읽기
ipcMain.handle('get-config', () => {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const config = require('dotenv').parse(envFile);
    return config;
  } catch (e) {
    return {};
  }
});

// 환경변수(.env) 저장
ipcMain.handle('save-config', (event, newConfig) => {
  try {
    let output = '';
    // 기존 .env 파일을 읽어서 주석은 최대한 보존하고 값만 교체하는 로직
    const envPath = path.join(__dirname, '.env');
    let existingLines = [];
    if (fs.existsSync(envPath)) {
      existingLines = fs.readFileSync(envPath, 'utf8').split('\n');
    }

    const configKeys = Object.keys(newConfig);
    const updatedKeys = new Set();

    for (const line of existingLines) {
      const match = line.match(/^([A-Z0-9_]+)=(.+)?$/);
      if (match) {
        const key = match[1];
        if (configKeys.includes(key)) {
          output += `${key}=${newConfig[key]}\n`;
          updatedKeys.add(key);
        } else {
          output += line + '\n';
        }
      } else {
        output += line + '\n';
      }
    }

    // 새로 추가된 키 반영
    for (const key of configKeys) {
      if (!updatedKeys.has(key)) {
        output += `${key}=${newConfig[key]}\n`;
      }
    }

    fs.writeFileSync(envPath, output.trim() + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
});

// 봇 ON/OFF 토글
ipcMain.handle('toggle-bot', (event) => {
  if (botProcess) {
    // 봇 켜져 있으면 끄기
    botProcess.kill('SIGINT');
    botProcess = null;
    return false; // isRunning = false
  } else {
    // 봇 꺼져 있으면 켜기 (새로운 자식 프로세스로 node bot.js 실행)
    botProcess = spawn('node', [path.join(__dirname, 'bot.js')], {
      env: { ...process.env }, // 새로운 .env를 위해 현재 환경변수 넘기지만, bot.js 내에서 dotenv 다시 로드함
    });

    botProcess.stdout.on('data', (data) => {
      const msgs = data.toString().trim().split('\n');
      msgs.forEach(msg => {
        if (msg) mainWindow.webContents.send('bot-log', msg);
      });
    });

    botProcess.stderr.on('data', (data) => {
      const msgs = data.toString().trim().split('\n');
      msgs.forEach(msg => {
        if (msg) mainWindow.webContents.send('bot-log', `[ERROR] ${msg}`);
      });
    });

    botProcess.on('close', (code) => {
      mainWindow.webContents.send('bot-log', `[SYSTEM] 봇 프로그램이 종료되었습니다. (코드: ${code})`);
      mainWindow.webContents.send('bot-status', false);
      botProcess = null;
    });

    return true; // isRunning = true
  }
});

ipcMain.handle('get-bot-status', () => {
  return botProcess !== null;
});
