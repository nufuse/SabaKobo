/**
 * props.js — サーバー設定(server.properties)の「選んで押すだけ」エディタ
 * よく使う項目は日本語ラベル+プルダウン/スイッチ、残りは「その他」に生の表。
 * 保存は変更した項目だけをmainへ送る(順序・コメント・日本語はmain側エディタが保全)。
 */
'use strict';

const PROP_DEFS = [
  { key: 'motd', label: 'サーバーの説明(MOTD)', type: 'text', hint: 'サーバー一覧に出る説明文' },
  { key: 'max-players', label: '最大人数', type: 'number', min: 1, max: 1000 },
  { key: 'difficulty', label: '難易度', type: 'select', options: [['peaceful', 'ピースフル'], ['easy', 'イージー'], ['normal', 'ノーマル'], ['hard', 'ハード']] },
  { key: 'gamemode', label: '初期ゲームモード', type: 'select', options: [['survival', 'サバイバル'], ['creative', 'クリエイティブ'], ['adventure', 'アドベンチャー'], ['spectator', 'スペクテイター']] },
  { key: 'pvp', label: 'PvP(プレイヤー同士の攻撃)', type: 'bool' },
  { key: 'white-list', label: 'ホワイトリスト(許可した人だけ入れる)', type: 'bool' },
  { key: 'online-mode', label: 'オンラインモード(正規アカウント認証)', type: 'bool', hint: 'OFFにするのは特殊な用途のときだけ推奨' },
  { key: 'enable-command-block', label: 'コマンドブロック', type: 'bool' },
  { key: 'view-distance', label: '描画距離(チャンク)', type: 'number', min: 2, max: 32 },
  { key: 'simulation-distance', label: '処理距離(チャンク)', type: 'number', min: 2, max: 32 },
  { key: 'spawn-protection', label: 'スポーン保護範囲', type: 'number', min: 0, max: 1000 },
  { key: 'server-port', label: 'ポート', type: 'number', min: 1, max: 65535, hint: '変更すると接続アドレスの:番号も変わる' },
  { key: 'level-name', label: 'ワールド(フォルダ名)', type: 'text', hint: '⚠ 変更は「別ワールドへの切替」。フォルダ名の変更ではない' }
];

