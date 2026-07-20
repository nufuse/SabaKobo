/**
 * zip.js — zip展開ラッパー(v0.4 modpack導入の土台)
 *
 * Windows標準の C:\Windows\System32\tar.exe(bsdtar同梱)をspawnして使う。
 * 新規npm依存を増やさないための選択。bsdtarは既定で ".." や絶対パスを含む
 * エントリの書き込みを拒否する(zip-slip対策)ので、-P(絶対パス許可)は付けない。
 */
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const TAR_EXE = 'C:\\Windows\\System32\\tar.exe';

function assertTarExists() {
  if (!fs.existsSync(TAR_EXE)) {
    throw new Error('zip展開に必要なtar.exeが見つかりません');
  }
}

/* tar.exeを実行し、標準出力の全文を返す。失敗時はstderrを添えて例外にする。
   'close'を待つ(=標準出力・標準エラーを読み切ってから)ので、-tf の全行取りこぼしがない */
function runTar(args, { signal, cwd } = {}) {
  assertTarExists();
  return new Promise((resolve, reject) => {
    const p = spawn(TAR_EXE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const outChunks = [];
    const errChunks = [];
    p.stdout.on('data', d => outChunks.push(d));
    p.stderr.on('data', d => errChunks.push(d));

    const onAbort = () => { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    p.once('error', reject);
    p.once('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new Error('中止しました'));
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (code === 0) return resolve(stdout);
      reject(new Error(`tar.exeが失敗しました(終了コード ${code})${stderr ? ': ' + stderr : ''}`));
    });
  });
}

/** zipを展開する。destDirが無ければ作る */
async function extract(zipPath, destDir, { signal } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  await runTar(['-xf', zipPath, '-C', destDir], { signal });
}

/** zip内のエントリ名一覧(展開せず中身を判別したい時用)。フォルダも含む */
async function list(zipPath) {
  const stdout = await runTar(['-tf', zipPath]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

module.exports = { extract, list };
