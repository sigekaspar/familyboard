// ============ Anmeldung + Microsoft Graph ============
// Alles, was mit dem Microsoft-Konto und der OneDrive-API spricht, läuft über diese Datei.

class NetworkError extends Error {
  constructor(msg){ super(msg || 'Keine Verbindung'); this.name = 'NetworkError'; this.isNetwork = true; }
}
class GraphError extends Error {
  constructor(status, body){
    super('Graph-Fehler ' + status + (body ? ': ' + String(body).slice(0, 300) : ''));
    this.name = 'GraphError'; this.status = status; this.body = body;
  }
}
class ConflictError extends Error {
  constructor(){ super('Die Datei wurde inzwischen von jemand anderem geändert.'); this.name = 'ConflictError'; this.isConflict = true; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isNetworkError(e){ return !!(e && (e.isNetwork || e.name === 'NetworkError' || e.name === 'TypeError' && /fetch/i.test(e.message))); }
function isNotFound(e){ return !!(e && e.status === 404); }

const msalConfig = {
  auth: { clientId: CLIENT_ID, authority: 'https://login.microsoftonline.com/consumers', redirectUri: REDIRECT_URI },
  cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false }
};
let msalInstance = null;
let msalInitError = null;
try{
  if(window.__msalLoadFailed || typeof msal === 'undefined'){
    throw new Error('Die Anmelde-Bibliothek (MSAL) von Microsoft konnte nicht geladen werden. Prüfe deine Internetverbindung oder ob ein Werbeblocker/Firewall alcdn.msauth.net blockiert.');
  }
  msalInstance = new msal.PublicClientApplication(msalConfig);
}catch(e){ msalInitError = e; console.error('MSAL init failed:', e); }

let me = { name:null, email:null, account:null };
let lastAccessToken = null; // für "keepalive"-Anfragen beim Schliessen der App

// Fehlercodes, die bedeuten "kein Netz" – dann NICHT zum Login umleiten.
const MSAL_NETWORK_CODES = ['post_request_failed', 'get_request_failed', 'no_network_connectivity', 'endpoints_resolution_error', 'network_error', 'monitor_window_timeout', 'token_renewal_error'];
const REAUTH_GUARD_KEY = 'reauth_redirect_at';

function msalLogin(){ return msalInstance.loginRedirect({ scopes: SCOPES }); }

async function getAccessToken({ forceRefresh = false } = {}){
  if(!msalInstance) throw new Error('Anmeldung nicht verfügbar');
  const account = me.account || msalInstance.getAllAccounts()[0];
  if(!account) throw new Error('Nicht angemeldet');
  try{
    const result = await msalInstance.acquireTokenSilent({ scopes: SCOPES, account, forceRefresh });
    lastAccessToken = result.accessToken;
    return result.accessToken;
  }catch(e){
    const code = (e && (e.errorCode || e.code)) || '';
    if(!navigator.onLine || MSAL_NETWORK_CODES.includes(code)) throw new NetworkError('Keine Verbindung zu Microsoft');
    // Nur bei echten Anmeldeproblemen neu anmelden – und höchstens einmal pro Minute, damit es keine Schleife gibt.
    const last = parseInt(sessionStorageGet(REAUTH_GUARD_KEY) || '0', 10);
    if(Date.now() - last < 60000){
      throw new Error('Anmeldung abgelaufen – bitte neu anmelden.');
    }
    sessionStorageSet(REAUTH_GUARD_KEY, String(Date.now()));
    await msalInstance.acquireTokenRedirect({ scopes: SCOPES, account });
    throw new Error('redirecting_for_reauth');
  }
}
function sessionStorageGet(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } }
function sessionStorageSet(k, v){ try{ sessionStorage.setItem(k, v); }catch(e){} }

