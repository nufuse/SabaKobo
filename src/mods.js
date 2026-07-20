/**
 * mods.js — プラグイン/Modの一覧・有効/無効切替・追加(v0.3)
 *
 * 有効=<dir>\<folder>\*.jar / 無効=<dir>\<folder>\disabled\*.jar.disabled という
 * 「フォルダ移動+拡張子接尾辞」方式。実機の運用(例: …\plugins\disabled\Xxx.jar.disabled)と揃える。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ── 対象フォルダの判定(フォルダの有無では判定しない。ローダーで決め打ち) ── */
const FOLDER_BY_LOADER = { paper: 'plugins', fabric: 'mods', forge: 'mods', neoforge: 'mods' };
function folderFor(server) {
  return FOLDER_BY_LOADER[server.loader] || null; /* vanilla/unknown → null(機能なし) */
}

/* ── 要再起動フラグ(起動中に変更した鯖のid) ── */
const dirty = new Set();
function clearDirty(id) { dirty.delete(id); }

/* ── 安全弁(パス脱出防止) ─────────────── */
function assertSafeName(name) {
  if (typeof name !== 'string' || !name.endsWith('.jar') ||
      name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('不正なファイル名です');
  }
}

/* 起動中のファイルロックを分かりやすいメッセージに変換
   (WindowsはEPERMが同名衝突など別要因でも出ることがあるため、断定はしない表現にする) */
function translateFsError(err) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
    return new Error('起動中またはファイルが使用中のため操作できません。鯖を停止してから試してください');
  }
  return err;
}

/* ── 一覧(ファイルのみ・拡張子一致のみ。データフォルダは絶対に出さない) ── */
function readJars(dir, re, disabled, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } /* 無ければ空 */
  for (const ent of entries) {
    if (!ent.isFile() || !re.test(ent.name)) continue;
    let st;
    try { st = fs.statSync(path.join(dir, ent.name)); } catch { continue; }
    const name = disabled ? ent.name.slice(0, -'.disabled'.length) : ent.name;
    out.push({ name, size: st.size, mtime: st.mtimeMs, enabled: !disabled });
  }
}

function listMods(server) {
  const folder = folderFor(server);
  if (!folder) return { folder: null, mods: [], dirty: dirty.has(server.id) };
  const base = path.join(server.dir, folder);
  const mods = [];
  readJars(base, /\.jar$/i, false, mods);
  readJars(path.join(base, 'disabled'), /\.jar\.disabled$/i, true, mods);
  return { folder, mods, dirty: dirty.has(server.id) };
}

/* ── 有効/無効切替 ─────────────────── */
function setEnabled(server, name, enabled, running) {
  assertSafeName(name);
  const folder = folderFor(server);
  if (!folder) throw new Error('このサーバーにはプラグイン/Modの概念がありません');
  const base = path.join(server.dir, folder);
  const disabledDir = path.join(base, 'disabled');
  const from = enabled ? path.join(disabledDir, name + '.disabled') : path.join(base, name);
  const to = enabled ? path.join(base, name) : path.join(disabledDir, name + '.disabled');
  if (fs.existsSync(to)) throw new Error(`移動先に同名のファイルがあります: ${path.basename(to)}`);
  let st;
  try { st = fs.statSync(from); } catch (err) { throw translateFsError(err); }
  if (!st.isFile()) throw new Error(`通常のファイルではありません: ${path.basename(from)}`); /* 同名ディレクトリを丸ごと移動させない安全弁 */
  try {
    if (!enabled) fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(from, to);
  } catch (err) {
    throw translateFsError(err);
  }
  if (running) dirty.add(server.id);
}

/* ── 追加(コピー。同名は理由付きでスキップし、黙って捨てない) ── */
function addMods(server, paths, running) {
  const folder = folderFor(server);
  if (!folder) throw new Error('このサーバーにはプラグイン/Modの概念がありません');
  const base = path.join(server.dir, folder);
  const disabledDir = path.join(base, 'disabled');
  fs.mkdirSync(base, { recursive: true });

  const added = [];
  const skipped = [];
  for (const src of paths) {
    const name = path.basename(String(src));
    if (!/\.jar$/i.test(name)) { skipped.push({ name, reason: '.jarファイルではありません' }); continue; }
    const destEnabled = path.join(base, name);
    const destDisabled = path.join(disabledDir, name + '.disabled');
    if (fs.existsSync(destEnabled) || fs.existsSync(destDisabled)) {
      skipped.push({ name, reason: '同名のファイルが既にあります' });
      continue;
    }
    try {
      fs.copyFileSync(src, destEnabled);
      added.push(name);
    } catch (err) {
      skipped.push({ name, reason: translateFsError(err).message });
    }
  }
  if (added.length && running) dirty.add(server.id);
  return { added, skipped };
}

module.exports = { folderFor, listMods, setEnabled, addMods, clearDirty };
