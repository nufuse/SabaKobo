/**
 * java.js — JDKの検出と「どのMCバージョンにどのJavaを使うか」のルール表
 *
 * 検出はプロセス起動なし: <jdk>\release が key=value のテキストなので読むだけ。
 * releaseが無い変わり種だけ java -version にフォールバック(出力は標準エラー側)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* ── 検出 ─────────────────────────── */

function parseReleaseFile(jdkDir) {
  try {
    const txt = fs.readFileSync(path.join(jdkDir, 'release'), 'utf8');
    const ver = txt.match(/JAVA_VERSION="([^"]+)"/);
    const impl = txt.match(/IMPLEMENTOR="([^"]+)"/);
    if (!ver) return null;
    return { version: ver[1], implementor: impl ? impl[1] : '' };
  } catch { return null; }
}

/* "21.0.10"→21 / "1.8.0_391"→8 */
function majorOf(version) {
  const parts = String(version).split(/[._]/).map(n => parseInt(n, 10) || 0);
  return parts[0] === 1 ? parts[1] : parts[0];
}

function versionTuple(v) {
  return String(v).split(/[._\-+]/).map(n => parseInt(n, 10) || 0);
}
function cmpTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* releaseファイルが無いJDK向けの最終手段 */
function versionFromExec(javaExe) {
  try {
    const r = spawnSync(javaExe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const m = String(r.stderr || r.stdout || '').match(/version "([^"]+)"/);
    return m ? { version: m[1], implementor: '' } : null;
  } catch { return null; }
}

function probeJdkDir(dir, found) {
  try {
    const javaExe = path.join(dir, 'bin', 'java.exe');
    if (!fs.existsSync(javaExe)) return;
    const real = fs.realpathSync(dir); /* "latest" 等のjunctionを実体に寄せて重複排除 */
    if (found.has(real)) return;
    const info = parseReleaseFile(real) || versionFromExec(path.join(real, 'bin', 'java.exe'));
    if (!info) return;
    found.set(real, {
      path: real,
      version: info.version,
      major: majorOf(info.version),
      implementor: info.implementor,
      source: 'auto'
    });
  } catch { /* 読めないフォルダは無視 */ }
}

function detect() {
  const found = new Map();
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null
  ].filter(Boolean);

  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) probeJdkDir(path.join(root, name), found);
    } catch { /* rootごと無くてもよい */ }
  }

  /* JAVA_HOME と PATH上のjava(javapathのシンボリックリンクをrealpathで実体へ) */
  if (process.env.JAVA_HOME) probeJdkDir(process.env.JAVA_HOME, found);
  try {
    const r = spawnSync('where', ['java'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    for (const line of String(r.stdout || '').split(/\r?\n/).filter(Boolean)) {
      try {
        const realExe = fs.realpathSync(line.trim());
        probeJdkDir(path.dirname(path.dirname(realExe)), found);
      } catch { }
    }
  } catch { }

  return [...found.values()].sort((a, b) => cmpTuple(versionTuple(b.version), versionTuple(a.version)));
}

/* ── ルール表(オフライン用フォールバック) ─────────── */
/**
 * MCバージョン＋ローダー → 必要なJavaメジャーの範囲。
 * 「正」はMojang公式データ(javaVersion.majorVersion。main側のeffectiveRangeが取得)で、
 * この表はネットが無いときの控え。実測値: 26.x→25 / 1.20.5〜1.21.x→21 / 1.18〜1.20.4→17 / 1.17→16 / 1.16.5以前→8。
 * 要注意はForge/NeoForgeの1.18〜1.20.4: Java 17限定(21では起動しない)。
 */
function requiredRange(mcVersion, loader) {
  const t = String(mcVersion).split(/[.\-]/).map(n => parseInt(n, 10) || 0);
  const isForge = loader === 'forge' || loader === 'neoforge';

  if (t[0] !== 1) return { min: 25, label: 'Java 25以上' }; /* 26.x カレンダー表記(公式データが取れない時の控え) */
  const minor = t[1] || 0, patch = t[2] || 0;

  if (minor >= 21 || (minor === 20 && patch >= 5)) return { min: 21, label: 'Java 21以上' };
  if (isForge && minor >= 18 && minor <= 20) return { min: 17, max: 17, label: 'Java 17(限定。21では起動しない)' };
  if (minor >= 18) return { min: 17, label: 'Java 17以上' };
  if (minor === 17) return { min: 16, label: 'Java 16以上' };
  if (isForge) return { min: 8, max: 8, label: 'Java 8(限定)' };
  return { min: 8, max: 16, label: 'Java 8〜16' }; /* 古いMCは新しすぎるJavaで壊れる */
}

/* 範囲を満たすJDKを検出済み一覧から選ぶ(範囲内で最も新しいもの) */
function pickByRange(range, javas) {
  const ok = javas.filter(j => j.major >= range.min && (range.max == null || j.major <= range.max));
  if (!ok.length) {
    return { ok: false, error: `${range.label} が必要ですが、このPCに見つかりません`, required: range.label };
  }
  const best = ok.sort((a, b) => cmpTuple(versionTuple(b.version), versionTuple(a.version)))[0];
  return { ok: true, path: best.path, exe: path.join(best.path, 'bin', 'java.exe'), version: best.version, major: best.major, required: range.label };
}

function pick(mcVersion, loader, javas) {
  return pickByRange(requiredRange(mcVersion, loader), javas);
}

/* 解決順: 鯖のjavaPath指定 → 作成時に記録した要求範囲(javaReq) → フォールバック表 */
function resolveForServer(server, javas) {
  if (server.javaPath) {
    const exe = path.join(server.javaPath, 'bin', 'java.exe');
    if (fs.existsSync(exe)) {
      const info = parseReleaseFile(server.javaPath);
      return { ok: true, path: server.javaPath, exe, version: info ? info.version : '?', major: info ? majorOf(info.version) : 0 };
    }
    return { ok: false, error: `指定されたJavaが見つかりません: ${server.javaPath}` };
  }
  if (server.javaReq && server.javaReq.min) return pickByRange(server.javaReq, javas);
  return pick(server.mcVersion, server.loader, javas);
}

module.exports = { detect, requiredRange, pick, pickByRange, resolveForServer, majorOf };