// Zentraler Graph-Aufruf: Token, Wiederholen bei Drosselung (429/503), Token-Erneuerung bei 401.
async function graphRequest(path, options = {}, { raw = false, retries = 4 } = {}){
  const url = path.startsWith('http') ? path : GRAPH + path;
  let attempt = 0, refreshed = false;
  while(true){
    const token = await getAccessToken({ forceRefresh: refreshed });
    let res;
    try{
      res = await fetch(url, { ...options, headers: { 'Authorization': 'Bearer ' + token, ...(options.headers || {}) } });
    }catch(e){ throw new NetworkError(e.message); }
    if(res.status === 401 && !refreshed){ refreshed = true; continue; }
    if((res.status === 429 || res.status === 503 || res.status === 504) && attempt < retries){
      attempt++;
      const ra = parseInt(res.headers.get('Retry-After') || '', 10);
      await sleep(Math.min(isNaN(ra) ? 2 ** attempt : ra, 30) * 1000);
      continue;
    }
    if(res.status === 412) throw new ConflictError();
    if(!res.ok){
      let body = '';
      try{ body = await res.text(); }catch(e){}
      throw new GraphError(res.status, body);
    }
    if(raw) return res;
    if(res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
const graphFetch = (path, options) => graphRequest(path, options);
const graphFetchRaw = (path, options) => graphRequest(path, options, { raw: true });

// Download über die vorsignierte OneDrive-URL (spart den Umweg über Graph).
async function fetchPlain(url, retries = 3){
  for(let attempt = 0; ; attempt++){
    let res;
    try{ res = await fetch(url, { cache: 'no-store' }); }
    catch(e){ throw new NetworkError(e.message); }
    if((res.status === 429 || res.status === 503) && attempt < retries){ await sleep(1000 * 2 ** attempt); continue; }
    if(!res.ok) throw new GraphError(res.status, '');
    return res;
  }
}

// Inhalt einer Datei laden: bevorzugt über downloadUrl, sonst über Graph.
async function downloadItem(item, driveId){
  const dl = item && item['@microsoft.graph.downloadUrl'];
  if(dl){
    try{ return await fetchPlain(dl); }
    catch(e){ if(isNetworkError(e)) throw e; /* abgelaufene URL -> Graph */ }
  }
  return graphFetchRaw(`/drives/${driveId}/items/${item.id}/content`);
}
async function downloadItemJson(item, driveId){
  const res = await downloadItem(item, driveId);
  return res.json();
}

// Begrenzte Parallelität (OneDrive drosselt sonst)
async function mapLimit(list, limit, fn){
  const results = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while(i < list.length){ const idx = i++; results[idx] = await fn(list[idx], idx); }
  });
  await Promise.all(workers);
  return results;
}

// Alle Seiten einer Graph-Liste holen
async function graphListAll(path){
  let res = await graphFetch(path);
  let items = res.value || [];
  while(res['@odata.nextLink']){ res = await graphFetch(res['@odata.nextLink']); items = items.concat(res.value || []); }
  return items;
}

// Mehrere GET-Anfragen in einem $batch (max. 20 pro Anfrage). Liefert {id -> {status, body}}
async function graphBatchGet(urls){
  const out = {};
  for(let i = 0; i < urls.length; i += 20){
    const chunk = urls.slice(i, i + 20).map((url, j) => ({ id: String(i + j), method: 'GET', url }));
    let pending = chunk;
    for(let attempt = 0; pending.length && attempt < 4; attempt++){
      const res = await graphFetch('/$batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: pending })
      });
      const retry = [];
      for(const r of (res.responses || [])){
        if(r.status === 429 || r.status === 503) retry.push(pending.find(p => p.id === r.id));
        else out[r.id] = { status: r.status, body: r.body };
      }
      pending = retry.filter(Boolean);
      if(pending.length) await sleep(1500 * (attempt + 1));
    }
    pending.forEach(p => { out[p.id] = { status: 429, body: null }; });
  }
  return out;
}

// ---------- JSON-Dateien mit Konfliktschutz (eTag / If-Match) ----------
// Liest eine kleine JSON-Datei in einem Ordner. Gibt {data, eTag} zurück; data=null wenn es sie nicht gibt.
async function readJsonFile(driveId, parentId, name){
  let meta;
  try{ meta = await graphFetch(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`); }
  catch(e){ if(isNotFound(e)) return { data: null, eTag: null }; throw e; }
  const data = await downloadItemJson(meta, driveId);
  return { data, eTag: meta.eTag, item: meta };
}
// Liest, verändert und schreibt eine JSON-Datei. Hat sie inzwischen jemand anderes geändert,
// wird neu gelesen und die Änderung noch einmal angewendet – so geht nichts verloren.
// mutate(data) gibt die neuen Daten zurück (oder undefined = nichts zu tun).
async function updateJsonFile(driveId, parentId, name, mutate, fallback){
  for(let attempt = 0; attempt < 5; attempt++){
    const cur = await readJsonFile(driveId, parentId, name);
    const base = cur.data != null ? cur.data : (typeof fallback === 'function' ? fallback() : fallback);
    const next = await mutate(JSON.parse(JSON.stringify(base)));
    if(next === undefined) return base;
    const headers = { 'Content-Type': 'application/json' };
    if(cur.eTag) headers['If-Match'] = cur.eTag;
    try{
      await graphFetch(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content`, {
        method: 'PUT', headers, body: JSON.stringify(next)
      });
      return next;
    }catch(e){
      if(e.isConflict || e.status === 409){ await sleep(200 + Math.random() * 400); continue; }
      throw e;
    }
  }
  throw new Error(`"${name}" konnte wegen gleichzeitiger Änderungen nicht gespeichert werden.`);
}

