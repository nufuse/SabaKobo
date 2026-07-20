/**
 * create/forge.js — Forge鯖の作成(promotions_slim.json → インストーラ実行)
 * 唯一「鯖ができる前にJDKが要る」経路。インストーラは対象MCに合うJDKで走らせる
 * (1.20.1なら17。21で走らせない)。数分かかるので標準出力をコンソール枠へ流す。
 * loaderVersion指定時(modpack導入でmrpackがピン留めしている場合)はpromotions照会をせずそれを使う。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { fetchJSON, downloadFile } = require('../download');

const PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
let cache = null;

function mcTuple(v) { return String(v).split(/[.\-]/).map(n => parseInt(n, 10) || 0); }
function cmpMc(a, b) {
  const ta = mcTuple(a), tb = mcTuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (tb[i] || 0) - (ta[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function listVersions() {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.list;
  const j = await fetchJSON(PROMOS);
  const set = new Set();
  for (const key of Object.keys(j.promos || {})) {
    const m = key.match(/^(.+)-(latest|recommended)$/);
    if (m) set.add(m[1]);
  }
  const list = [...set].sort(cmpMc); /* 新しい順。カレンダー表記(26.x)もタプル比較で自然に上へ */
  cache = { at: Date.now(), list };
  return list;
}

async function create({ mc, dir, javaExe, loaderVersion, onProgress, onLog, signal }) {
  let forgeVer = loaderVersion;
  if (!forgeVer) {
    const j = await fetchJSON(PROMOS, { signal });
    forgeVer = j.promos[`${mc}-recommended`] || j.promos[`${mc}-latest`];
  }
  if (!forgeVer) throw new Error(`Forge ${mc} 向けのバージョンが見つかりません`);

  const full = `${mc}-${forgeVer}`;
  const installer = path.join(dir, `forge-${full}-installer.jar`);
  await downloadFile(`${MAVEN}/${full}/forge-${full}-installer.jar`, installer, { onProgress, signal });

  /* インストーラ実行(--installServer)。cwd=鯖フォルダ */
  await new Promise((resolve, reject) => {
    const p = spawn(javaExe, ['-jar', installer, '--installServer'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    for (const stream of [p.stdout, p.stderr]) {
      stream.setEncoding('utf8');
      readline.createInterface({ input: stream, crlfDelay: Infinity })
        .on('line', l => { if (onLog) onLog(l); });
    }
    const onAbort = () => { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.once('error', reject);
    p.once('exit', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) reject(new Error('中止しました'));
      else if (code === 0) resolve();
      else reject(new Error(`Forgeインストーラが失敗しました(終了コード ${code})。フォルダを確認してください`));
    });
  });

  /* 期待物の確認と掃除 */
  const libDir = path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge', full);
  if (!fs.existsSync(path.join(libDir, 'win_args.txt'))) {
    throw new Error('インストーラは成功しましたが win_args.txt が見つかりません');
  }
  /* installer.log はForgeが固定名で書く(1MB超)ので忘れず掃除 */
  for (const f of [installer, installer + '.log', path.join(dir, 'installer.log')]) {
    try { fs.unlinkSync(f); } catch { }
  }
  return { jar: null, loaderVersion: forgeVer };
}

module.exports = { listVersions, create };
