/**
 * runner.js — 鯖プロセスの起動・停止・コンソール中継
 *
 * 方針:
 * - RCONは使わない。アプリ自身がjavaをspawnして標準入出力を握る
 * - 停止は「stopをstdinに書く → 30秒待つ → taskkill /T /F(木ごと)」の順。
 *   Windowsの child.kill() はプロセスの木を殺さないので絶対に使わない
 * - コンソールは100msごとに束ねてレンダラーへ。履歴はmain側リングバッファ5000行
 *   (溢れたら捨ててよい — 本当の記録は鯖自身の logs/latest.log にある)
 */
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

/*
 * 文字化け対策(3系統):
 * - file.encoding    … JDK17ではデフォルト文字集合そのもの(日本語Windows=MS932)を上書き
 * - stdout/stderr.encoding      … JDK19+の正式なコンソール文字コード指定
 * - sun.stdout/stderr.encoding  … JDK8〜17でSystem.outのPrintStreamに効く旧名
 * JDK21では冗長なだけ、JDK17(Forge 1.20.x)では必須。未知の-Dは無害。
 */
const ENC_FLAGS = [
  '-Dfile.encoding=UTF-8',
  '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
  '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'
];

const RING_MAX = 5000;   /* main側の履歴 */
const FLUSH_MS = 100;    /* レンダラーへの束ね間隔 */
const STOP_GRACE_MS = 30000;  /* stop後、自然終了を待つ時間 */
const STOP_FAIL_MS = 60000;   /* これを過ぎたら「停止失敗」を報告 */

const runners = new Map(); /* id → r */

/* ── 内部ヘルパ ─────────────────────── */

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function clean(line) { return line.replace(ANSI_RE, '').replace(/\r+$/, ''); }

/*
 * プレイヤーの出入りをログから検知する。
 * 「]: 名前 joined the game」の形だけを拾う(チャットは「]: <名前> …」なので誤検知しない)。
 * Paper/Vanilla: "[HH:MM:SS] [Server thread/INFO]: Steve joined the game"
 * Forge:         "[HH:MM:SS] [Server thread/INFO] [minecraft/MinecraftServer]: Steve joined the game"
 */
const PLAYER_RE = /\]:\s([A-Za-z0-9_]{3,16}) (joined|left) the game$/;
function parsePlayerLine(line) {
  const m = line.match(PLAYER_RE);
  return m ? { name: m[1], event: m[2] === 'joined' ? 'join' : 'left' } : null;
}

function pushLine(r, line) {
  r.ring.push(line);
  if (r.ring.length > RING_MAX) r.ring.splice(0, r.ring.length - RING_MAX);
  r.batch.push(line);

  const pl = parsePlayerLine(line);
  if (pl) {
    if (pl.event === 'join') r.players.add(pl.name);
    else r.players.delete(pl.name);
    if (r.onPlayers) r.onPlayers(r.id, [...r.players]);
  }
}

function flushBatch(r) {
  if (r.batch.length && r.onLines) r.onLines(r.id, r.batch.splice(0));
}

