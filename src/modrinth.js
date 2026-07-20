/**
 * modrinth.js — Modrinth API(modpack検索・バージョン一覧。v0.4 modpack導入)
 * User-Agentはdownload.jsのfetchJSONに任せる(Paper Fill API呼び出し=paper.jsと同じ流儀。
 * 自前でヘッダは持たない)。
 */
'use strict';

const { fetchJSON } = require('./download');

const API = 'https://api.modrinth.com/v2';

/**
 * modpackを検索する。queryが空なら人気順(index=downloads)、
 * 何か入っていれば関連度順(index=relevance)。
 */
async function searchModpacks(query, { offset, signal } = {}) {
  const q = String(query || '').trim();
  const params = new URLSearchParams({
    query: q,
    facets: JSON.stringify([['project_type:modpack']]),
    index: q ? 'relevance' : 'downloads',
    limit: '20',
    offset: String(offset || 0)
  });
  const j = await fetchJSON(`${API}/search?${params}`, { signal });
  const hits = (j.hits || []).map(h => ({
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    iconUrl: h.icon_url,
    serverSide: h.server_side,
    categories: h.categories || []
  }));
  return { hits, total: j.total_hits || 0 };
}

/**
 * 指定modpackの全バージョン一覧。mrpackファイルを含まないバージョンは除外する。
 * fileは files のうち primary===true(かつ.mrpack)を優先、無ければ最初の.mrpack。
 */
async function versions(idOrSlug, { signal } = {}) {
  const j = await fetchJSON(`${API}/project/${encodeURIComponent(idOrSlug)}/version`, { signal });
  const out = [];
  for (const v of j || []) {
    const files = v.files || [];
    const primary = files.find(f => f.primary);
    const file = (primary && /\.mrpack$/i.test(primary.filename || ''))
      ? primary
      : files.find(f => /\.mrpack$/i.test(f.filename || ''));
    if (!file) continue; /* mrpackファイルが無いバージョンは取り込めないので除外 */
    out.push({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions || [],
      loaders: v.loaders || [],
      date: v.date_published,
      file: { url: file.url, size: file.size, sha512: file.hashes && file.hashes.sha512 }
    });
  }
  return out;
}

module.exports = { searchModpacks, versions };
