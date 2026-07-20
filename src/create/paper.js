/**
 * create/paper.js — Paper鯖の作成(Fill API v3)
 * 旧 api.papermc.io/v2 は2025-12-31でビルド更新停止。fill.papermc.io/v3 を使う。
 * ダウンロードURLはレスポンスの値をそのまま使う(自前で組み立てない)。sha256検証あり。
 */
'use strict';

const path = require('path');
const { fetchJSON, downloadFile } = require('../download');

const FILL = 'https://fill.papermc.io/v3';
let cache = null; /* {at, list} 一覧は1時間キャッシュ */

/**
 * /v3/projects/paper のバージョン一覧は配列ではなく
 * {"versions":{"26.2":["26.2","26.2-rc-2"],"1.21":["1.21.11",...]}} のキー付きオブジェクト。
 * 挿入順(新しい系列が先)を保って平坦化し、"-"を含むもの(rc/pre/snapshot)を既定で除外。
 */
function flattenVersions(versionsObj) {
  const out = [];
  for (const group of Object.values(versionsObj || {})) {
    for (const v of group) if (!String(v).includes('-')) out.push(v);
  }
  return out;
}

async function listVersions() {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.list;
  const j = await fetchJSON(`${FILL}/projects/paper`);
  const list = flattenVersions(j.versions);
  cache = { at: Date.now(), list };
  return list;
}

async function create({ mc, dir, onProgress, signal }) {
  const j = await fetchJSON(`${FILL}/projects/paper/versions/${mc}/builds`);
  const builds = Array.isArray(j) ? j : (j.builds || []);
  const sorted = [...builds].sort((a, b) => b.id - a.id);
  const build = sorted.find(b => b.channel === 'STABLE') || sorted[0];
  if (!build) throw new Error(`Paper ${mc} のビルドが見つかりません`);

  const dl = build.downloads && build.downloads['server:default'];
  if (!dl || !dl.url) throw new Error(`Paper ${mc} build ${build.id} にダウンロード情報がありません`);

  await downloadFile(dl.url, path.join(dir, dl.name), {
    sha256: dl.checksums && dl.checksums.sha256,
    onProgress, signal
  });
  return { jar: dl.name, loaderVersion: String(build.id) };
}

module.exports = { listVersions, flattenVersions, create };
