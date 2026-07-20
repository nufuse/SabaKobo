/**
 * wizard.js — 新規鯖の作成ウィザード
 * 種類 → バージョン → 名前/作成先 → メモリ/ポート → EULA同意 → 作成(進捗表示)
 */
'use strict';

const Wizard = {
  customRoot: null, /* 「親フォルダを変更」で選んだセッション限りの作成先 */
  _logLines: [],    /* インストーラ出力の表示用バッファ(直近150行) */

  wire() {
    document.querySelector('#btn-new').addEventListener('click', () => Wizard.open());
    document.querySelector('#wz-close').addEventListener('click', () => Wizard.close());
    document.querySelector('#wz-create').addEventListener('click', () => Wizard.run());
    document.querySelector('#wz-abort').addEventListener('click', () => saba.createCancel());
    document.querySelector('#wz-eula-link').addEventListener('click', e => {
      e.preventDefault();
      saba.openExternal('https://aka.ms/MinecraftEULA');
    });
    document.querySelector('#wz-dir-btn').addEventListener('click', async () => {
      const p = await saba.pickFolder();
      if (p) { Wizard.customRoot = p; Wizard.updateDir(); }
    });
    for (const r of document.querySelectorAll('input[name=wz-loader]')) {
      r.addEventListener('change', () => { Wizard.loadVersions(); Wizard.updateJavaNote(); });
    }
    document.querySelector('#wz-version').addEventListener('change', () => Wizard.updateJavaNote());
    document.querySelector('#wz-name').addEventListener('input', () => Wizard.updateDir());

    /* メモリスライダー: 常に Xms ≦ Xmx を保つ(片方を動かすともう片方が追従) */
    const xms = document.querySelector('#wz-xms');
    const xmx = document.querySelector('#wz-xmx');
    xms.addEventListener('input', () => {
      if (Number(xms.value) > Number(xmx.value)) xmx.value = xms.value;
      Wizard.updateRamLabels();
    });
    xmx.addEventListener('input', () => {
      if (Number(xmx.value) < Number(xms.value)) xms.value = xmx.value;
      Wizard.updateRamLabels();
    });

    saba.onCreateProgress(p => Wizard.onProgress(p));
  },

  loader() {
    return document.querySelector('input[name=wz-loader]:checked').value;
  },

  async open() {
    document.querySelector('#wizard-overlay').hidden = false;
    document.querySelector('#wz-form').hidden = false;
    document.querySelector('#wz-progress').hidden = true;
    document.querySelector('#wz-error').hidden = true;
    document.querySelector('#wz-log').textContent = '';
    document.querySelector('#wz-bar').style.width = '0%';
    Wizard.updateDir();
    Wizard.loadVersions();
    Wizard.updateRamLabels();
    /* 既定ポートは「実際に空いている番号」(手元の鯖が全部25565固まり対策) */
    const port = await saba.suggestPort();
    document.querySelector('#wz-port').value = port;
  },

  updateRamLabels() {
    const xms = Number(document.querySelector('#wz-xms').value);
    const xmx = Number(document.querySelector('#wz-xmx').value);
    document.querySelector('#wz-xms-val').textContent = xms + ' GB';
    document.querySelector('#wz-xmx-val').textContent = xmx + ' GB';
    const ram = App.state.ramGB || 0;
    const hint = document.querySelector('#wz-ram-hint');
    hint.textContent = ram
      ? `このPCのメモリ: ${ram} GB` + (xmx > ram / 2 ? ' ⚠ 上限が半分を超えています(他の作業が重くなるかも)' : '')
      : '';
  },

  close() {
    document.querySelector('#wizard-overlay').hidden = true;
  },

  async loadVersions() {
    const sel = document.querySelector('#wz-version');
    const note = document.querySelector('#wz-loader-note');
    sel.innerHTML = '<option>読み込み中…</option>';
    note.textContent = {
      paper: '',
      fabric: '初回起動時にライブラリをネットから取得します',
      forge: 'インストーラを実行します(数分かかることがあります)',
      neoforge: 'インストーラを実行します(数分かかることがあります)',
      vanilla: ''
    }[Wizard.loader()] || '';

    const loader = Wizard.loader();
    const r = await saba.createVersions(loader);
    if (Wizard.loader() !== loader) return; /* 読み込み中に切り替えられた */
    if (!r.ok) {
      sel.innerHTML = '<option value="">(取得失敗)</option>';
      Wizard.showError(r.error);
      return;
    }
    sel.innerHTML = '';
    for (const v of r.versions) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    }
    Wizard.updateJavaNote();
  },

  async updateJavaNote() {
    const mc = document.querySelector('#wz-version').value;
    const el = document.querySelector('#wz-java-note');
    if (!mc) { el.textContent = '—'; return; }
    const j = await saba.javaFor(mc, Wizard.loader());
    if (j.ok) {
      el.textContent = `Java ${j.major} を使います (${j.version})`;
    } else {
      el.textContent = `⚠ ${j.error} `;
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Adoptiumから入手';
      a.addEventListener('click', ev => { ev.preventDefault(); saba.openExternal('https://adoptium.net/temurin/releases/'); });
      el.appendChild(a);
    }
  },

  updateDir() {
    const name = document.querySelector('#wz-name').value.trim();
    const root = Wizard.customRoot || (App.state.data && App.state.data.newServerRoot) || '';
    document.querySelector('#wz-dir').textContent = root + '\\' + (name || '(名前)');
  },

  showError(msg) {
    const el = document.querySelector('#wz-error');
    el.textContent = '⚠ ' + msg;
    el.hidden = false;
  },

  async run() {
    document.querySelector('#wz-error').hidden = true;
    const name = document.querySelector('#wz-name').value.trim();
    const mc = document.querySelector('#wz-version').value;
    const eula = document.querySelector('#wz-eula').checked;
    const port = Number(document.querySelector('#wz-port').value);

    if (!name) return Wizard.showError('名前を入れてください');
    if (/[\\/:*?"<>|]/.test(name)) return Wizard.showError('名前に使えない文字( \\ / : * ? " < > | )が入っています');
    if (!mc) return Wizard.showError('バージョンを選んでください');
    if (!eula) return Wizard.showError('EULAに同意してください(チェックボックス)');

    const opts = {
      loader: Wizard.loader(),
      mc, name, eula, port,
      xms: document.querySelector('#wz-xms').value + 'G',
      xmx: document.querySelector('#wz-xmx').value + 'G',
      dir: Wizard.customRoot ? Wizard.customRoot + '\\' + name : undefined
    };

    document.querySelector('#wz-form').hidden = true;
    document.querySelector('#wz-progress').hidden = false;
    document.querySelector('#wz-phase').textContent = '準備中…';
    Wizard._logLines = [];
    document.querySelector('#wz-log').textContent = '';

    const r = await saba.createRun(opts);
    if (!r.ok) {
      document.querySelector('#wz-form').hidden = false;
      document.querySelector('#wz-progress').hidden = true;
      Wizard.showError(r.error);
      return;
    }
    Wizard.close();
    App.toast(`✅ 「${r.server.name}」を作りました。▶で初回起動できます`);
    View.select(r.server.id);
  },

  onProgress(p) {
    const phase = document.querySelector('#wz-phase');
    const bar = document.querySelector('#wz-bar');
    if (p.phase === 'download') {
      const mb = b => (b / 1024 / 1024).toFixed(1);
      if (p.total > 0) {
        phase.textContent = `ダウンロード中… ${mb(p.got)} / ${mb(p.total)} MB`;
        bar.style.width = Math.round(p.got / p.total * 100) + '%';
      } else {
        phase.textContent = `ダウンロード中… ${mb(p.got)} MB`;
      }
    } else if (p.phase === 'installer') {
      const loaderName = Wizard.loader() === 'neoforge' ? 'NeoForge' : 'Forge';
      phase.textContent = `${loaderName}インストーラを実行中…(数分かかることがあります)`;
      bar.style.width = '100%';
      /* mainから150msごとに束ねて届く。表示は直近150行だけ(全行描画すると凍る) */
      const log = document.querySelector('#wz-log');
      Wizard._logLines.push(...(p.lines || []));
      if (Wizard._logLines.length > 150) Wizard._logLines.splice(0, Wizard._logLines.length - 150);
      log.textContent = Wizard._logLines.join('\n');
      log.scrollTop = log.scrollHeight;
    } else if (p.phase === 'finish') {
      phase.textContent = '仕上げ中…';
      bar.style.width = '100%';
    }
  }
};