// ---------- Ordner ----------
async function getChildByPath(driveId, parentId, relPath){
  return graphFetch(`/drives/${driveId}/items/${parentId}:/${relPath.split('/').map(encodeURIComponent).join('/')}`);
}
async function ensureSubfolder(driveId, parentId, folderName){
  try{ return await getChildByPath(driveId, parentId, folderName); }
  catch(e){
    if(!isNotFound(e)) throw e;
    try{
      return await graphFetch(`/drives/${driveId}/items/${parentId}/children`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
      });
    }catch(e2){
      // Gleichzeitig von jemand anderem angelegt -> einfach nochmals holen
      if(e2.status === 409) return getChildByPath(driveId, parentId, folderName);
      throw e2;
    }
  }
}

// ---------- Uploads ----------
// Lädt eine Datei unter genau diesem Namen in <Ordner>/anhaenge hoch (überschreibt eine gleichnamige).
async function uploadAttachment(driveId, folderItemId, path, file){
  const encodedPath = encodeURIComponent(path);
  const base = `/drives/${driveId}/items/${folderItemId}:/${ATTACH_SUBFOLDER}/${encodedPath}`;
  if(file.size < 4 * 1024 * 1024){
    return graphFetch(`${base}:/content`, { method: 'PUT', body: file });
  }
  const session = await graphFetch(`${base}:/createUploadSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
  });
  const chunkSize = 327680 * 10; // muss ein Vielfaches von 320 KiB sein
  let start = 0, finalItem = null;
  while(start < file.size){
    const end = Math.min(start + chunkSize, file.size) - 1;
    const chunk = file.slice(start, end + 1);
    let ok = false;
    for(let attempt = 0; attempt < 4 && !ok; attempt++){
      let res;
      try{
        res = await fetch(session.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end}/${file.size}` },
          body: chunk
        });
      }catch(e){
        if(attempt === 3) throw new NetworkError('Upload abgebrochen');
        await sleep(1000 * 2 ** attempt); continue;
      }
      if(res.status === 200 || res.status === 201){ finalItem = await res.json().catch(() => null); ok = true; }
      else if(res.status === 202){ ok = true; }
      else if(res.status >= 500 || res.status === 429){ await sleep(1000 * 2 ** attempt); }
      else{ const t = await res.text().catch(() => ''); throw new GraphError(res.status, 'Upload fehlgeschlagen ' + t); }
    }
    if(!ok){
      fetch(session.uploadUrl, { method: 'DELETE' }).catch(() => {});
      throw new Error('Upload fehlgeschlagen (mehrere Versuche).');
    }
    start = end + 1;
  }
  if(finalItem && finalItem.name && finalItem.name !== path){
    throw new Error(`Upload wurde unter anderem Namen gespeichert (${finalItem.name}).`);
  }
  return finalItem;
}
async function deleteAttachment(driveId, folderItemId, path){
  if(!path) return;
  try{
    await graphFetchRaw(`/drives/${driveId}/items/${folderItemId}:/${ATTACH_SUBFOLDER}/${encodeURIComponent(path)}`, { method: 'DELETE' });
  }catch(e){ if(!isNotFound(e)) console.warn('Anhang konnte nicht gelöscht werden', path, e); }
}

// Fotos vor dem Upload verkleinern (spart Zeit und OneDrive-Speicher)
async function maybeShrinkImage(file){
  try{
    if(!file || !file.type || !file.type.startsWith('image/')) return file;
    if(/gif|svg/.test(file.type) || file.size < IMAGE_SHRINK_MIN_BYTES) return file;
    if(typeof createImageBitmap !== 'function') return file;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if(bmp.close) bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if(!blob || blob.size >= file.size) return file;
    const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  }catch(e){
    console.warn('Bild konnte nicht verkleinert werden – lade Original hoch', e);
    return file;
  }
}
