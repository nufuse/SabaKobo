/**
 * download.js — net.fetch(Chromiumのネットワークスタック=プロキシ設定を継承)でのJSON取得とファイルダウンロード
 *
 * ダウンロードは一時ファイル(.download)に書き、流しながらハッシュを計算し、
 * 検証が通ってから renameSync で本配置。半端なjarを本番パスに残さない。
 */
'use strict';

const { net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');

/* Paper Fill APIの規約: 汎用でないUA+連絡先が必要 */
const UA = 'SabaKobo/0.1 (+https://github.com/nufuse)';

/* JSON取得は30秒でタイムアウト(相手サイトが黙り込んでも「一生動かない」を防ぐ)。
   signalを渡せば中止ボタンとも連動する */
async function fetchJSON(url, opts = {}) {
  const timeout = AbortSignal.timeout(opts.timeoutMs || 30000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const r = await net.fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return r.json();
  } catch (e) {
    if (e.name === 'TimeoutError' || (timeout.aborted && !(opts.signal && opts.signal.aborted))) {
      throw new Error(`接続がタイムアウトしました(30秒): ${url}`);
    }
    throw e;
  }
}

/**
 * downloadFile(url, dest, { sha256, sha1, onProgress, signal })
 * sha256/sha1 のどちらか指定があれば検証し、不一致なら失敗させる。
 */
async function downloadFile(url, dest, opts = {}) {
  const { sha256, sha1, onProgress, signal } = opts;
  const r = await net.fetch(url, { headers: { 'User-Agent': UA }, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);

  const total = Number(r.headers.get('content-length')) || 0;
  const tmp = dest + '.download';
  const hash = sha256 ? crypto.createHash('sha256') : (sha1 ? crypto.createHash('sha1') : null);
  const out = fs.createWriteStream(tmp);
  const reader = r.body.getReader();
  let got = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (hash) hash.update(value);
      got += value.length;
      await new Promise((res, rej) => out.write(value, err => err ? rej(err) : res()));
      if (onProgress) onProgress(got, total);
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));

    if (hash) {
      const hex = hash.digest('hex');
      const want = (sha256 || sha1).toLowerCase();
      if (hex !== want) throw new Error(`チェックサム不一致(ダウンロード破損の可能性): ${hex} ≠ ${want}`);
    }
    fs.renameSync(tmp, dest);
    return { size: got };
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch { }
    throw e;
  }
}

/* zipとして最低限成立しているか(PK\x03\x04)。チェックサム非公開のFabric用 */
function isZipFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  } catch { return false; }
}

module.exports = { UA, fetchJSON, downloadFile, isZipFile };
