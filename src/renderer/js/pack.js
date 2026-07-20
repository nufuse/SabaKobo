/**
 * pack.js — modpack導入モーダル(v0.4)
 * Modrinth検索 or .mrpackファイルから、Fabric/Forge/NeoForgeのmodpackサーバーを組み立てる。
 * wizard.js(1モーダル内で画面を切り替える作り)を下敷きにしている。
 */
'use strict';

/* mrpackのローダー名 → 表示名(showConfig・バージョン一覧の両方で使う) */
const LOADER_LABELS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const LOADER_TAGS = ['fabric', 'forge', 'neoforge', 'quilt']; /* Modrinthのcategoriesのうちローダーを表すもの */
const SERVER_SIDE_LABELS = { required: 'サーバー必須', optional: 'サーバー任意', unsupported: 'サーバー非対応' };

const Pack = {
  current: null,      /* 設定画面/確認画面に渡した情報(analysisId経由 or download経由) */
  customRoot: null,   /* 「親フォルダを変更」で選んだセッション限りの作成先(wizard.jsと同じ流儀) */
  _hit: null,         /* 検索で選んだmodpackのヒット(バージョン選択画面のタイトル・鯖名初期値に使う) */
  _query: '',
  _offset: 0,
  _total: 0,
  _searchToken: 0,    /* 検索の世代番号(古い検索結果が後から来て上書きするのを防ぐ) */
  _logLines: [],      /* インストーラ出力の表示用バッファ(直近150行) */
  _aborting: false,   /* 中止ボタンが押されたか(installの失敗が中止由来かエラーかの見分け) */

  wire() {
    document.querySelector('#btn-pack').addEventListener('click', () => Pack.open());
    document.querySelector('#pk-close').addEventListener('click', () => Pack.close());
    document.querySelector('#pk-config-close').addEventListener('click', () => Pack.close());
    document.querySelector('#pk-progress-close').addEventListener('click', () => Pack.close());
    document.querySelector('#pk-abort').addEventListener('click', () => Pack.abort());
    document.querySelector('#pk-eula-link').addEventListener('click', e => {
      e.preventDefault();
      saba.openExternal('https://aka.ms/MinecraftEULA');
    });

    /* 確認画面(serverpack=CurseForgeサーバーパックzip経由) */
    document.querySelector('#pkc-close').addEventListener('click', () => Pack.close());
    document.querySelector('#pkc-eula-link').addEventListener('click', e => {
      e.preventDefault();
      saba.openExternal('https://aka.ms/MinecraftEULA');
    });
    document.querySelector('#pkc-eula').addEventListener('change', e => {
      document.querySelector('#pkc-install').disabled = !e.target.checked;
    });
    document.querySelector('#pkc-install').addEventListener('click', () => Pack.runConfirm());
    document.querySelector('#pkc-name').addEventListener('input', () => Pack.updateConfirmDir());

    /* 作成先フォルダの変更(設定画面・確認画面の両方。wizard.jsと同じ流儀) */
    document.querySelector('#pk-dir-btn').addEventListener('click', async () => {
      const p = await saba.pickFolder();
      if (p) { Pack.customRoot = p; Pack.updateDir(); }
    });
    document.querySelector('#pkc-dir-btn').addEventListener('click', async () => {
      const p = await saba.pickFolder();
      if (p) { Pack.customRoot = p; Pack.updateConfirmDir(); }
    });

    document.querySelector('#pk-tab-search').addEventListener('click', () => Pack.tab('search'));
    document.querySelector('#pk-tab-file').addEventListener('click', () => Pack.tab('file'));

    document.querySelector('#pk-search-form').addEventListener('submit', e => { e.preventDefault(); Pack.search(false); });
    document.querySelector('#pk-more').addEventListener('click', () => Pack.search(true));

    document.querySelector('#pk-pick-btn').addEventListener('click', () => Pack.pickFile());
    document.querySelector('#pk-versions-back').addEventListener('click', () => {
      saba.packDiscard(); /* 進捗画面以外から入口画面へ戻るので、保留中の解析結果があれば破棄する */
      Pack.showScreen('entry');
    });

    document.querySelector('#pk-eula').addEventListener('change', e => {
      document.querySelector('#pk-install').disabled = !e.target.checked;
    });
    document.querySelector('#pk-install').addEventListener('click', () => Pack.run());
    document.querySelector('#pk-name').addEventListener('input', () => Pack.updateDir());

    /* メモリスライダー: 常にXms≦Xmxを保つ(wizard.jsと同じ追従ロジック) */
    const xms = document.querySelector('#pk-xms');
    const xmx = document.querySelector('#pk-xmx');
    xms.addEventListener('input', () => {
      if (Number(xms.value) > Number(xmx.value)) xmx.value = xms.value;
      Pack.updateRamLabels();
    });
    xmx.addEventListener('input', () => {
      if (Number(xmx.value) < Number(xms.value)) xms.value = xmx.value;
      Pack.updateRamLabels();
    });

    /* 確認画面側のメモリスライダー(同じ追従ロジック) */
    const pkcXms = document.querySelector('#pkc-xms');
    const pkcXmx = document.querySelector('#pkc-xmx');
    pkcXms.addEventListener('input', () => {
      if (Number(pkcXms.value) > Number(pkcXmx.value)) pkcXmx.value = pkcXms.value;
      Pack.updateConfirmRamLabels();
    });
    pkcXmx.addEventListener('input', () => {
      if (Number(pkcXmx.value) < Number(pkcXms.value)) pkcXms.value = pkcXmx.value;
      Pack.updateConfirmRamLabels();
    });

    /* ドラッグ&ドロップ: モーダル全体で受ける(mods.jsと同じ流儀) */
    const overlay = document.querySelector('#pack-overlay');
    const dropZone = document.querySelector('#pk-dropzone');
    overlay.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('pk-drop-hot'); });
    overlay.addEventListener('dragleave', () => dropZone.classList.remove('pk-drop-hot'));
    overlay.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('pk-drop-hot');
      Pack.handleDrop(e.dataTransfer.files);
    });

    saba.onPackProgress(p => Pack.onProgress(p));
  },

  /* ── 画面切り替え ─────────────────── */
  showScreen(name) {
    document.querySelector('#pk-entry').hidden = name !== 'entry';
    document.querySelector('#pk-versions').hidden = name !== 'versions';
    document.querySelector('#pk-config').hidden = name !== 'config';
    document.querySelector('#pk-confirm').hidden = name !== 'confirm';
    document.querySelector('#pk-progress').hidden = name !== 'progress';
  },

  tab(name) {
    const isSearch = name === 'search';
    document.querySelector('#pk-tab-search').classList.toggle('pk-tab-active', isSearch);
    document.querySelector('#pk-tab-file').classList.toggle('pk-tab-active', !isSearch);
    document.querySelector('#pk-pane-search').hidden = !isSearch;
    document.querySelector('#pk-pane-file').hidden = isSearch;
  },

  async open() {
    document.querySelector('#pack-overlay').hidden = false;
    Pack.tab('search');
    Pack.showScreen('entry');
    document.querySelector('#pk-search-box').value = '';
    document.querySelector('#pk-file-error').hidden = true;
    document.querySelector('#pk-confirm-error').hidden = true;
    document.querySelector('#pk-results').innerHTML = '';
    document.querySelector('#pk-more').hidden = true;
    Pack._query = '';
    Pack._offset = 0;
    Pack._total = 0;
    await Pack.search(false); /* 開いた直後は人気順(query空)を自動表示 */
  },

  close() {
    saba.packDiscard(); /* 導入せずに閉じた解析結果(workDir)を破棄する。導入中はこのボタンに到達しない */
    document.querySelector('#pack-overlay').hidden = true;
  },

  /* ── 検索(Modrinth) ───────────────── */
  async search(loadMore) {
    if (!loadMore) { Pack._query = document.querySelector('#pk-search-box').value.trim(); Pack._offset = 0; }
    const offset = loadMore ? Pack._offset : 0;
    const token = ++Pack._searchToken;
    document.querySelector('#pk-more').disabled = true;

    const r = await saba.packSearch(Pack._query, offset);
    if (token !== Pack._searchToken) return; /* 途中で別の検索に切り替えられた */
    if (!r.ok) { App.toast('⚠ ' + r.error); return; }

    Pack._total = r.total;
    Pack._offset = offset + r.hits.length;
    Pack.renderResults(r.hits, loadMore);
    document.querySelector('#pk-results-empty').hidden = !(!loadMore && r.hits.length === 0);
    document.querySelector('#pk-more').hidden = r.hits.length === 0 || Pack._offset >= r.total;
    document.querySelector('#pk-more').disabled = false;
  },

  renderResults(hits, append) {
    const list = document.querySelector('#pk-results');
    if (!append) list.innerHTML = '';
    for (const hit of hits) {
      const row = document.createElement('div');
      row.className = 'pk-row';

      let icon;
      if (hit.iconUrl) {
        icon = document.createElement('img');
        icon.className = 'pk-icon';
        icon.src = hit.iconUrl;
        icon.alt = '';
      } else {
        icon = document.createElement('div');
        icon.className = 'pk-icon';
      }

      const info = document.createElement('div');
      info.className = 'pk-info';
      const titleRow = document.createElement('div');
      titleRow.className = 'pk-title-row';
      const title = document.createElement('span');
      title.className = 'pk-title';
      title.textContent = hit.title;
      const dl = document.createElement('span');
      dl.className = 'pk-dl';
      dl.textContent = Pack.formatDownloads(hit.downloads);
      titleRow.appendChild(title);
      titleRow.appendChild(dl);

      const desc = document.createElement('div');
      desc.className = 'pk-desc';
      desc.textContent = hit.description || '';

      info.appendChild(titleRow);
      info.appendChild(desc);

      const badges = document.createElement('div');
      badges.className = 'pk-badges';
      for (const c of (hit.categories || [])) {
        if (LOADER_TAGS.includes(c)) badges.appendChild(Pack.badge(LOADER_LABELS[c] || c));
      }
      if (hit.serverSide) badges.appendChild(Pack.badge(SERVER_SIDE_LABELS[hit.serverSide] || hit.serverSide));

      row.appendChild(icon);
      row.appendChild(info);
      row.appendChild(badges);
      row.addEventListener('click', () => Pack.selectHit(hit));
      list.appendChild(row);
    }
  },

  badge(text) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = text;
    return b;
  },

  formatDownloads(n) {
    n = Number(n) || 0;
    return n >= 10000 ? Math.round(n / 10000) + '万DL' : n + 'DL';
  },

  /* ── バージョン選択(検索経由のみ) ─────── */
  async selectHit(hit) {
    Pack._hit = hit;
    document.querySelector('#pk-versions-title').textContent = hit.title;
    document.querySelector('#pk-versions-list').innerHTML = '<p class="muted">読み込み中…</p>';
    Pack.showScreen('versions');

    const r = await saba.packVersions(hit.projectId);
    if (!r.ok) {
      App.toast('⚠ ' + r.error);
      Pack.showScreen('entry');
      return;
    }
    Pack.renderVersions(r.versions);
  },

  renderVersions(versions) {
    const list = document.querySelector('#pk-versions-list');
    list.innerHTML = '';
    if (versions.length === 0) {
      list.innerHTML = '<p class="muted">導入可能なバージョン(.mrpack)が見つかりません</p>';
      return;
    }
    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'pk-row';

      const info = document.createElement('div');
      info.className = 'pk-info';
      const title = document.createElement('div');
      title.className = 'pk-title';
      title.textContent = v.versionNumber;
      const desc = document.createElement('div');
      desc.className = 'pk-desc';
      const loaderText = (v.loaders || []).map(l => LOADER_LABELS[l] || l).join(', ');
      desc.textContent = `MC ${(v.gameVersions || []).join(', ')} ・ ${loaderText} ・ ${(v.date || '').slice(0, 10)}`;
      info.appendChild(title);
      info.appendChild(desc);

      row.appendChild(info);
      row.addEventListener('click', () => Pack.selectVersion(v));
      list.appendChild(row);
    }
  },

  selectVersion(v) {
    Pack.showConfig({
      download: { url: v.file.url, size: v.file.size, sha512: v.file.sha512, versionId: v.id },
      name: (Pack._hit && Pack._hit.title) || v.name,
      mcVersion: (v.gameVersions && v.gameVersions.length) ? v.gameVersions.join(', ') : '?',
      loader: (v.loaders && v.loaders[0]) || null
    });
  },

  /* ── ファイルから ─────────────────── */
  async pickFile() {
    const p = await saba.pickPack();
    if (!p) return;
    await Pack.analyzeAndShowConfig(p);
  },

  async handleDrop(files) {
    Pack.tab('file');
    const file = files[0];
    if (!file) return;
    const p = saba.pathForFile(file);
    if (!/\.(mrpack|zip)$/i.test(p)) {
      document.querySelector('#pk-file-error').textContent = '対応形式は .mrpack・.zip です';
      document.querySelector('#pk-file-error').hidden = false;
      return;
    }
    await Pack.analyzeAndShowConfig(p);
  },

  async analyzeAndShowConfig(p) {
    const r = await saba.packAnalyze(p);
    if (!r.ok) {
      document.querySelector('#pk-file-error').textContent = '⚠ ' + r.error;
      document.querySelector('#pk-file-error').hidden = false;
      return;
    }
    document.querySelector('#pk-file-error').hidden = true;
    if (r.kind === 'serverpack') {
      /* CurseForgeサーバーパックzip: マニフェストに鯖名が無いため、ファイル名を初期値にする */
      const base = p.split(/[\\/]/).pop().replace(/\.zip$/i, '');
      await Pack.showConfirm({ ...r, name: base });
    } else {
      await Pack.showConfig(r);
    }
  },

  /* ── 設定画面(mrpack。ファイル・Modrinth検索・zip内mrpackの3経路が合流) ───────────
     infoは analysisId(ファイル経由) か download(Modrinth経由) のどちらかを持つ */
  async showConfig(info) {
    Pack.current = info;
    document.querySelector('#pk-name').value = info.name || 'modpack';
    document.querySelector('#pk-mc-badge').textContent = 'MC ' + (info.mcVersion || '?');
    document.querySelector('#pk-loader-badge').textContent =
      (LOADER_LABELS[info.loader] || info.loader || '?') + (info.loaderVersion ? ' ' + info.loaderVersion : '');

    const fileInfo = document.querySelector('#pk-file-info');
    if (info.analysisId) {
      fileInfo.textContent = `ファイル数 ${info.fileCount}件・合計 ${Pack.formatSize(info.totalSize)}`;
      fileInfo.hidden = false;
    } else {
      fileInfo.hidden = true;
    }

    /* modpackは重いので既定Xms 2G/Xmx 6G */
    document.querySelector('#pk-xms').value = 2;
    document.querySelector('#pk-xmx').value = 6;
    Pack.updateRamLabels();

    document.querySelector('#pk-eula').checked = false;
    document.querySelector('#pk-install').disabled = true;
    document.querySelector('#pk-config-error').hidden = true;

    Pack.showScreen('config');
    Pack.updateDir();
    /* 既定ポートは「実際に空いている番号」(手元の鯖が全部25565固まり対策) */
    const port = await saba.suggestPort();
    document.querySelector('#pk-port').value = port;
  },

  updateDir() {
    const name = document.querySelector('#pk-name').value.trim();
    const root = Pack.customRoot || (App.state.data && App.state.data.newServerRoot) || '';
    document.querySelector('#pk-dir').textContent = root + '\\' + (name || '(名前)');
  },

  /* ── 確認画面(serverpack。CurseForgeサーバーパックzip経由。自動判別を全項目手直しできる) ───
     infoは analysisId・estimate(loader/mcVersion/loaderVersion/jar/xms/xmx)・hasLoaderFilesを持つ */
  async showConfirm(info) {
    Pack.current = info;
    const est = info.estimate || {};

    document.querySelector('#pkc-loader').value = est.loader || '';
    document.querySelector('#pkc-mc').value = est.mcVersion || '';
    document.querySelector('#pkc-loaderver').value = est.loaderVersion || '';
    document.querySelector('#pkc-name').value = info.name || 'サーバーパック';

    /* メモリは見積もりがあればそれを初期値に、無ければmodpack共通の既定(2G/6G) */
    document.querySelector('#pkc-xms').value = est.xms || 2;
    document.querySelector('#pkc-xmx').value = est.xmx || 6;
    Pack.updateConfirmRamLabels();

    document.querySelector('#pkc-eula').checked = false;
    document.querySelector('#pkc-install').disabled = true;
    document.querySelector('#pk-confirm-error').hidden = true;

    Pack.showScreen('confirm');
    Pack.updateConfirmDir();
    /* 既定ポートは「実際に空いている番号」(手元の鯖が全部25565固まり対策) */
    const port = await saba.suggestPort();
    document.querySelector('#pkc-port').value = port;
  },

  updateConfirmDir() {
    const name = document.querySelector('#pkc-name').value.trim();
    const root = Pack.customRoot || (App.state.data && App.state.data.newServerRoot) || '';
    document.querySelector('#pkc-dir').textContent = root + '\\' + (name || '(名前)');
  },

  updateRamLabels() {
    const xms = Number(document.querySelector('#pk-xms').value);
    const xmx = Number(document.querySelector('#pk-xmx').value);
    document.querySelector('#pk-xms-val').textContent = xms + ' GB';
    document.querySelector('#pk-xmx-val').textContent = xmx + ' GB';
    const ram = App.state.ramGB || 0;
    const hint = document.querySelector('#pk-ram-hint');
    hint.textContent = ram
      ? `このPCのメモリ: ${ram} GB` + (xmx > ram / 2 ? ' ⚠ 上限が半分を超えています(他の作業が重くなるかも)' : '')
      : '';
  },

  updateConfirmRamLabels() {
    const xms = Number(document.querySelector('#pkc-xms').value);
    const xmx = Number(document.querySelector('#pkc-xmx').value);
    document.querySelector('#pkc-xms-val').textContent = xms + ' GB';
    document.querySelector('#pkc-xmx-val').textContent = xmx + ' GB';
    const ram = App.state.ramGB || 0;
    const hint = document.querySelector('#pkc-ram-hint');
    hint.textContent = ram
      ? `このPCのメモリ: ${ram} GB` + (xmx > ram / 2 ? ' ⚠ 上限が半分を超えています(他の作業が重くなるかも)' : '')
      : '';
  },

  formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  },

  showConfigError(msg) {
    const el = document.querySelector('#pk-config-error');
    el.textContent = '⚠ ' + msg;
    el.hidden = false;
  },

  showConfirmError(msg) {
    const el = document.querySelector('#pk-confirm-error');
    el.textContent = '⚠ ' + msg;
    el.hidden = false;
  },

  /* ── 導入(mrpack経由) ───────────── */
  async run() {
    document.querySelector('#pk-config-error').hidden = true;
    const name = document.querySelector('#pk-name').value.trim();
    const eula = document.querySelector('#pk-eula').checked;
    const port = Number(document.querySelector('#pk-port').value);

    if (!name) return Pack.showConfigError('名前を入れてください');
    if (/[\\/:*?"<>|]/.test(name)) return Pack.showConfigError('名前に使えない文字( \\ / : * ? " < > | )が入っています');
    if (!eula) return Pack.showConfigError('EULAに同意してください(チェックボックス)');

    const opts = {
      analysisId: Pack.current.analysisId,
      download: Pack.current.download,
      name, eula, port,
      xms: document.querySelector('#pk-xms').value + 'G',
      xmx: document.querySelector('#pk-xmx').value + 'G',
      dir: Pack.customRoot ? Pack.customRoot + '\\' + name : undefined
    };

    await Pack.runInstall(opts);
  },

  /* ── 取り込み(serverpack経由。ローダー等の手直し値をloaderOverrideとして渡す) ─── */
  async runConfirm() {
    document.querySelector('#pk-confirm-error').hidden = true;
    const name = document.querySelector('#pkc-name').value.trim();
    const mcVersion = document.querySelector('#pkc-mc').value.trim();
    const loader = document.querySelector('#pkc-loader').value;
    const eula = document.querySelector('#pkc-eula').checked;
    const port = Number(document.querySelector('#pkc-port').value);

    if (!name) return Pack.showConfirmError('名前を入れてください');
    if (/[\\/:*?"<>|]/.test(name)) return Pack.showConfirmError('名前に使えない文字( \\ / : * ? " < > | )が入っています');
    if (!mcVersion) return Pack.showConfirmError('MCバージョンを入力してください(例: 1.20.1)');
    /* 起動手段(jar等)が既にあるなら不明のままでも取り込めるが、無ければローダーを選ばせる */
    if (!loader && !(Pack.current && Pack.current.hasLoaderFiles)) return Pack.showConfirmError('ローダーを選択してください');
    if (!eula) return Pack.showConfirmError('EULAに同意してください(チェックボックス)');

    const opts = {
      analysisId: Pack.current.analysisId,
      name, eula, port,
      xms: document.querySelector('#pkc-xms').value + 'G',
      xmx: document.querySelector('#pkc-xmx').value + 'G',
      loaderOverride: {
        loader: loader || null,
        mcVersion: mcVersion || null,
        loaderVersion: document.querySelector('#pkc-loaderver').value.trim() || null
      },
      dir: Pack.customRoot ? Pack.customRoot + '\\' + name : undefined
    };

    await Pack.runInstall(opts);
  },

  /* ── 導入/取り込みの共通処理(進捗画面の出し引き) ─────── */
  async runInstall(opts) {
    Pack.showScreen('progress');
    document.querySelector('#pk-phase').textContent = '準備中…';
    document.querySelector('#pk-bar').style.width = '0%';
    document.querySelector('#pk-error').hidden = true;
    document.querySelector('#pk-abort').hidden = false;
    document.querySelector('#pk-progress-close').hidden = true;
    Pack._logLines = [];
    document.querySelector('#pk-log').textContent = '';
    Pack._aborting = false;

    const r = await saba.packInstall(opts);
    if (!r.ok) {
      if (Pack._aborting) {
        /* 中止ボタン由来の失敗は「入口に戻す」(エラー扱いにしない) */
        Pack._aborting = false;
        Pack.showScreen('entry');
        return;
      }
      document.querySelector('#pk-error').textContent = '⚠ ' + r.error;
      document.querySelector('#pk-error').hidden = false;
      document.querySelector('#pk-abort').hidden = true;
      document.querySelector('#pk-progress-close').hidden = false;
      return;
    }

    Pack.close();
    App.toast(`✅ 「${r.server.name}」を導入しました。▶で初回起動できます`);
    View.select(r.server.id);
  },

  abort() {
    Pack._aborting = true;
    saba.packCancel();
  },

  onProgress(p) {
    const phase = document.querySelector('#pk-phase');
    const bar = document.querySelector('#pk-bar');
    const mb = b => (b / 1024 / 1024).toFixed(1);

    if (p.phase === 'pack') {
      phase.textContent = p.total > 0
        ? `① modpackを取得中… ${mb(p.got)} / ${mb(p.total)} MB`
        : `① modpackを取得中… ${mb(p.got)} MB`;
      bar.style.width = p.total > 0 ? Math.round(p.got / p.total * 100) + '%' : '0%';
    } else if (p.phase === 'loader') {
      phase.textContent = p.total > 0
        ? `② ローダーを準備中… ${mb(p.got)} / ${mb(p.total)} MB`
        : '② ローダーを準備中…';
      if (p.total > 0) bar.style.width = Math.round(p.got / p.total * 100) + '%';
    } else if (p.phase === 'installer') {
      phase.textContent = 'インストーラを実行中…(数分かかることがあります)';
      bar.style.width = '100%';
      /* mainから150msごとに束ねて届く。表示は直近150行だけ(全行描画すると凍る) */
      const log = document.querySelector('#pk-log');
      Pack._logLines.push(...(p.lines || []));
      if (Pack._logLines.length > 150) Pack._logLines.splice(0, Pack._logLines.length - 150);
      log.textContent = Pack._logLines.join('\n');
      log.scrollTop = log.scrollHeight;
    } else if (p.phase === 'files') {
      phase.textContent = `③ ファイルDL中… ${p.done} / ${p.total}` + (p.file ? ` (${p.file})` : '');
      bar.style.width = p.total > 0 ? Math.round(p.done / p.total * 100) + '%' : '0%';
    } else if (p.phase === 'overrides') {
      phase.textContent = '④ 設定を適用中…';
      bar.style.width = '100%';
    } else if (p.phase === 'finish') {
      phase.textContent = '⑤ 仕上げ中…';
      bar.style.width = '100%';
    }
  }
};

window.Pack = Pack; /* CDPテスト用の入口(Saba/Modsと同じ手) */
