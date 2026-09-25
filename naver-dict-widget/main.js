// 네이버 영어사전 위젯 - 작은 창, 항상 위, 트레이 상주, 단축키 호출
const {
  app, BrowserWindow, WebContentsView, ipcMain, Tray, Menu, globalShortcut, clipboard, shell, screen, nativeImage,
} = require('electron');
const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://en.dict.naver.com/';
const SEARCH_URL = 'https://en.dict.naver.com/#/search?query={q}';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const DEFAULTS = {
  bounds: { width: 420, height: 640 },
  alwaysOnTop: true,
  opacity: 1,
  mobileLayout: true,
  hotkeyToggle: 'Control+Shift+Space',
  hotkeyLookup: 'Control+Shift+F',
  homeUrl: HOME_URL,
  searchUrl: SEARCH_URL,
};

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
let win = null;
let tray = null;
let quitting = false;

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {}
}

// 저장된 위치가 현재 모니터 밖이면 버리고 기본 위치(오른쪽 아래)로
function initialBounds() {
  const b = settings.bounds || DEFAULTS.bounds;
  if (b.x !== undefined && b.y !== undefined) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50);
    if (visible) return b;
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { width: b.width, height: b.height, x: a.x + a.width - b.width - 20, y: a.y + a.height - b.height - 20 };
}

function isDictUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'dict.naver.com' || host.endsWith('.dict.naver.com') ||
      host === 'nid.naver.com' || host === 'naver.com' || host === 'www.naver.com';
  } catch {
    return false;
  }
}

const BAR_H = 28;
let dict = null; // 사전 페이지 (WebContentsView 의 webContents)

function layoutDict(view) {
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: BAR_H, width: w, height: Math.max(0, h - BAR_H) });
}

function goBack() { const n = dict.navigationHistory; if (n.canGoBack()) n.goBack(); }
function goForward() { const n = dict.navigationHistory; if (n.canGoForward()) n.goForward(); }
function goHome() { dict.loadURL(settings.homeUrl); }

// 창 안 단축키: Esc 숨기기, Alt+←/→ 뒤로/앞으로, Ctrl+R 새로고침, Alt+Home 처음화면
function handleKeys(event, input) {
  if (input.type !== 'keyDown') return;
  let handled = true;
  if (input.key === 'Escape') win.hide();
  else if (input.alt && input.key === 'ArrowLeft') goBack();
  else if (input.alt && input.key === 'ArrowRight') goForward();
  else if (input.alt && input.key === 'Home') goHome();
  else if (input.control && input.key.toLowerCase() === 'r') dict.reload();
  else handled = false;
  if (handled) event.preventDefault();
}

function createWindow() {
  // 기본 제목줄 없는 창 + 직접 만든 얇은 상단 바(bar.html)
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 300,
    minHeight: 300,
    frame: false,
    alwaysOnTop: settings.alwaysOnTop,
    title: '영어사전',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'bar-preload.js') },
  });
  win.setMenu(null);
  win.setOpacity(settings.opacity);
  win.loadFile(path.join(__dirname, 'bar.html'));
  win.once('ready-to-show', () => { win.show(); sendState(); });
  win.webContents.on('before-input-event', handleKeys);

  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(view);
  dict = view.webContents;
  layoutDict(view);
  win.on('resize', () => layoutDict(view));
  if (settings.mobileLayout) dict.setUserAgent(MOBILE_UA);
  dict.loadURL(settings.homeUrl);

  // 사전 안의 링크는 창 안에서, 그 외(광고·외부 링크)는 기본 브라우저로
  dict.setWindowOpenHandler(({ url }) => {
    if (isDictUrl(url)) dict.loadURL(url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });
  dict.on('before-input-event', handleKeys);
  dict.on('did-navigate-in-page', sendState);
  dict.on('did-navigate', sendState);

  const remember = () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      settings.bounds = win.getBounds();
      saveSettings();
    }
  };
  win.on('moved', remember);
  win.on('resized', remember);

  // 닫기는 종료가 아니라 트레이로 숨김
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', {
    pinned: settings.alwaysOnTop,
    canGoBack: dict.navigationHistory.canGoBack(),
  });
}

ipcMain.on('bar', (_e, action) => {
  if (action === 'back') goBack();
  else if (action === 'home') goHome();
  else if (action === 'pin') setAlwaysOnTop(!settings.alwaysOnTop);
  else if (action === 'hide') win.hide();
});

function showWindow() {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  dict.focus();
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function lookup(text) {
  const q = (text || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (q) dict.loadURL(settings.searchUrl.replace('{q}', encodeURIComponent(q)));
  showWindow();
}

function lookupClipboard() {
  lookup(clipboard.readText());
}

function setAlwaysOnTop(on) {
  settings.alwaysOnTop = on;
  win.setAlwaysOnTop(on);
  saveSettings();
  buildTrayMenu();
  sendState();
}

function setOpacity(value) {
  settings.opacity = value;
  win.setOpacity(value);
  saveSettings();
  buildTrayMenu();
}

function setMobileLayout(on) {
  settings.mobileLayout = on;
  dict.setUserAgent(on ? MOBILE_UA : app.userAgentFallback);
  saveSettings();
  goHome();
  buildTrayMenu();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  if (!globalShortcut.register(settings.hotkeyToggle, toggleWindow)) failed.push(settings.hotkeyToggle);
  if (!globalShortcut.register(settings.hotkeyLookup, lookupClipboard)) failed.push(settings.hotkeyLookup);
  return failed;
}

const pretty = (accel) => accel.replace('Control', 'Ctrl');

function buildTrayMenu() {
  if (!tray) return;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `열기 / 숨기기  (${pretty(settings.hotkeyToggle)})`, click: toggleWindow },
    { label: `복사한 단어 검색  (${pretty(settings.hotkeyLookup)})`, click: lookupClipboard },
    { label: '처음 화면', click: () => { goHome(); showWindow(); } },
    { type: 'separator' },
    { label: '항상 위에 표시', type: 'checkbox', checked: settings.alwaysOnTop, click: (i) => setAlwaysOnTop(i.checked) },
    { label: '작은 창용 화면 (모바일)', type: 'checkbox', checked: settings.mobileLayout, click: (i) => setMobileLayout(i.checked) },
    {
      label: '투명도',
      submenu: [1, 0.9, 0.8, 0.7, 0.6].map((v) => ({
        label: `${Math.round(v * 100)}%`, type: 'radio', checked: settings.opacity === v, click: () => setOpacity(v),
      })),
    },
    {
      label: 'Windows 시작 시 자동 실행', type: 'checkbox', checked: openAtLogin,
      click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }); buildTrayMenu(); },
    },
    { label: '설정 파일 열기', click: () => { saveSettings(); shell.openPath(settingsPath()); } },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('영어사전 위젯');
  tray.on('click', toggleWindow);
  buildTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && showWindow());

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    createTray();
    if (process.argv.includes('--hidden')) win.once('ready-to-show', () => win.hide());
    const failed = registerHotkeys();
    if (failed.length) {
      tray.displayBalloon?.({
        title: '영어사전 위젯',
        content: `단축키 ${failed.map(pretty).join(', ')} 를 다른 프로그램이 사용 중입니다. 트레이 메뉴 > 설정 파일 열기에서 바꿀 수 있어요.`,
      });
    }
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {}); // 트레이에 계속 상주
}
