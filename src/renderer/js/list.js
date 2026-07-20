/**
 * list.js — サイドバーの鯖一覧
 */
'use strict';

const List = {
  render() {
    const box = document.querySelector('#server-list');
    const servers = (App.state.data && App.state.data.servers) || [];
    document.querySelector('#list-empty').hidden = servers.length > 0;

    box.innerHTML = '';
    for (const s of servers) {
      const st = App.statusOf(s.id);
      const crashed = App.state.states[s.id] && App.state.states[s.id].crashed;
      const card = document.createElement('div');
      card.className = 'server-card' + (s.id === App.state.activeId ? ' active' : '');

      const dot = st === 'running' ? 'running' : st === 'stopping' ? 'stopping' : crashed ? 'crashed' : '';
      const loaderLabel = { paper: 'Paper', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' }[s.loader] || s.loader;

      const name = document.createElement('div');
      name.className = 'sc-name';
      const d = document.createElement('span');
      d.className = 'dot ' + dot;
      name.appendChild(d);
      name.appendChild(document.createTextNode(s.name));

      const sub = document.createElement('div');
      sub.className = 'sc-sub';
      sub.textContent = `${loaderLabel} ${s.mcVersion || '?'} ・ :${s.port || '?'}`;

      card.appendChild(name);
      card.appendChild(sub);
      card.addEventListener('click', () => View.select(s.id));
      box.appendChild(card);
    }
  }
};
