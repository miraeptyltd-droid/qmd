// 네이버 영어사전 위젯 - 작은 창, 항상 위, 트레이 상주, 단축키 호출
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, shell, screen, nativeImage,
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

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 300,
    minHeight: 300,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    autoHideMenuBar: true,
    title: '영어사전',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setMenu(null);
  win.setOpacity(settings.opacity);
  if (settings.mobileLayout) win.webContents.setUserAgent(MOBILE_UA);
  win.loadURL(settings.homeUrl);
  win.once('ready-to-show', () => win.show());

  // 사전 안의 링크는 창 안에서, 그 외(광고·외부 링크)는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isDictUrl(url)) win.loadURL(url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });

  // 창 안 단축키: Esc 숨기기, Alt+←/→ 뒤로/앞으로, Ctrl+R 새로고침, Alt+Home 처음화면
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const nav = win.webContents.navigationHistory;
    let handled = true;
    if (input.key === 'Escape') win.hide();
    else if (input.alt && input.key === 'ArrowLeft') nav.canGoBack() && nav.goBack();
    else if (input.alt && input.key === 'ArrowRight') nav.canGoForward() && nav.goForward();
    else if (input.alt && input.key === 'Home') win.loadURL(settings.homeUrl);
    else if (input.control && input.key.toLowerCase() === 'r') win.webContents.reload();
    else handled = false;
    if (handled) event.preventDefault();
  });

  const remember = () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      settings.bounds = win.getBounds();
      saveSettings();
    }
  };
  win.on('moved', remember);
  win.on('resized', remember);

  // X 버튼은 종료가 아니라 트레이로 숨김
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function lookup(text) {
  const q = (text || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (q) win.loadURL(settings.searchUrl.replace('{q}', encodeURIComponent(q)));
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
}

function setOpacity(value) {
  settings.opacity = value;
  win.setOpacity(value);
  saveSettings();
  buildTrayMenu();
}

function setMobileLayout(on) {
  settings.mobileLayout = on;
  win.webContents.setUserAgent(on ? MOBILE_UA : app.userAgentFallback);
  saveSettings();
  win.loadURL(settings.homeUrl);
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
    { label: '처음 화면', click: () => { win.loadURL(settings.homeUrl); showWindow(); } },
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
