/**
 * mods.js — プラグイン/Mod管理モーダル(v0.3)
 * props.jsのモーダルを雛形に、jarの一覧・有効/無効トグル・追加(選択/ドラッグ&ドロップ)を扱う。
 */
'use strict';

const Mods = {
  current: null, /* 直近のmods:list結果 {folder, mods, dirty} */
  delConfirm: null, /* 削除2段階クリックの確認中ボタン {btn, timer} */

  wire() {
    document.querySelector('#mods-close').addEventListener('click', () => Mods.close());
    document.querySelector('#mm-add').addEventListener('click', () => Mods.addViaDialog());
    document.querySelector('#mm-list').addEventListener('change', e => {
      const cb = e.target.closest('input[type=checkbox]');
      if (cb) Mods.toggle(cb.dataset.name, cb.checked);
    });
    document.querySelector('#mm-list').addEventListener('click', e => {
      const del = e.target.closest('.mm-del');
      if (del) Mods.onDeleteClick(del);
    });
    /* 確認中のボタン以外をクリックしたら3秒待たずに元へ戻す */
    document.addEventListener('click', e => {
      if (Mods.delConfirm && !e.target.closest('.mm-del-confirm')) Mods.resetDeleteConfirm();
    });

    /* ドラッグ&ドロップ: File.pathがElectron 43で廃止されたのでsaba.pathForFileでパス化する */
    const overlay = document.querySelector('#mods-overlay');
    const dropZone = document.querySelector('#mm-drop');
    overlay.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('mm-drop-hot'); });
    overlay.addEventListener('dragleave', () => dropZone.classList.remove('mm-drop-hot'));
    overlay.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('mm-drop-hot');
      Mods.handleDrop(e.dataTransfer.files);
    });

    saba.onModsChanged(p => {
      if (p.id === App.state.activeId && !document.querySelector('#mods-overlay').hidden) Mods.reload();
    });
    /* 起動中→停止等の状態変化でも要再起動バッジを更新する */
    saba.onState(p => {
      if (p.id === App.state.activeId && !document.querySelector('#mods-overlay').hidden) Mods.render();
    });
  },

  async open() {
    const s = App.findServer(App.state.activeId);
    if (!s) return;
    document.querySelector('#mm-name').textContent = '— ' + s.name;
    document.querySelector('#mm-skip').hidden = true;
    document.querySelector('#mods-overlay').hidden = false;
    document.querySelector('#mm-list').innerHTML = ''; /* 前の鯖の一覧が一瞬残るのを防ぐ */
    await Mods.reload();
  },

  async reload() {
    const id = App.state.activeId;
    const r = await saba.modsList(id);
    if (!r.ok) { App.toast('⚠ ' + r.error); Mods.close(); return; }
    Mods.current = r;
    Mods.render();
  },

  render() {
    const r = Mods.current;
    if (!r) return;
    document.querySelector('#mm-sub').textContent = r.folder
      ? `対象フォルダ: ${r.folder} ・ ${r.mods.length}件`
      : 'このサーバーにはプラグイン/Modの概念がありません';

    const running = App.statusOf(App.state.activeId) === 'running' || App.statusOf(App.state.activeId) === 'stopping';
    document.querySelector('#mm-restart').hidden = !(r.dirty && running);

    const list = document.querySelector('#mm-list');
    list.innerHTML = '';
    for (const mod of r.mods) {
      const row = document.createElement('div');
      row.className = 'mm-row';

      const name = document.createElement('span');
      name.className = 'mm-name';
      name.textContent = mod.name;

      const size = document.createElement('span');
      size.className = 'mm-size';
      size.textContent = Mods.formatSize(mod.size);

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'pr-toggle';
      toggle.checked = mod.enabled;
      toggle.dataset.name = mod.name;
      toggle.title = mod.enabled ? '有効(クリックで無効化)' : '無効(クリックで有効化)';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mm-del';
      del.textContent = '🗑';
      del.title = 'ゴミ箱へ移動(復元可能)';
      del.dataset.name = mod.name;
      del.dataset.enabled = String(mod.enabled);

      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(toggle);
      row.appendChild(del);
      list.appendChild(row);
    }
    document.querySelector('#mm-empty').hidden = r.mods.length > 0;
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  },

  async toggle(name, enabled) {
    const id = App.state.activeId;
    const r = await saba.modsToggle(id, name, enabled);
    /* 成功時の再読み込みはmods:changedイベント側に任せる(二重リロード防止)。失敗時は表示のズレを直す */
    if (!r.ok) { App.toast('⚠ ' + r.error); await Mods.reload(); }
  },

  /* 削除ボタンは2段階クリック(誤爆防止): 1回目で「ゴミ箱へ?」に変わり、3秒以内の2回目で実行 */
  onDeleteClick(btn) {
    if (Mods.delConfirm && Mods.delConfirm.btn === btn) {
      Mods.resetDeleteConfirm();
      Mods.remove(btn.dataset.name, btn.dataset.enabled === 'true');
      return;
    }
    Mods.resetDeleteConfirm(); /* 別の行が確認中だったら戻す */
    btn.classList.add('mm-del-confirm');
    btn.textContent = 'ゴミ箱へ?';
    const timer = setTimeout(() => Mods.resetDeleteConfirm(), 3000);
    Mods.delConfirm = { btn, timer };
  },

  resetDeleteConfirm() {
    if (!Mods.delConfirm) return;
    clearTimeout(Mods.delConfirm.timer);
    Mods.delConfirm.btn.classList.remove('mm-del-confirm');
    Mods.delConfirm.btn.textContent = '🗑';
    Mods.delConfirm = null;
  },

  async remove(name, enabled) {
    const id = App.state.activeId;
    const r = await saba.modsRemove(id, name, enabled);
    /* 成功時の再読み込みはmods:changedイベント側に任せる(二重リロード防止)。失敗時は表示のズレを直す */
    if (!r.ok) { App.toast('⚠ ' + r.error); await Mods.reload(); }
  },

  async addViaDialog() {
    const paths = await saba.pickJars();
    if (paths && paths.length) await Mods.add(paths);
  },

  async handleDrop(files) {
    const paths = [];
    const ignored = [];
    for (const f of files) {
      const p = saba.pathForFile(f);
      if (/\.jar$/i.test(p)) paths.push(p);
      else ignored.push(f.name);
    }
    if (ignored.length) App.toast(`⚠ .jar以外は無視しました: ${ignored.join(', ')}`);
    if (paths.length) await Mods.add(paths);
  },

  async add(paths) {
    const id = App.state.activeId;
    const r = await saba.modsAdd(id, paths);
    if (!r.ok) { App.toast('⚠ ' + r.error); return; }

    const skipEl = document.querySelector('#mm-skip');
    if (r.skipped.length) {
      skipEl.textContent = '⚠ 同名のためスキップ: ' + r.skipped.map(x => x.name).join(', ');
      skipEl.hidden = false;
    } else {
      skipEl.hidden = true;
    }
    if (r.added.length) App.toast(`✅ ${r.added.length}件追加しました`); /* 再読み込みはmods:changedイベント側に任せる(二重リロード防止) */
  },

  close() {
    document.querySelector('#mods-overlay').hidden = true;
  }
};
