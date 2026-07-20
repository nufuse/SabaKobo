/**
 * app.js — 状態の置き場と起動処理
 * window.Saba にテスト用の入口を晒す(CmdKoboがApp.gameを晒しているのと同じ作法)
 */
'use strict';

const App = {
  state: {
    data: null,      /* レジストリ(mainが正本、こちらは写し) */
    javas: [],
    states: {},      /* id → {status, crashed, ...} */
    players: {},     /* id → [名前] */
    ops: {},         /* id → [OPの名前] */
    activeId: null
  },

  async boot() {
    const init = await saba.init();
    App.state.data = init.data;
    App.state.javas = init.javas;
    App.state.ramGB = init.ramGB;
    for (const id of init.running) App.state.states[id] = { status: 'running' };
    document.querySelector('#app-version').textContent = 'v' + init.version;

    /* mainからの押し出しを購読 */
    saba.onDataChanged(d => { App.state.data = d; List.render(); });
    saba.onState(p => {
      App.state.states[p.id] = p;
      List.render();
      if (p.id === App.state.activeId) View.updateHead();
      if (p.status === 'stopped' && p.crashed) {
        const s = App.findServer(p.id);
        App.toast(`⚠ 「${s ? s.name : '?'}」が想定外に停止しました(コード ${p.code})`);
      }
      if (p.status === 'error') App.toast('⚠ ' + p.message);
    });
    saba.onConsole(p => ConsoleUI.onLines(p));
    saba.onUpdateReady(v => App.toast(`更新 v${v} を準備しました。再起動で適用されます`));

    List.render();
    View.wire();
    ConsoleUI.wire();
    Wizard.wire();
    Players.wire();
    Props.wire();
    Remove.wire();
    Mods.wire();
  },

  findServer(id) {
    return (App.state.data.servers || []).find(s => s.id === id);
  },

  statusOf(id) {
    return (App.state.states[id] && App.state.states[id].status) || 'stopped';
  },

  toast(msg, ms = 3500) {
    const t = document.querySelector('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
};

/* ── 鯖ビュー(ヘッダー部) ── */
const View = {
  wire() {
    document.querySelector('#btn-start').addEventListener('click', async () => {
      const id = App.state.activeId;
      if (!id) return;
      const r = await saba.start(id);
      if (!r.ok) App.toast('⚠ ' + r.error);
    });
    document.querySelector('#btn-stop').addEventListener('click', () => {
      const id = App.state.activeId;
      if (id) saba.stop(id);
    });
    document.querySelector('#btn-folder').addEventListener('click', () => {
      const s = App.findServer(App.state.activeId);
      if (s) saba.openFolder(s.dir);
    });
    document.querySelector('#btn-mods').addEventListener('click', () => Mods.open());
  },

  async select(id) {
    App.state.activeId = id;
    document.querySelector('#placeholder').hidden = true;
    document.querySelector('#server-view').hidden = false;
    List.render();
    View.updateHead();
    await ConsoleUI.load(id);
    await Players.load(id);
    Players.render();
  },

  async updateHead() {
    const s = App.findServer(App.state.activeId);
    if (!s) return;
    const loaderLabel = { paper: 'Paper', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla', unknown: '不明' }[s.loader] || s.loader;
    document.querySelector('#sv-name').textContent = s.name;
    document.querySelector('#sv-loader').textContent = loaderLabel + (s.loaderVersion ? ' ' + s.loaderVersion : '');
    document.querySelector('#sv-mc').textContent = 'MC ' + (s.mcVersion || '?');
    document.querySelector('#sv-port').textContent = 'ポート ' + (s.port || '?');

    /* どのJavaで動くかを常に見せる(魔法にしない) */
    const jEl = document.querySelector('#sv-java');
    jEl.textContent = 'Java …';
    saba.javaFor(s.mcVersion, s.loader).then(j => {
      if (App.state.activeId !== s.id) return;
      jEl.textContent = j.ok ? `Java ${j.major}` : '⚠ ' + j.required;
    });

    const st = App.statusOf(s.id);
    const crashed = App.state.states[s.id] && App.state.states[s.id].crashed;
    const pill = document.querySelector('#sv-status');
    const map = {
      running: ['pill-running', '起動中'],
      stopping: ['pill-stopping', '停止処理中…'],
      stopped: crashed ? ['pill-crashed', 'クラッシュ'] : ['pill-stopped', '停止中']
    };
    const [cls, label] = map[st] || map.stopped;
    pill.className = 'pill ' + cls;
    pill.textContent = label;

    document.querySelector('#btn-start').hidden = st !== 'stopped';
    document.querySelector('#btn-stop').hidden = st === 'stopped';
    document.querySelector('#btn-stop').disabled = st === 'stopping';
    document.querySelector('#console-input').disabled = st !== 'running';
    document.querySelector('#console-send').disabled = st !== 'running';
    document.querySelector('#btn-remove').disabled = st !== 'stopped';

    /* プラグイン/Modはローダーに概念があるものだけ(mods.jsのFOLDER_BY_LOADERと同じ対応) */
    const hasMods = ['paper', 'fabric', 'forge', 'neoforge'].includes(s.loader);
    const modsBtn = document.querySelector('#btn-mods');
    modsBtn.disabled = !hasMods;
    modsBtn.title = hasMods ? 'プラグイン/Mod' : 'このローダーにはプラグイン/Modの概念がありません';

    Players.render();
  }
};

window.Saba = { state: App.state, App, View }; /* CDPテスト用の入口 */
