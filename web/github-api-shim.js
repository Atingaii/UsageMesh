(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const rawOrigin = 'https://raw.githubusercontent.com';
  const matchingRefs = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/git\/matching-refs\/heads\/um-ledger-$/;

  async function readJson(url) {
    const response = await nativeFetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function validBranches(index) {
    if (!index || index.kind !== 'usagemesh-device-index' || Number(index.schemaVersion) !== 1) {
      return [];
    }
    return [...new Set((Array.isArray(index.branches) ? index.branches : [])
      .map(value => String(value || ''))
      .filter(branch => /^um-ledger-[a-f0-9]{16}$/.test(branch)))]
      .sort();
  }

  async function resolveBranches(repo) {
    const remote = await readJson(`${rawOrigin}/${repo}/um-index/index.json?ts=${Date.now()}`);
    const remoteBranches = validBranches(remote);
    if (remoteBranches.length) return remoteBranches;

    // Bootstrap the primary workspace immediately. New CLI versions publish
    // um-index/index.json on every snapshot change, so this local file is only
    // a migration fallback for ledgers that predate the device index.
    if (repo.toLowerCase() === 'atingaii/usagemesh') {
      const fallback = await readJson(new URL('./device-index.json', location.href).toString());
      return validBranches(fallback);
    }
    return [];
  }

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
    const match = String(url || '').match(matchingRefs);
    if (!match) return nativeFetch(input, init);

    const repo = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    const branches = await resolveBranches(repo);
    const refs = branches.map(branch => ({ ref: `refs/heads/${branch}` }));
    return new Response(JSON.stringify(refs), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  };
})();
