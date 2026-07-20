/**
 * players.js — オンラインプレイヤーの監視と「選んで押すだけ」操作
 * 出入りはmain(runner)がログから検知して押し出してくる。OPはops.jsonから。
 */
'use strict';

const Players = {
  menuTarget: null, /* メニューを開いている相手 */

  wire() {
    saba.onPlayers(p => {
      App.state.players[p.id] = p.players;
      if (p.id === App.state.activeId) Players.render();
    });

    /* チップ→操作メニュー */
    document.querySelector('#pp-list').addEventListener('click', e => {
      const chip = e.target.closest('.pp-chip');
      if (!chip) return;
      Players.openMenu(chip.dataset.name, e.clientX, e.clientY);
      e.stopPropagation();
    });
    document.addEventListener('click', () => { document.querySelector('#player-menu').hidden = true; });

    document.querySelector('#player-menu').addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || !Players.menuTarget) return;
      Players.act(btn.dataset.act, Players.menuTarget);
      document.querySelector('#player-menu').hidden = true;
    });
  },

  openMenu(name, x, y) {
    Players.menuTarget = name;
    const menu = document.querySelector('#player-menu');
    document.querySelector('#pm-name').textContent = name;
    const ops = App.state.ops[App.state.activeId] || [];
    menu.querySelector('[data-act=op]').hidden = ops.includes(name);
    menu.querySelector('[data-act=deop]').hidden = !ops.includes(name);
    menu.hidden = false;
    /* 画面からはみ出さない位置に */
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 10) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 10) + 'px';
  },

  act(act, name) {
    const id = App.state.activeId;
    if (!id) return;
    const cmds = {
      'op': `op ${name}`,
      'deop': `deop ${name}`,
      'kick': `kick ${name}`,
      'ban': `ban ${name}`,
      'whitelist': `whitelist add ${name}`,
      'gm-survival': `gamemode survival ${name}`,
      'gm-creative': `gamemode creative ${name}`,
      'gm-spectator': `gamemode spectator ${name}`
    };
    if (act === 'ban' && !confirm(`本当に ${name} をBANしますか?(解除は pardon ${name})`)) return;
    saba.sendCmd(id, cmds[act]);
    /* op/deopはops.jsonに反映されるまで少し待ってから読み直す */
    if (act === 'op' || act === 'deop') {
      setTimeout(() => Players.loadOps(id), 1500);
    }
  },

  async loadOps(id) {
    App.state.ops[id] = await saba.opsGet(id);
    if (id === App.state.activeId) Players.render();
  },

  async load(id) {
    App.state.players[id] = await saba.playersGet(id);
    await Players.loadOps(id);
  },

  render() {
    const id = App.state.activeId;
    const players = (id && App.state.players[id]) || [];
    const ops = (id && App.state.ops[id]) || [];
    const running = App.statusOf(id) === 'running';

    document.querySelector('#pp-count').textContent = players.length;
    const list = document.querySelector('#pp-list');
    list.innerHTML = '';
    for (const name of players) {
      const chip = document.createElement('button');
      chip.className = 'pp-chip';
      chip.dataset.name = name;
      chip.textContent = (ops.includes(name) ? '⭐ ' : '') + name;
      chip.title = 'クリックで操作メニュー';
      list.appendChild(chip);
    }
    const empty = document.querySelector('#pp-empty');
    empty.hidden = players.length > 0;
    empty.textContent = running ? 'まだ誰もいません' : '(停止中)';
  }
};
