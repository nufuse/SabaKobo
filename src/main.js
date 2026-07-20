/**
 * main.js — 鯖工房のメインプロセス
 * データ永続化・IPC・終了ガード。永続化まわりの作法はCmdKobo/FableDeckと同一。
 */
'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const java = require('./java');
const ports = require('./ports');
const properties = require('./properties');
const mods = require('./mods');
const runner = require('./runner');
const creators = {
  paper: require('./create/paper'),
  fabric: require('./create/fabric'),
  forge: require('./create/forge'),
  vanilla: require('./create/vanilla')
};

let win = null;
let javas = [];       /* 起動時に検出したJDK一覧 */
let data = null;      /* レジストリ(sabakobo-data.json) */
let allowClose = false;
let createAbort = null;

/* ── パス ─────────────────────────── */
const dataFile = () => path.join(app.getPath('userData'), 'sabakobo-data.json');
const backupDir = () => path.join(app.getPath('userData'), 'backups');

/* ── JSONファイル読み書き(壊れ防止のため一時ファイル経由で保存) ── */
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, value) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/* ── 起動時バックアップ(1日1世代・7世代まで保持) ── */
function rotateBackups() {
  try {
    if (!fs.existsSync(dataFile())) return;
    fs.mkdirSync(backupDir(), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(backupDir(), `sabakobo-data-${today}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(dataFile(), dest);
    const files = fs.readdirSync(backupDir()).filter(f => f.startsWith('sabakobo-data-')).sort();
    while (files.length > 7) fs.unlinkSync(path.join(backupDir(), files.shift()));
  } catch (e) { console.error('backup failed:', e); }
}

/* ── レジストリ ─────────────────────── */
const defaultData = {
  version: 1,
  newServerRoot: 'C:\\minecraft\\Minecraft server',
  servers: []
};
function saveData() {
  saveJSON(dataFile(), data);
  if (win && !win.isDestroyed()) win.webContents.send('data:changed', data);
}
function findServer(id) { return data.servers.find(s => s.id === id); }

/* ── 鯖プロセスのフック(コンソール行・状態変化・プレイヤー出入りをレンダラーへ) ── */
const hooks = {
  onLines: (id, lines) => { if (win && !win.isDestroyed()) win.webContents.send('console:lines', { id, lines }); },
  onState: (id, st) => {
    if (st.status === 'stopped') mods.clearDirty(id); /* 停止したので、以降のプラグイン/Modの状態は最新反映済み */
    if (win && !win.isDestroyed()) win.webContents.send('server:state', { id, ...st });
  },
  onPlayers: (id, players) => { if (win && !win.isDestroyed()) win.webContents.send('server:players', { id, players }); }
};

/* ── Javaの要求範囲 ───────────────────── */
/**
 * Mojang公式データ(javaVersion.majorVersion)を正とし、取れない時はフォールバック表。
 * 実測: 26.2→25 / 1.21.11→21 / 1.20.4→17 / 1.16.5→8。
 * Forge 1.18〜1.20.4の「17限定」(max)は公式値に関係なく維持する。
 */
async function effectiveRange(mc, loader, signal) {
  const range = { ...java.requiredRange(mc, loader) };
  try {
    const major = await creators.vanilla.javaMajorFor(mc, signal);
    if (major && major > range.min) range.min = major;
  } catch { /* オフライン・タイムアウト → 表のまま */ }
  if (range.max != null && range.min > range.max) range.min = range.max;
  range.label = range.max == null ? `Java ${range.min}以上`
    : (range.max === range.min ? `Java ${range.min}(限定)` : `Java ${range.min}〜${range.max}`);
  return range;
}

/* ── IPC: 初期化・Java・ポート ─────────── */
ipcMain.handle('app:init', () => ({
  version: app.getVersion(),
  data,
  javas,
  running: runner.runningIds(),
  ramGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10
}));

ipcMain.handle('java:for', async (e, mc, loader) => java.pickByRange(await effectiveRange(mc, loader), javas));

ipcMain.handle('ports:suggest', () => ports.suggest(data.servers.map(s => s.port).filter(Boolean)));
ipcMain.handle('ports:probe', (e, port) => ports.probe(Number(port)));

/* ── IPC: 鯖の操作 ─────────────────── */
ipcMain.handle('server:start', async (e, id) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  if (runner.isRunning(id)) return { ok: false, error: 'すでに起動中です' };

  /* ポートの事前チェック: アプリ管理の別鯖 → 名指し、外部プロセス → 一般エラー */
  if (s.port) {
    const rival = data.servers.find(o => o.id !== id && o.port === s.port && runner.isRunning(o.id));
    if (rival) return { ok: false, error: `ポート${s.port}は「${rival.name}」が使用中です` };
    if (!(await ports.probe(s.port))) return { ok: false, error: `ポート${s.port}は他のプロセスが使用中です` };
  }

  const jr = java.resolveForServer(s, javas);
  if (!jr.ok) return { ok: false, error: jr.error };

  try {
    const pid = runner.start(s, jr.exe, hooks);
    s.lastPid = pid;
    s.lastStartedAt = new Date().toISOString();
    mods.clearDirty(id); /* 起動できたので、以降のプラグイン/Modの状態は最新反映済み */
    saveData();
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:stop', (e, id) => runner.stop(id).then(() => ({ ok: true })));
ipcMain.handle('server:send', (e, id, cmd) => runner.send(id, String(cmd)));
ipcMain.handle('server:ring', (e, id) => runner.getRing(id));
ipcMain.handle('server:players', (e, id) => runner.getPlayers(id));

/* ops.json からOP一覧(名前)を読む。無ければ空 */
ipcMain.handle('server:ops', (e, id) => {
  const s = findServer(id);
  if (!s) return [];
  try {
    const ops = JSON.parse(fs.readFileSync(path.join(s.dir, 'ops.json'), 'utf8'));
    return ops.map(o => o.name).filter(Boolean);
  } catch { return []; }
});

/* 削除。確認はレンダラーのモーダルで済ませてくる。
   mode: 'unregister'=一覧から外すだけ / 'trash'=フォルダごとゴミ箱へ(完全削除はしない=復元可能) */
ipcMain.handle('server:remove', async (e, id, mode) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  if (runner.isRunning(id)) return { ok: false, error: '停止してから削除してください' };
  if (mode === 'trash') {
    try { await shell.trashItem(s.dir); }
    catch (err) { return { ok: false, error: 'ゴミ箱への移動に失敗しました: ' + err.message }; }
  }
  data.servers = data.servers.filter(x => x.id !== id);
  saveData();
  return { ok: true, trashed: mode === 'trash' };
});

/* ── IPC: server.properties ─────────── */
ipcMain.handle('props:read', (e, id) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  return properties.read(s.dir);
});
ipcMain.handle('props:write', (e, id, changes) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  try {
    properties.update(s.dir, changes);
    if (changes['server-port'] != null) { s.port = Number(changes['server-port']); }
    saveData();
    return { ok: true, running: runner.isRunning(id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ── IPC: プラグイン/Mod ─────────────── */
ipcMain.handle('mods:list', (e, id) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  return { ok: true, ...mods.listMods(s) };
});

ipcMain.handle('mods:toggle', (e, id, name, enabled) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  try {
    mods.setEnabled(s, name, !!enabled, runner.isRunning(id));
    if (win && !win.isDestroyed()) win.webContents.send('mods:changed', { id });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:add', (e, id, paths) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  try {
    const r = mods.addMods(s, paths || [], runner.isRunning(id));
    if (r.added.length && win && !win.isDestroyed()) win.webContents.send('mods:changed', { id });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 削除。完全削除はしない(鯖本体と同じ流儀=shell.trashItemでゴミ箱へ。復元可能) */
ipcMain.handle('mods:remove', async (e, id, name, enabled) => {
  const s = findServer(id);
  if (!s) return { ok: false, error: '不明なサーバーです' };
  try {
    const p = mods.resolveModPath(s, name, !!enabled);
    try {
      await shell.trashItem(p);
    } catch (err) {
      throw mods.translateFsError(err);
    }
    if (runner.isRunning(id)) mods.markDirty(id);
    if (win && !win.isDestroyed()) win.webContents.send('mods:changed', { id });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ── IPC: 作成ウィザード ─────────────── */
ipcMain.handle('create:versions', async (e, loader) => {
  try {
    const c = creators[loader];
    if (!c) return { ok: false, error: '不明なローダー' };
    return { ok: true, versions: await c.listVersions() };
  } catch (err) {
    return { ok: false, error: `バージョン一覧の取得に失敗: ${err.message}` };
  }
});

ipcMain.handle('create:run', async (e, opts) => {
  const { loader, mc, name, xms, xmx, port } = opts || {};
  const c = creators[loader];

  /* 検証(レンダラーも見ているが、正はこちら) */
  if (!c) return { ok: false, error: '不明なローダーです' };
  if (!mc) return { ok: false, error: 'バージョンを選んでください' };
  if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, error: '名前が空か、使えない文字( \\ / : * ? " < > | )を含んでいます' };
  if (opts.eula !== true) return { ok: false, error: 'Minecraft EULAへの同意が必要です' };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'ポート番号が不正です' };
  if (data.servers.some(s => s.port === p)) return { ok: false, error: `ポート${p}は登録済みの鯖が使っています` };
  if (!(await ports.probe(p))) return { ok: false, error: `ポート${p}は使用中です` };
  const xmsN = parseInt(String(xms || '2G'), 10), xmxN = parseInt(String(xmx || '4G'), 10);
  if (!/^\d+G$/.test(String(xms || '2G')) || !/^\d+G$/.test(String(xmx || '4G')) ||
      xmsN < 1 || xmxN < 1 || xmxN > 64 || xmsN > xmxN) {
    return { ok: false, error: 'メモリ指定が不正です(-Xms ≦ -Xmx、単位G)' };
  }

  const dir = opts.dir || path.join(data.newServerRoot, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    return { ok: false, error: `フォルダが空ではありません: ${dir}` };
  }
  if (data.servers.some(s => path.resolve(s.dir) === path.resolve(dir))) {
    return { ok: false, error: 'そのフォルダは既に登録されています' };
  }

  /* 中止コントローラは最初に作る(要求Java取得の段階から中止ボタンを効かせる) */
  createAbort = new AbortController();

  const progress = (phase, extra) => {
    if (win && !win.isDestroyed()) win.webContents.send('create:progress', { phase, ...extra });
  };

  /* Forgeインストーラの出力は数千行になるため、1行ずつ送るとレンダラーが再描画で凍る。
     150msごとに束ねて送る(コンソールと同じ発想) */
  let logBuf = [];
  const logTimer = setInterval(() => {
    if (logBuf.length) progress('installer', { lines: logBuf.splice(0) });
  }, 150);

  try {
    /* 要求Javaを確定(公式データ優先)して鯖に記録する。
       Forgeだけは鯖ができる前にJDKが要るので、ダウンロード前に確かめて早めに失敗させる */
    const javaReq = await effectiveRange(mc, loader, createAbort.signal);
    let javaExe = null;
    if (loader === 'forge') {
      const jr = java.pickByRange(javaReq, javas);
      if (!jr.ok) return { ok: false, error: jr.error };
      javaExe = jr.exe;
    }

    fs.mkdirSync(dir, { recursive: true });
    progress('download', { got: 0, total: 0 });
    const res = await c.create({
      mc, dir, javaExe,
      onProgress: (got, total) => progress('download', { got, total }),
      onLog: line => logBuf.push(line),
      signal: createAbort.signal
    });

    if (logBuf.length) progress('installer', { lines: logBuf.splice(0) });
    progress('finish', {});
    properties.writeEula(dir); /* UIのチェックボックスを通過済み(opts.eula===true) */
    properties.writeInitial(dir, { port: p, motd: name });

    const server = {
      id: crypto.randomUUID(),
      name, dir, loader,
      mcVersion: mc,
      loaderVersion: res.loaderVersion,
      jar: res.jar,
      javaPath: null,
      javaReq,
      xms: xms || '2G', xmx: xmx || '4G',
      extraJvmArgs: '', serverArgs: '',
      consoleCharset: 'utf-8',
      port: p,
      incomplete: false,
      origin: 'created',
      createdAt: new Date().toISOString(),
      lastStartedAt: null, lastPid: null,
      favorite: false, notes: ''
    };
    data.servers.push(server);
    saveData();
    return { ok: true, server };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearInterval(logTimer);
    createAbort = null;
  }
});

ipcMain.on('create:cancel', () => { if (createAbort) createAbort.abort(); });

/* ── IPC: その他 ─────────────────── */
ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pick-jars', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JARファイル', extensions: ['jar'] }]
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.on('shell:open-folder', (e, dir) => {
  const s = data.servers.find(x => x.dir === dir);
  if (s) shell.openPath(s.dir); /* 登録済みの鯖フォルダだけ開く */
});
ipcMain.on('open-external', (e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(url);
});
ipcMain.on('update:restart', () => autoUpdater.quitAndInstall());

/* テスト用(CDPテストから純関数を叩く) */
ipcMain.handle('dev:flatten-paper', (e, obj) => creators.paper.flattenVersions(obj));
ipcMain.handle('dev:player-line', (e, line) => runner.parsePlayerLine(String(line)));

/* propertiesエディタの往復テスト: 一時ファイルに書く→update→前後のバイト列を返す */
ipcMain.handle('dev:props-roundtrip', (e, text, changes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-props-'));
  try {
    fs.writeFileSync(path.join(dir, 'server.properties'), Buffer.from(text, 'utf8'));
    properties.update(dir, changes);
    return {
      before: Buffer.from(text, 'utf8').toString('base64'),
      after: fs.readFileSync(path.join(dir, 'server.properties')).toString('base64')
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ダウンロード無しで鯖を登録する(削除フローのテスト用。v0.3の取り込みでも土台になる) */
ipcMain.handle('dev:register', (e, opts) => {
  const dir = opts.dir;
  fs.mkdirSync(dir, { recursive: true });
  if (opts.writeProps) properties.writeInitial(dir, opts.writeProps);
  const server = {
    id: crypto.randomUUID(),
    name: opts.name || 'テスト', dir, loader: opts.loader || 'vanilla',
    mcVersion: opts.mcVersion || '1.21.11', loaderVersion: null, jar: opts.jar || 'server.jar',
    javaPath: null, javaReq: null, xms: '1G', xmx: '2G',
    extraJvmArgs: '', serverArgs: '', consoleCharset: 'utf-8',
    port: opts.port || 25565, incomplete: !opts.writeProps, origin: 'imported',
    createdAt: new Date().toISOString(), lastStartedAt: null, lastPid: null,
    favorite: false, notes: ''
  };
  data.servers.push(server);
  saveData();
  return server;
});

/* ── 自動アップデート(公開するまでは!app.isPackagedで眠っている) ── */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => {
    if (win && !win.isDestroyed()) win.webContents.send('update-ready', info.version);
  });
  autoUpdater.on('error', () => {}); /* オフライン等は黙って次回に持ち越す */
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
}

/* ── 窓 ─────────────────────────── */
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860,
    minWidth: 980, minHeight: 640,
    title: '鯖工房',
    backgroundColor: '#f4f1ea',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  /*
   * 終了ガード(FableDeckのゾンビ事件のjava.exe版):
   * 起動中の鯖があるまま閉じると、Windowsは親が死んでも子を殺さないので
   * 「届かないのに生きている鯖」が残る。必ず聞いてから全停止→終了。
   */
  win.on('close', e => {
    if (allowClose || !runner.anyRunning()) return;
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['すべて停止して終了', 'キャンセル'],
      defaultId: 0, cancelId: 1,
      title: '鯖工房',
      message: 'サーバーが起動中です',
      detail: 'すべてのサーバーを停止してから終了します。(強制終了はワールド破損のもとなので行いません)'
    }).then(({ response }) => {
      if (response === 0) {
        runner.stopAll().then(() => { allowClose = true; if (win && !win.isDestroyed()) win.close(); });
      }
    });
  });
  win.on('closed', () => { win = null; });
}

/* 二重起動ガード(FableDeckのゾンビ化バグの教訓) */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    rotateBackups();
    data = loadJSON(dataFile(), defaultData);
    javas = java.detect();
    createWindow();
    setupAutoUpdate();
  });
  app.on('window-all-closed', () => app.quit());
}
