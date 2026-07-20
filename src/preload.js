const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('saba', {
  /* 初期化 */
  init: () => ipcRenderer.invoke('app:init'),

  /* Java・ポート */
  javaFor: (mc, loader) => ipcRenderer.invoke('java:for', mc, loader),
  suggestPort: () => ipcRenderer.invoke('ports:suggest'),
  probePort: (p) => ipcRenderer.invoke('ports:probe', p),

  /* 鯖の操作 */
  start: (id) => ipcRenderer.invoke('server:start', id),
  stop: (id) => ipcRenderer.invoke('server:stop', id),
  sendCmd: (id, cmd) => ipcRenderer.invoke('server:send', id, cmd),
  ring: (id) => ipcRenderer.invoke('server:ring', id),
  remove: (id, mode) => ipcRenderer.invoke('server:remove', id, mode),
  playersGet: (id) => ipcRenderer.invoke('server:players', id),
  opsGet: (id) => ipcRenderer.invoke('server:ops', id),

  /* server.properties */
  propsRead: (id) => ipcRenderer.invoke('props:read', id),
  propsWrite: (id, changes) => ipcRenderer.invoke('props:write', id, changes),

  /* プラグイン/Mod */
  modsList: (id) => ipcRenderer.invoke('mods:list', id),
  modsToggle: (id, name, enabled) => ipcRenderer.invoke('mods:toggle', id, name, enabled),
  modsAdd: (id, paths) => ipcRenderer.invoke('mods:add', id, paths),
  modsRemove: (id, name, enabled) => ipcRenderer.invoke('mods:remove', id, name, enabled),
  pickJars: () => ipcRenderer.invoke('dialog:pick-jars'),
  /* ドラッグ&ドロップのパス取得。Electron 43でFile.pathが廃止されたため、これが唯一の方法 */
  pathForFile: (file) => webUtils.getPathForFile(file),

  /* 作成ウィザード */
  createVersions: (loader) => ipcRenderer.invoke('create:versions', loader),
  createRun: (opts) => ipcRenderer.invoke('create:run', opts),
  createCancel: () => ipcRenderer.send('create:cancel'),

  /* modpack導入(v0.4) */
  packSearch: (query, offset) => ipcRenderer.invoke('pack:search', query, offset),
  packVersions: (id) => ipcRenderer.invoke('pack:versions', id),
  packAnalyze: (filePath) => ipcRenderer.invoke('pack:analyze', filePath),
  packInstall: (opts) => ipcRenderer.invoke('pack:install', opts),
  packCancel: () => ipcRenderer.send('pack:cancel'),
  packDiscard: () => ipcRenderer.invoke('pack:discard'),
  pickPack: () => ipcRenderer.invoke('dialog:pick-pack'),

  /* その他 */
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  openFolder: (dir) => ipcRenderer.send('shell:open-folder', dir),
  openExternal: (u) => ipcRenderer.send('open-external', u),
  restartToUpdate: () => ipcRenderer.send('update:restart'),

  /* mainからの押し出し */
  onConsole: (cb) => ipcRenderer.on('console:lines', (e, p) => cb(p)),
  onState: (cb) => ipcRenderer.on('server:state', (e, p) => cb(p)),
  onPlayers: (cb) => ipcRenderer.on('server:players', (e, p) => cb(p)),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', (e, d) => cb(d)),
  onCreateProgress: (cb) => ipcRenderer.on('create:progress', (e, p) => cb(p)),
  onPackProgress: (cb) => ipcRenderer.on('pack:progress', (e, p) => cb(p)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, v) => cb(v)),
  onModsChanged: (cb) => ipcRenderer.on('mods:changed', (e, p) => cb(p)),

  /* テスト用 */
  devFlattenPaper: (obj) => ipcRenderer.invoke('dev:flatten-paper', obj),
  devPlayerLine: (line) => ipcRenderer.invoke('dev:player-line', line),
  devPropsRoundtrip: (text, changes) => ipcRenderer.invoke('dev:props-roundtrip', text, changes),
  devRegister: (opts) => ipcRenderer.invoke('dev:register', opts),
  devDownload: (opts) => ipcRenderer.invoke('dev:download', opts),
  devDetect: (dir) => ipcRenderer.invoke('dev:detect', dir)
});