/* Forge/NeoForgeの起動引数ファイル(win_args.txt)を探す */
function findArgsFile(server) {
  const vendor = server.loader === 'neoforge'
    ? path.join('libraries', 'net', 'neoforged', 'neoforge')
    : path.join('libraries', 'net', 'minecraftforge', 'forge');
  const base = path.join(server.dir, vendor);
  const cands = [];
  if (server.mcVersion && server.loaderVersion) cands.push(path.join(base, `${server.mcVersion}-${server.loaderVersion}`));
  if (server.loaderVersion) cands.push(path.join(base, String(server.loaderVersion)));
  try { for (const d of fs.readdirSync(base)) cands.push(path.join(base, d)); } catch { }
  for (const d of cands) {
    const f = path.join(d, 'win_args.txt');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function buildArgs(server) {
  const args = [...ENC_FLAGS];

  if (server.loader === 'forge' || server.loader === 'neoforge') {
    const argsFile = findArgsFile(server);
    if (!argsFile) throw new Error('win_args.txt が見つかりません(Forgeのインストールが壊れている可能性)');
    /* user_jvm_args.txt → アプリのメモリ設定(後勝ちでアプリ側を優先) → win_args(この中に本体クラス) */
    if (fs.existsSync(path.join(server.dir, 'user_jvm_args.txt'))) args.push('@user_jvm_args.txt');
    if (server.xms) args.push(`-Xms${server.xms}`);
    if (server.xmx) args.push(`-Xmx${server.xmx}`);
    const rel = path.relative(server.dir, argsFile).split(path.sep).join('/');
    args.push('@' + rel, 'nogui');
    return args;
  }

  /* Paper / Fabric / Vanilla: -jar 形式 */
  if (!server.jar) throw new Error('起動するJARが設定されていません');
  if (!fs.existsSync(path.join(server.dir, server.jar))) throw new Error(`JARが見つかりません: ${server.jar}`);
  if (server.xms) args.push(`-Xms${server.xms}`);
  if (server.xmx) args.push(`-Xmx${server.xmx}`);
  if (server.extraJvmArgs) args.push(...String(server.extraJvmArgs).split(/\s+/).filter(Boolean));
  args.push('-jar', server.jar, 'nogui');
  if (server.serverArgs) args.push(...String(server.serverArgs).split(/\s+/).filter(Boolean));
  return args;
}

function forceKill(r) {
  if (!r.child) return;
  try {
    /* /T=プロセスの木ごと /F=強制。child.kill()では木が残る */
    spawn('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], { windowsHide: true });
  } catch { }
}

function finalize(r, code) {
  if (r.done) return;
  r.done = true;
  clearInterval(r.timer);
  clearTimeout(r.stopTimer);
  clearTimeout(r.failTimer);
  const crashed = r.status === 'running' && code !== 0 && code !== null;
  pushLine(r, `[鯖工房] プロセス終了 (コード ${code})${crashed ? ' — 想定外の停止(クラッシュ?)' : ''}`);
  flushBatch(r);
  r.status = 'stopped';
  r.child = null;
  if (r.players.size) { r.players.clear(); if (r.onPlayers) r.onPlayers(r.id, []); }
  if (r.onState) r.onState(r.id, { status: 'stopped', code, crashed });
  for (const w of r.waiters.splice(0)) w();
}

/* ── 公開API ─────────────────────── */

/** 起動。成功でpidを返す。失敗は例外 */
function start(server, javaExe, { onLines, onState, onPlayers }) {
  const prev = runners.get(server.id);
  if (prev && prev.child) throw new Error('すでに起動中です');

  const args = buildArgs(server); /* 引数の組み立てに失敗したらspawn前に例外 */
  const jdkHome = path.dirname(path.dirname(javaExe));
  const child = spawn(javaExe, args, {
    cwd: server.dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, JAVA_HOME: jdkHome, PATH: `${path.join(jdkHome, 'bin')};${process.env.PATH || ''}` }
  });

  const r = {
    id: server.id, child, status: 'running',
    ring: prev ? prev.ring : [], batch: [],
    timer: null, stopTimer: null, failTimer: null,
    players: new Set(),
    onLines, onState, onPlayers, waiters: [], done: false
  };
  runners.set(server.id, r);

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    readline.createInterface({ input: stream, crlfDelay: Infinity })
      .on('line', l => pushLine(r, clean(l)));
  }
  child.once('error', err => { pushLine(r, `[鯖工房] 起動失敗: ${err.message}`); finalize(r, -1); });
  child.once('exit', code => finalize(r, code));

  r.timer = setInterval(() => flushBatch(r), FLUSH_MS);
  pushLine(r, `[鯖工房] 起動: ${javaExe}`);
  pushLine(r, `[鯖工房] 引数: ${args.join(' ')}`);
  if (onState) onState(server.id, { status: 'running', pid: child.pid });
  return child.pid;
}

/** 優雅な停止。終了までのPromiseを返す */
function stop(id) {
  const r = runners.get(id);
  if (!r || !r.child) return Promise.resolve();
  if (r.status !== 'stopping') {
    r.status = 'stopping';
    if (r.onState) r.onState(id, { status: 'stopping' });
    pushLine(r, '[鯖工房] stop を送信しました');
    try { r.child.stdin.write('stop\n'); } catch { }
    r.stopTimer = setTimeout(() => {
      pushLine(r, `[鯖工房] ${STOP_GRACE_MS / 1000}秒待っても停止しないため強制終了します (taskkill /T /F)`);
      forceKill(r);
    }, STOP_GRACE_MS);
    r.failTimer = setTimeout(() => {
      if (r.child && r.onState) r.onState(id, { status: 'error', message: '停止できませんでした。タスクマネージャで java.exe を確認してください' });
    }, STOP_FAIL_MS);
  }
  return new Promise(res => { if (!r.child) res(); else r.waiters.push(res); });
}

/** コンソールへコマンドを送る */
function send(id, cmd) {
  const r = runners.get(id);
  if (!r || !r.child || r.status !== 'running') return false;
  pushLine(r, `> ${cmd}`);
  try { r.child.stdin.write(cmd + '\n'); return true; } catch { return false; }
}

function isRunning(id) {
  const r = runners.get(id);
  return !!(r && r.child);
}
function anyRunning() {
  for (const r of runners.values()) if (r.child) return true;
  return false;
}
function runningIds() {
  return [...runners.values()].filter(r => r.child).map(r => r.id);
}
function getRing(id) {
  const r = runners.get(id);
  return r ? r.ring.slice() : [];
}
function getPlayers(id) {
  const r = runners.get(id);
  return r && r.child ? [...r.players] : [];
}
function stopAll() {
  return Promise.all(runningIds().map(stop));
}

module.exports = { start, stop, send, stopAll, isRunning, anyRunning, runningIds, getRing, getPlayers, parsePlayerLine, ENC_FLAGS };
