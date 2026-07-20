/**
 * ports.js — ポートの空き確認と空きポート提案
 * 手元の6鯖が全部25565という前提があるので、作成時の既定は「実際に空いている番号」。
 */
'use strict';

const net = require('net');

/* portが今この瞬間bindできるか(=空いているか) */
function probe(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ port, host: '0.0.0.0', exclusive: true });
  });
}

/* 25565から順に、登録済み鯖のポートと実際の使用中を避けて提案 */
async function suggest(usedPorts) {
  const used = new Set(usedPorts || []);
  for (let p = 25565; p < 25665; p++) {
    if (used.has(p)) continue;
    if (await probe(p)) return p;
  }
  return 25565;
}

module.exports = { probe, suggest };
