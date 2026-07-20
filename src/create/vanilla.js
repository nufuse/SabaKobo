/**
 * create/vanilla.js — バニラ鯖の作成(Mojang version_manifest_v2)
 * latest.release は "26.2" のようなカレンダー表記になった。semverソート禁止 —
 * マニフェストの並び順(新しい順)をそのまま信じる。sha1検証あり。
 */
'use strict';

const path = require('path');
const { fetchJSON, downloadFile } = require('../download');

const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
let cache = null;
const javaMajorCache = new Map(); /* mcVersion → majorVersion(公式データ) */

async function loadManifest(signal) {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.j;
  const j = await fetchJSON(MANIFEST, { signal });
  cache = { at: Date.now(), j };
  return j;
}

async function listVersions() {
  const j = await loadManifest();
  return j.versions.filter(v => v.type === 'release').map(v => v.id);
}

/**
 * そのMCバージョンが要求するJavaメジャー番号(Mojang公式の javaVersion.majorVersion)。
 * 例: 26.2→25 / 1.21.11→21 / 1.20.4→17 / 1.16.5→8。マニフェストに無ければnull。
 * Paper/Fabricもバニラと同じ要求に従うので、ルール表の「正」はこれ。
 */
async function javaMajorFor(mc, signal) {
  if (javaMajorCache.has(mc)) return javaMajorCache.get(mc);
  const j = await loadManifest(signal);
  const entry = j.versions.find(v => v.id === mc);
  if (!entry) { javaMajorCache.set(mc, null); return null; }
  const vj = await fetchJSON(entry.url, { signal });
  const major = (vj.javaVersion && vj.javaVersion.majorVersion) || null;
  javaMajorCache.set(mc, major);
  return major;
}

async function create({ mc, dir, onProgress, signal }) {
  const j = await loadManifest(signal);
  const entry = j.versions.find(v => v.id === mc);
  if (!entry) throw new Error(`バージョン ${mc} がマニフェストにありません`);

  const vj = await fetchJSON(entry.url, { signal });
  const d = vj.downloads && vj.downloads.server;
  if (!d) throw new Error(`${mc} にはサーバーjarが配布されていません`);

  await downloadFile(d.url, path.join(dir, 'server.jar'), { sha1: d.sha1, onProgress, signal });
  return { jar: 'server.jar', loaderVersion: null };
}

module.exports = { listVersions, javaMajorFor, create };
