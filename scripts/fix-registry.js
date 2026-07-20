/**
 * fix-registry.js — レジストリ修復(2026-07-19の分裂事故用)
 *
 * 経緯: Claude(MSIXアプリ)から起動した鯖工房のAppData書き込みはサンドボックスへ隔離されるため、
 * test2 の登録が本物の %APPDATA%\SabaKobo\sabakobo-data.json に届いていなかった。
 * このスクリプトを「ユーザーがダブルクリックで」実行すると本物の側で動くので、
 * test2 を本物のレジストリに合流させられる。
 *
 * 使い方: 鯖工房を終了してから レジストリ修復.bat をダブルクリック(このファイルを直接叩いてもよい)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dataFile = path.join(process.env.APPDATA, 'SabaKobo', 'sabakobo-data.json');

/* 鯖工房が起動中なら中止(起動中に書くと閉じるときに上書きされて消えるため) */
try {
  const out = execSync('tasklist /FI "IMAGENAME eq SabaKobo.exe" /NH', { encoding: 'utf8', windowsHide: true });
  if (/SabaKobo\.exe/i.test(out)) {
    console.log('❌ 鯖工房が起動中です。先にアプリを終了してから、もう一度実行してください。');
    process.exit(1);
  }
} catch { }

/* サンドボックス側に閉じ込められていた test2 の登録(2026-07-17作成・内容確認済み) */
const test2 = {
  id: 'c5feb555-fca8-4f0f-b517-0e7377b5848a',
  name: 'test2',
  dir: 'C:\\minecraft\\Minecraft server\\test2',
  loader: 'forge',
  mcVersion: '1.20.1',
  loaderVersion: '47.4.10',
  jar: null,
  javaPath: null,
  javaReq: { min: 17, max: 17, label: 'Java 17(限定)' },
  xms: '4G', xmx: '6G',
  extraJvmArgs: '', serverArgs: '',
  consoleCharset: 'utf-8',
  port: 25565,
  incomplete: false,
  origin: 'created',
  createdAt: '2026-07-17T03:12:26.398Z',
  lastStartedAt: '2026-07-17T10:02:56.028Z',
  lastPid: null,
  favorite: false, notes: ''
};

let data;
try {
  data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
} catch {
  data = { version: 1, newServerRoot: 'C:\\minecraft\\Minecraft server', servers: [] };
}

console.log('現在の登録:', data.servers.map(s => s.name).join(', ') || '(なし)');

if (!fs.existsSync(test2.dir)) {
  console.log('⚠ test2 のフォルダが見つからないため、追加をスキップしました:', test2.dir);
} else if (data.servers.some(s => path.resolve(s.dir) === path.resolve(test2.dir))) {
  console.log('✅ test2 は既に登録されています。修復は不要でした。');
} else {
  data.servers.push(test2);
  const tmp = dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, dataFile);
  console.log('✅ test2 を合流させました。現在の登録:', data.servers.map(s => s.name).join(', '));
}
