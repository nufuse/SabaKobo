/**
 * create/fabric.js — Fabric鯖の作成(meta.fabricmc.net v2)
 * /server/jar エンドポイントが自己起動ランチャー(約175KB)を返すので、
 * インストーラのjava実行なしで完結する。チェックサム非公開のためzipマジックで最低限の検証。
 * 初回起動時にライブラリ群をネットから取得する(UI側で明記)。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { fetchJSON, downloadFile, isZipFile } = require('../download');

const META = 'https://meta.fabricmc.net/v2';
let cache = null;

async function listVersions() {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.list;
  const games = await fetchJSON(`${META}/versions/game`);
  const list = games.filter(g => g.stable).map(g => g.version);
  cache = { at: Date.now(), list };
  return list;
}

async function create({ mc, dir, onProgress, signal }) {
  const loaders = await fetchJSON(`${META}/versions/loader`);
  const installers = await fetchJSON(`${META}/versions/installer`);
  const loader = (loaders.find(l => l.stable) || loaders[0]).version;
  const inst = (installers.find(i => i.stable) || installers[0]).version;

  const jar = 'fabric-server-launch.jar';
  const dest = path.join(dir, jar);
  await downloadFile(`${META}/versions/loader/${mc}/${loader}/${inst}/server/jar`, dest, { onProgress, signal });

  if (!isZipFile(dest) || fs.statSync(dest).size < 10000) {
    try { fs.unlinkSync(dest); } catch { }
    throw new Error('Fabricランチャーの中身がjarとして不正です(バージョンの組み合わせが無い可能性)');
  }
  return { jar, loaderVersion: loader };
}

module.exports = { listVersions, create };