const Props = {
  initial: {}, /* 開いた時点の値(差分検出用) */

  wire() {
    document.querySelector('#btn-props').addEventListener('click', () => Props.open());
    document.querySelector('#props-close').addEventListener('click', () => Props.close());
    document.querySelector('#props-save').addEventListener('click', () => Props.save());
  },

  async open() {
    const s = App.findServer(App.state.activeId);
    if (!s) return;
    const r = await saba.propsRead(s.id);
    if (!r.ok) { App.toast('⚠ ' + r.error); return; }

    document.querySelector('#props-name').textContent = s.name;
    document.querySelector('#props-error').hidden = true;
    const note = document.querySelector('#props-note');
    const form = document.querySelector('#props-form');
    const raw = document.querySelector('#props-raw');
    form.innerHTML = '';
    raw.innerHTML = '';

    if (!r.exists) {
      note.textContent = 'server.properties がまだありません。初回起動(▶)すると作られます。';
      document.querySelector('#props-save').disabled = true;
      document.querySelector('#props-raw-box').hidden = true;
      document.querySelector('#props-overlay').hidden = false;
      return;
    }
    document.querySelector('#props-save').disabled = false;
    document.querySelector('#props-raw-box').hidden = false;
    note.textContent = App.statusOf(s.id) === 'running'
      ? '⚠ サーバーが起動中です。変更は保存できますが、反映は次回起動からです。'
      : '変更は次回の起動から反映されます。';

    Props.initial = { ...r.values };

    /* よく使う項目(ファイルに存在するものだけ出す) */
    for (const def of PROP_DEFS) {
      if (!(def.key in r.values)) continue;
      form.appendChild(Props.buildRow(def, r.values[def.key]));
    }
    /* その他(定義に無いキー全部) */
    const known = new Set(PROP_DEFS.map(d => d.key));
    for (const key of r.keys) {
      if (known.has(key)) continue;
      const row = document.createElement('div');
      row.className = 'pr-raw-row';
      const lab = document.createElement('code');
      lab.textContent = key;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = r.values[key];
      input.dataset.key = key;
      row.appendChild(lab);
      row.appendChild(input);
      raw.appendChild(row);
    }

    document.querySelector('#props-overlay').hidden = false;
  },

  buildRow(def, value) {
    const row = document.createElement('div');
    row.className = 'pr-row';
    const lab = document.createElement('label');
    lab.className = 'pr-label';
    lab.textContent = def.label;
    row.appendChild(lab);

    let input;
    if (def.type === 'select') {
      input = document.createElement('select');
      for (const [v, jp] of def.options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = `${jp} (${v})`;
        input.appendChild(o);
      }
      if (![...input.options].some(o => o.value === value)) {
        const o = document.createElement('option'); /* 知らない値はそのまま残す */
        o.value = value; o.textContent = value;
        input.appendChild(o);
      }
      input.value = value;
    } else if (def.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'pr-toggle';
      input.checked = value === 'true';
    } else {
      input = document.createElement('input');
      input.type = def.type; /* text / number */
      if (def.min != null) input.min = def.min;
      if (def.max != null) input.max = def.max;
      input.value = value;
    }
    input.dataset.key = def.key;
    row.appendChild(input);

    if (def.hint) {
      const hint = document.createElement('span');
      hint.className = 'muted';
      hint.textContent = def.hint;
      row.appendChild(hint);
    }
    return row;
  },

  collectChanges() {
    const changes = {};
    for (const el of document.querySelectorAll('#props-form [data-key], #props-raw [data-key]')) {
      const key = el.dataset.key;
      const val = el.type === 'checkbox' ? String(el.checked) : String(el.value);
      if (val !== Props.initial[key]) changes[key] = val;
    }
    return changes;
  },

  async save() {
    const changes = Props.collectChanges();
    if (Object.keys(changes).length === 0) { App.toast('変更はありません'); return; }
    const r = await saba.propsWrite(App.state.activeId, changes);
    if (!r.ok) {
      const el = document.querySelector('#props-error');
      el.textContent = '⚠ ' + r.error;
      el.hidden = false;
      return;
    }
    Props.close();
    App.toast(r.running ? '✅ 保存しました(反映は次回起動から)' : '✅ 保存しました');
    View.updateHead(); /* ポート変更のバッジ反映 */
  },

  close() {
    document.querySelector('#props-overlay').hidden = true;
  }
};

/* ── 削除モーダル ───────────────────── */
const Remove = {
  wire() {
    document.querySelector('#btn-remove').addEventListener('click', () => Remove.open());
    document.querySelector('#rm-cancel').addEventListener('click', () => Remove.close());
    document.querySelector('#rm-unregister').addEventListener('click', () => Remove.run('unregister'));
    document.querySelector('#rm-trash').addEventListener('click', () => Remove.run('trash'));
  },

  open() {
    const s = App.findServer(App.state.activeId);
    if (!s) return;
    if (App.statusOf(s.id) !== 'stopped') { App.toast('⚠ 停止してから削除してください'); return; }
    document.querySelector('#rm-name').textContent = s.name;
    document.querySelector('#rm-dir').textContent = s.dir;
    document.querySelector('#remove-overlay').hidden = false;
  },

  async run(mode) {
    const id = App.state.activeId;
    const s = App.findServer(id);
    const r = await saba.remove(id, mode);
    Remove.close();
    if (!r.ok) { App.toast('⚠ ' + r.error); return; }
    App.state.activeId = null;
    document.querySelector('#server-view').hidden = true;
    document.querySelector('#placeholder').hidden = false;
    App.toast(r.trashed ? `🗑 「${s.name}」をゴミ箱へ移動しました` : `「${s.name}」を一覧から外しました(フォルダは残っています)`);
  },

  close() {
    document.querySelector('#remove-overlay').hidden = true;
  }
};
