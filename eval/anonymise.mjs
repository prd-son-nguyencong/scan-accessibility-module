// Shared helpers that keep customer names out of the repo.
//  - denylist: sha256 hashes of lowercase tokens (see eval/release-denylist.json), so the list does not reveal names
//  - site aliases: real site id -> s01, s02 ... using a private map that is NOT committed (eval/site-map.local.json)
//  - route/selector hashing: strings that contain a denied term are stored as "h:<hash>" and matched by hash
import crypto from 'node:crypto';
import fs from 'node:fs';

export const DENYLIST_PATH = new URL('./release-denylist.json', import.meta.url);
export const SITE_MAP_PATH = process.env.ADA_EVAL_SITE_MAP || new URL('./site-map.local.json', import.meta.url).pathname;

const sha = (salt, s) => crypto.createHash('sha256').update(`${salt}:${s}`).digest('hex');

let cached = null;
export function loadDenylist(file = DENYLIST_PATH) {
  if (cached && file === DENYLIST_PATH) return cached;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = { salt: j.salt, hashes: new Set(j.hashes), maxGram: j.maxGram || 3, maxLen: j.maxLen || 40, memo: new Map() };
  if (file === DENYLIST_PATH) cached = d;
  return d;
}

export const tokensOf = (text) => String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

/** Normal form of a term the way it is hashed: lowercase alnum tokens joined by "-". */
export const normaliseTerm = (term) => tokensOf(term).join('-');
export const hashTerm = (term, salt = loadDenylist().salt) => sha(salt, normaliseTerm(term));

/** True when any 1..maxGram token run (joined by "-") hashes into the denylist. */
export function containsDenied(text, deny = loadDenylist()) {
  const t = tokensOf(text);
  for (let i = 0; i < t.length; i++) {
    let gram = '';
    for (let n = 0; n < deny.maxGram && i + n < t.length; n++) {
      gram = n ? `${gram}-${t[i + n]}` : t[i];
      if (gram.length > deny.maxLen) break;
      let hit = deny.memo.get(gram);
      if (hit === undefined) { hit = deny.hashes.has(sha(deny.salt, gram)); deny.memo.set(gram, hit); }
      if (hit) return true;
    }
  }
  return false;
}

/** Stable opaque form of a string that must not be stored literally. */
export const hashString = (s, deny = loadDenylist()) => `h:${sha(deny.salt, `str:${s}`).slice(0, 16)}`;
/** Literal form kept when clean, hashed form when it carries a denied term. */
export const safeString = (s, deny = loadDenylist()) => (containsDenied(s, deny) ? hashString(s, deny) : s);
/** Both spellings a corpus row may use for a string seen in a scan report. */
export const variants = (s, deny = loadDenylist()) => [s, hashString(s, deny)];

export function loadSiteMap(file = SITE_MAP_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { sites: {} }; }
}
export const CORPUS_PATH = process.env.ADA_EVAL_CORPUS || new URL('./corpus.json', import.meta.url).pathname;
const aliasNo = (a) => (/^s(\d{2,})$/.exec(a) || [])[1] | 0;
/** Highest sNN already used by the committed corpus, so a new site never reuses the alias of another customer. */
export function committedMaxAlias(file = CORPUS_PATH) {
  try { return Math.max(0, ...JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => aliasNo(r.site))); } catch { return 0; }
}
/** Alias for a real site id; new ids get the next sNN above every alias in the private map and the committed corpus. */
export function aliasFor(site, map) {
  if (/^s\d{2,}$/.test(site)) return site;
  map.sites ||= {};
  if (!map.sites[site]) {
    const next = Math.max(committedMaxAlias(), ...Object.values(map.sites).map(aliasNo)) + 1;
    map.sites[site] = `s${String(next).padStart(2, '0')}`;
  }
  return map.sites[site];
}
/** Accept either an alias or a real name (resolved through the private map when present). */
export const resolveSite = (site, map = loadSiteMap()) => (site && map.sites?.[site]) || site;
export const saveSiteMap = (map, file = SITE_MAP_PATH) => fs.writeFileSync(file, JSON.stringify(map, null, 1) + '\n');

/** Row as it may be committed: alias site, no free text, route and selector hashed when they carry a denied term. */
export function anonymiseRow(row, map, deny = loadDenylist()) {
  const { site, route, selector, rule, verdict, sourceOk, ownerOk, reviewedAt, via, provenance } = row;
  return { site: aliasFor(site, map), route: safeString(route, deny), rule, selector: safeString(selector, deny), verdict, sourceOk, ownerOk, reviewedAt, via, provenance };
}
