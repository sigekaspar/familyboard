// ============ Daten: Boards, Karten, Reihenfolge, Wichtig, Backups, Archiv, Offline ============

let containerRef = null; // {driveId, itemId}
let boardRef = { driveId:null, itemId:null, folderName:null, color:null };
let boardsList = [];
let boardsMeta = {};
let notesById = {};
let noteOrder = [];
let deltaLink = null;
let orderCTag = null;
let imageCache = {}; // Anhangpfad -> objectURL
let boardCache = {}; // im Speicher: {folderName: {notesById, noteOrder, deltaLink, orderCTag}}
const freshlyLoadedBoards = new Set(); // in dieser Sitzung schon einmal komplett vom Server geladen
const removedIdsByBoard = {};          // je Board: gelöscht/verschoben/archiviert – nicht wieder in die Reihenfolge aufnehmen
function removedIdsFor(boardItemId){ return removedIdsByBoard[boardItemId] || (removedIdsByBoard[boardItemId] = new Set()); }
let isOnline = navigator.onLine;

function localGet(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } }
function localSet(key, val){ try{ localStorage.setItem(key, val); }catch(e){ console.warn('localStorage voll?', e); } }
function localRemove(key){ try{ localStorage.removeItem(key); }catch(e){} }
function uuid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0, v = c==='x' ? r : (r&0x3|0x8); return v.toString(16); });
}
function sanitizeFilename(name){ return (name || 'datei').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function todayStr(){ return isoDateLocal(new Date()); }
function isoDateLocal(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function isImportantBoard(){ return boardRef.folderName === IMPORTANT_BOARD_NAME; }
function isTempId(id){ return typeof id === 'string' && id.startsWith('tmp_'); }

// ---------- Kartenformat ----------
// Wandelt alte Einzel-Typ-Notizen in das kombinierbare Format um (nur beim Anzeigen/Bearbeiten).
function normalizeNote(n){
  if(n.type === 'divider' || n.type === 'note') return n;
  const norm = { ...n, type:'note' };
  if(n.type === 'image'){ norm.imageAttachmentName = n.attachmentName; norm.imageAttachmentPath = n.attachmentPath; }
  if(n.type === 'file'){ norm.fileAttachmentName = n.attachmentName; norm.fileAttachmentPath = n.attachmentPath; }
  return norm;
}
// Felder, die nur in der App existieren und nicht in die Datei gehören
const TRANSIENT_FIELDS = ['fileId', 'eTag', 'cTag', 'dueDate', 'originFolderName', 'pending', 'pendingKind'];
function noteToFile(n){
  const out = { ...n };
  TRANSIENT_FIELDS.forEach(k => delete out[k]);
  return out;
}
function noteFromItem(item, data, folderItemId){
  return normalizeNote({ ...data, fileId: item.id, eTag: item.eTag, cTag: item.cTag, originItemId: folderItemId });
}
function noteAttachmentPaths(n){
  return ['imageAttachmentPath', 'fileAttachmentPath', 'audioAttachmentPath'].map(k => n && n[k]).filter(Boolean);
}
function isNoteFileName(name){ return /^note_.*\.json$/.test(name || ''); }

// ---------- Online/Offline ----------
function setOnline(online){
  const changed = online !== isOnline;
  isOnline = online;
  if(typeof renderConnectivity === 'function') renderConnectivity();
  if(changed && online){ syncQueue().then(() => { if(boardRef.folderName) reloadCurrentBoard(); }); }
}
window.addEventListener('offline', () => setOnline(false));
window.addEventListener('online', () => setOnline(true));

// ---------- Container ("Boards"-Ordner) ----------
async function findContainerCandidates(){
  let own = null, shared = null;
  try{ own = await graphFetch(`/me/drive/root:/${CONTAINER_NAME}`); }
  catch(e){ if(!isNotFound(e)) throw e; }
  try{
    const list = await graphListAll('/me/drive/sharedWithMe');
    const match = list.find(it => it.name === CONTAINER_NAME && it.remoteItem && it.remoteItem.folder);
    if(match) shared = match;
  }catch(e){ if(isNetworkError(e)) throw e; console.warn('sharedWithMe nicht verfügbar', e); }
  return { own, shared };
}
async function createOwnContainer(){
  return graphFetch('/me/drive/root/children', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: CONTAINER_NAME, folder:{}, '@microsoft.graph.conflictBehavior':'fail' })
  });
}
function containerRefFrom(item, isShared){
  if(isShared) return { driveId: item.remoteItem.parentReference.driveId, itemId: item.remoteItem.id };
  return { driveId: item.parentReference.driveId, itemId: item.id };
}

// ---------- Board-Liste + Metadaten ----------
function persistBoardsList(){
  localSet('boards_list_cache', JSON.stringify({ containerItemId: containerRef && containerRef.itemId, boardsList, boardsMeta }));
}
function loadPersistedBoardsList(){
  try{
    const raw = JSON.parse(localGet('boards_list_cache') || 'null');
    if(raw && containerRef && raw.containerItemId === containerRef.itemId){ boardsList = raw.boardsList || []; boardsMeta = raw.boardsMeta || {}; return true; }
  }catch(e){}
  return false;
}
async function refreshBoardsList(){
  const children = await graphListAll(`/drives/${containerRef.driveId}/items/${containerRef.itemId}/children?$select=id,name,folder&$top=200`);
  const folders = children.filter(it => it.folder && !it.name.startsWith('_'));
  const metaRes = await readJsonFile(containerRef.driveId, containerRef.itemId, BOARDS_META_FILE);
  boardsMeta = metaRes.data || {};
  const missing = folders.filter(f => !boardsMeta[f.name]);
  if(missing.length){
    boardsMeta = await updateJsonFile(containerRef.driveId, containerRef.itemId, BOARDS_META_FILE, meta => {
      let changed = false;
      missing.forEach((f, i) => {
        if(!meta[f.name]){
          meta[f.name] = { color: BOARD_COLORS[(Object.keys(meta).length + i) % BOARD_COLORS.length], visibility:'shared' };
          changed = true;
        }
      });
      return changed ? meta : undefined;
    }, {});
  }
  const all = folders.map(f => {
    const m = boardsMeta[f.name] || {};
    return { folderName: f.name, itemId: f.id, driveId: containerRef.driveId, color: m.color || BOARD_COLORS[0], visibility: m.visibility || 'shared', owner: m.owner || null };
  });
  const orderArr = boardsMeta._order || [];
  all.sort((a, b) => {
    const ia = orderArr.indexOf(a.folderName), ib = orderArr.indexOf(b.folderName);
    const ra = ia === -1 ? 9999 : ia, rb = ib === -1 ? 9999 : ib;
    if(ra !== rb) return ra - rb;
    return a.folderName.localeCompare(b.folderName);
  });
  boardsList = all.filter(b => b.visibility !== 'private' || !b.owner || b.owner === me.email);
  const cur = boardsList.find(b => b.itemId === boardRef.itemId);
  if(cur) boardRef = cur;
  persistBoardsList();
  return boardsList;
}
async function updateBoardsMeta(mutate){
  boardsMeta = await updateJsonFile(containerRef.driveId, containerRef.itemId, BOARDS_META_FILE, mutate, {});
  return boardsMeta;
}
function nextUnusedColor(){
  const used = boardsList.map(b => b.color);
  return BOARD_COLORS.find(c => !used.includes(c)) || BOARD_COLORS[0];
}
async function createBoardFolder(name){
  return graphFetch(`/drives/${containerRef.driveId}/items/${containerRef.itemId}/children`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, folder:{}, '@microsoft.graph.conflictBehavior':'fail' })
  });
}

// ---------- Cache je Board ----------
function cacheStorageKey(folderName){ return 'board_cache_' + folderName; }
function persistBoardCache(folderName, state){
  const s = state || { notesById, noteOrder, deltaLink, orderCTag };
  // Offline-Entwürfe (tmp_) nicht in den Cache – die kommen aus der Warteschlange
  const notes = {};
  Object.keys(s.notesById || {}).forEach(k => { if(!isTempId(k)) notes[k] = { ...s.notesById[k], pending:undefined, pendingKind:undefined }; });
  localSet(cacheStorageKey(folderName), JSON.stringify({ notesById: notes, noteOrder: (s.noteOrder || []).filter(id => !isTempId(id)), deltaLink: s.deltaLink || null, orderCTag: s.orderCTag || null }));
}
function loadPersistedBoardCache(folderName){
  const raw = localGet(cacheStorageKey(folderName));
  if(!raw) return null;
  try{ return JSON.parse(raw); }catch(e){ return null; }
}
function snapshotCurrentBoard(){
  if(boardRef.folderName) boardCache[boardRef.folderName] = { notesById, noteOrder, deltaLink, orderCTag };
}
// Zustand eines (evtl. gerade nicht angezeigten) Boards verändern
function mutateBoardState(boardItemId, fn){
  const board = boardsList.find(b => b.itemId === boardItemId);
  if(!board) return;
  if(board.folderName === boardRef.folderName){
    const s = { notesById, noteOrder, deltaLink, orderCTag };
    fn(s);
    notesById = s.notesById; noteOrder = s.noteOrder;
    persistBoardCache(board.folderName);
  } else {
    const s = boardCache[board.folderName] || loadPersistedBoardCache(board.folderName);
    if(!s) return;
    fn(s);
    boardCache[board.folderName] = s;
    persistBoardCache(board.folderName, s);
  }
}

// Karte aus einem Board entfernen (Ansicht, Cache, Reihenfolge)
function removeNoteFromBoardState(boardItemId, fileId){
  removedIdsFor(boardItemId).add(fileId);
  let order = null;
  mutateBoardState(boardItemId, s => {
    delete s.notesById[fileId];
    s.noteOrder = (s.noteOrder || []).filter(id => id !== fileId);
    order = s.noteOrder;
  });
  const board = boardsList.find(b => b.itemId === boardItemId);
  if(board && order && board.folderName !== IMPORTANT_BOARD_NAME) scheduleSaveOrder(board, order);
}

// ---------- Karten eines Boards laden ----------
async function getLatestDeltaLink(board){
  try{
    const res = await graphFetch(`/drives/${board.driveId}/items/${board.itemId}/delta?token=latest`);
    if(res && res['@odata.deltaLink']) return res['@odata.deltaLink'];
  }catch(e){ if(isNetworkError(e)) throw e; }
  // Fallback: komplette Delta-Abfrage, nur um an den Link zu kommen
  let res = await graphFetch(`/drives/${board.driveId}/items/${board.itemId}/delta?$select=id`);
  while(res['@odata.nextLink']) res = await graphFetch(res['@odata.nextLink']);
  return res['@odata.deltaLink'] || null;
}
// Lädt alle Karten eines Boards. Unveränderte Karten (gleicher cTag) werden aus dem Cache übernommen.
async function loadBoardFromServer(board, prev){
  const link = await getLatestDeltaLink(board);
  const children = await graphListAll(`/drives/${board.driveId}/items/${board.itemId}/children?$top=500`);
  const prevNotes = (prev && prev.notesById) || {};
  const files = children.filter(c => c.file);
  const noteFiles = files.filter(f => isNoteFileName(f.name));
  const orderFile = files.find(f => f.name === ORDER_FILE);
  const out = {};
  await mapLimit(noteFiles, DOWNLOAD_CONCURRENCY, async f => {
    const old = prevNotes[f.id];
    if(old && old.cTag && old.cTag === f.cTag){ out[f.id] = { ...old, eTag: f.eTag, originItemId: board.itemId, pending: undefined }; return; }
    try{
      const data = await downloadItemJson(f, board.driveId);
      out[f.id] = noteFromItem(f, data, board.itemId);
    }catch(e){
      if(isNetworkError(e)) throw e;
      console.warn('Notiz nicht lesbar', f.name, e);
      if(old) out[f.id] = old;
    }
  });
  let order = [];
  if(orderFile){
    if(prev && prev.orderCTag && prev.orderCTag === orderFile.cTag) order = prev.noteOrder || [];
    else{
      try{ order = (await downloadItemJson(orderFile, board.driveId)).order || []; }
      catch(e){ if(isNetworkError(e)) throw e; order = (prev && prev.noteOrder) || []; }
    }
  }
  return { notesById: out, noteOrder: order, deltaLink: link, orderCTag: orderFile ? orderFile.cTag : null };
}

// Änderungen seit dem letzten Abruf übernehmen. Gibt true zurück, wenn sich etwas geändert hat.
async function applyDeltaItems(board, items){
  let changed = false;
  await mapLimit(items, DOWNLOAD_CONCURRENCY, async item => {
    if(item.folder) return;
    if(item.deleted){
      if(notesById[item.id]){ delete notesById[item.id]; changed = true; }
      return;
    }
    const parentId = item.parentReference && item.parentReference.id;
    if(item.name === ORDER_FILE){
      if(parentId !== board.itemId || item.cTag === orderCTag || orderSaveTimers[board.itemId]) return;
      try{
        const data = await downloadItemJson(item, board.driveId);
        noteOrder = data.order || []; orderCTag = item.cTag; changed = true;
      }catch(e){ if(isNetworkError(e)) throw e; }
      return;
    }
    if(!isNoteFileName(item.name)) return;
    if(parentId && parentId !== board.itemId){
      // in ein anderes Board, ins Archiv oder ins Backup verschoben/kopiert
      if(notesById[item.id]){ delete notesById[item.id]; changed = true; }
      return;
    }
    if(pendingDeletes[item.id] || removedIdsFor(board.itemId).has(item.id)) return;
    const old = notesById[item.id];
    if(old && old.cTag && old.cTag === item.cTag){ old.eTag = item.eTag; return; }
    try{
      const data = await downloadItemJson(item, board.driveId);
      notesById[item.id] = noteFromItem(item, data, board.itemId);
      changed = true;
    }catch(e){ if(isNetworkError(e)) throw e; console.warn('Notiz nicht lesbar', item.name, e); }
  });
  return changed;
}

// ---------- Reihenfolge (_order.json) ----------
const orderSaveTimers = {};
function scheduleSaveOrder(board = boardRef, order = noteOrder){
  if(!board || !board.itemId) return;
  const key = board.itemId;
  clearTimeout(orderSaveTimers[key]);
  const snapshot = order.slice();
  orderSaveTimers[key] = setTimeout(() => {
    delete orderSaveTimers[key];
    saveOrderNow(board, snapshot);
  }, 500);
}
async function saveOrderNow(board, localOrder){
  if(!isOnline) { scheduleRetryOrder(board); return; }
  const removed = removedIdsFor(board.itemId);
  try{
    await updateJsonFile(board.driveId, board.itemId, ORDER_FILE, remote => {
      const remoteOrder = (remote && remote.order) || [];
      const result = localOrder.filter(id => !removed.has(id) && !isTempId(id));
      const seen = new Set(result);
      // Karten, die jemand anderes inzwischen hinzugefügt hat, an ihrer Stelle einfügen
      remoteOrder.forEach((id, idx) => {
        if(seen.has(id) || removed.has(id)) return;
        const prevId = idx > 0 ? remoteOrder[idx - 1] : null;
        const pos = prevId ? result.indexOf(prevId) + 1 : 0;
        result.splice(pos > 0 ? pos : (prevId ? result.length : 0), 0, id);
        seen.add(id);
      });
      if(JSON.stringify(result) === JSON.stringify(remoteOrder)) return undefined;
      return { order: result };
    }, { order: [] });
  }catch(e){
    if(isNetworkError(e)) scheduleRetryOrder(board);
    else console.warn('Reihenfolge nicht gespeichert', e);
  }
}
const ordersToRetry = new Map();
function scheduleRetryOrder(board){ ordersToRetry.set(board.itemId, board); }
async function retryPendingOrders(){
  for(const [id, board] of ordersToRetry){
    ordersToRetry.delete(id);
    const s = board.folderName === boardRef.folderName ? { noteOrder } : (boardCache[board.folderName] || loadPersistedBoardCache(board.folderName));
    if(s) await saveOrderNow(board, s.noteOrder || []);
  }
}

function orderedNotes(){
  const all = Object.values(notesById);
  const byId = {}; all.forEach(n => byId[n.fileId] = n);
  const ordered = noteOrder.map(id => byId[id]).filter(Boolean);
  const inOrder = new Set(noteOrder);
  const missing = all.filter(n => !inOrder.has(n.fileId)).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  if(missing.length){
    noteOrder = missing.map(n => n.fileId).concat(noteOrder.filter(id => byId[id]));
    if(!isImportantBoard() && missing.some(n => !isTempId(n.fileId))) scheduleSaveOrder();
    return missing.concat(ordered);
  }
  return ordered;
}

// ---------- Karten schreiben ----------
async function createNoteFile(board, note){
  return graphFetch(`/drives/${board.driveId}/items/${board.itemId}:/note_${note.id}.json:/content`, {
    method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(noteToFile(note))
  });
}
async function writeNoteFile(fileId, note, eTag){
  const headers = {'Content-Type':'application/json'};
  if(eTag) headers['If-Match'] = eTag;
  return graphFetch(`/drives/${containerRef.driveId}/items/${fileId}/content`, {
    method:'PUT', headers, body: JSON.stringify(noteToFile(note))
  });
}
// Karte gezielt ändern, ohne gleichzeitige Änderungen anderer zu überschreiben.
// mutate(data) verändert die Kartendaten und gibt sie zurück (undefined = nichts zu tun).
async function updateNoteFile(fileId, mutate, cached){
  // Schnellweg: mit bekannter Version direkt schreiben
  if(cached && cached.eTag){
    const next = mutate(JSON.parse(JSON.stringify(noteToFile(cached))));
    if(next === undefined) return { data: noteToFile(cached), item: null };
    try{
      const item = await writeNoteFile(fileId, next, cached.eTag);
      return { data: next, item };
    }catch(e){ if(!e.isConflict) throw e; }
  }
  for(let attempt = 0; attempt < 4; attempt++){
    const meta = await graphFetch(`/drives/${containerRef.driveId}/items/${fileId}`);
    const data = await downloadItemJson(meta, containerRef.driveId);
    const next = mutate(data);
    if(next === undefined) return { data, item: meta };
    try{
      const item = await writeNoteFile(fileId, next, meta.eTag);
      return { data: next, item };
    }catch(e){ if(!e.isConflict) throw e; await sleep(200 + Math.random() * 300); }
  }
  throw new Error('Karte konnte wegen gleichzeitiger Änderungen nicht gespeichert werden.');
}
async function fetchNoteLatest(fileId){
  const meta = await graphFetch(`/drives/${containerRef.driveId}/items/${fileId}`);
  const data = await downloadItemJson(meta, containerRef.driveId);
  return noteFromItem(meta, data, meta.parentReference && meta.parentReference.id);
}
async function deleteNoteCompletely(fileId, note, folderItemId){
  try{ await graphFetchRaw(`/drives/${containerRef.driveId}/items/${fileId}`, { method:'DELETE' }); }
  catch(e){ if(!isNotFound(e)) throw e; }
  const folder = folderItemId || (note && note.originItemId);
  if(folder) for(const p of noteAttachmentPaths(note)) await deleteAttachment(containerRef.driveId, folder, p);
  await setImportant(fileId, false).catch(e => console.warn(e));
}

// ---------- "Wichtig"-Index ----------
function normalizeImportantList(raw){ return (raw || []).map(x => typeof x === 'string' ? { id:x, dueDate:null } : x); }
async function importantIndexUpdate(fn){
  return updateJsonFile(containerRef.driveId, containerRef.itemId, IMPORTANT_INDEX_FILE, raw => fn(normalizeImportantList(raw)), []);
}
async function setImportant(noteId, isImportant){
  if(isTempId(noteId)) return;
  await importantIndexUpdate(list => {
    const existing = list.find(x => x.id === noteId);
    if(!!existing === !!isImportant) return undefined;
    if(isImportant){ list.push({ id: noteId, dueDate: null }); return list; }
    return list.filter(x => x.id !== noteId);
  });
  if(isImportant) await ensureImportantBoardExists();
}
async function removeImportantIds(ids){
  if(!ids.length) return;
  const set = new Set(ids);
  await importantIndexUpdate(list => list.some(x => set.has(x.id)) ? list.filter(x => !set.has(x.id)) : undefined);
}
async function setImportantDueDate(noteId, dueDate){
  await importantIndexUpdate(list => {
    const entry = list.find(x => x.id === noteId);
    if(entry){ if(entry.dueDate === dueDate) return undefined; entry.dueDate = dueDate; }
    else list.push({ id: noteId, dueDate });
    return list;
  });
}
async function ensureImportantBoardExists(){
  if(boardsList.some(b => b.folderName === IMPORTANT_BOARD_NAME)) return;
  try{ await createBoardFolder(IMPORTANT_BOARD_NAME); }catch(e){ if(e.status !== 409) console.warn(e); }
  await refreshBoardsList();
  if(typeof renderBoardTabs === 'function') renderBoardTabs();
}
// Lädt alle als wichtig markierten Karten (Metadaten gebündelt per $batch).
async function loadImportantFromServer(prev){
  const res = await readJsonFile(containerRef.driveId, containerRef.itemId, IMPORTANT_INDEX_FILE);
  const list = normalizeImportantList(res.data);
  const metas = await graphBatchGet(list.map(e => `/drives/${containerRef.driveId}/items/${encodeURIComponent(e.id)}`));
  const prevNotes = (prev && prev.notesById) || {};
  const visibleBoardIds = new Set(boardsList.map(b => b.itemId));
  const gone = [];
  const fresh = {};
  await mapLimit(list, DOWNLOAD_CONCURRENCY, async (entry, idx) => {
    const r = metas[String(idx)];
    if(!r) return;
    if(r.status === 404){ gone.push(entry.id); return; }
    const old = prevNotes[entry.id];
    if(r.status !== 200){ if(old) fresh[entry.id] = { ...old, dueDate: entry.dueDate || null }; return; }
    const item = r.body;
    const parent = item.parentReference || {};
    if(parent.path && /\/(_archive|_backups)(\/|$)/.test(parent.path)){ gone.push(entry.id); return; }
    if(!visibleBoardIds.has(parent.id)) return; // privates Board einer anderen Person
    let n;
    if(old && old.cTag && old.cTag === item.cTag) n = { ...old, eTag: item.eTag, pending: undefined };
    else{
      try{ n = noteFromItem(item, await downloadItemJson(item, containerRef.driveId), parent.id); }
      catch(e){ if(isNetworkError(e)) throw e; if(old) n = old; else return; }
    }
    n.originItemId = parent.id;
    n.dueDate = entry.dueDate || null;
    fresh[entry.id] = n;
  });
  if(gone.length) removeImportantIds(gone).catch(e => console.warn('Aufräumen von Wichtig fehlgeschlagen', e));
  const wichtig = boardsList.find(b => b.folderName === IMPORTANT_BOARD_NAME);
  let order = (prev && prev.noteOrder) || [];
  if(wichtig){
    try{ const o = await readJsonFile(wichtig.driveId, wichtig.itemId, ORDER_FILE); order = (o.data && o.data.order) || []; }
    catch(e){ if(isNetworkError(e)) throw e; }
  }
  return { notesById: fresh, noteOrder: order, deltaLink: null, orderCTag: res.eTag };
}

// ---------- Tägliches Backup (30 Tage Verlauf, ohne Anhänge) ----------
async function maybeRunDailyBackup(board){
  if(!board || board.folderName === IMPORTANT_BOARD_NAME || !isOnline) return;
  const today = todayStr();
  const flagKey = 'backup_done_' + board.itemId;
  if(localGet(flagKey) === today) return;
  try{
    const backupFolder = await ensureSubfolder(board.driveId, board.itemId, BACKUP_FOLDER);
    let exists = true;
    try{ await getChildByPath(board.driveId, backupFolder.id, today); }
    catch(e){ if(isNotFound(e)) exists = false; else throw e; }
    if(!exists){
      const ok = await copyBoardNotesTo(board, backupFolder.id, today);
      if(!ok) return;
      await cleanupOldBackups(board.driveId, backupFolder.id);
    }
    localSet(flagKey, today);
  }catch(e){ console.warn('Tägliches Backup fehlgeschlagen', e); }
}
// Kopiert alle Karten + Reihenfolge eines Boards in einen neuen Unterordner von parentId.
async function copyBoardNotesTo(board, parentId, folderName){
  const children = await graphListAll(`/drives/${board.driveId}/items/${board.itemId}/children?$select=id,name,file&$top=500`);
  const toBackup = children.filter(it => it.file && (isNoteFileName(it.name) || it.name === ORDER_FILE));
  if(!toBackup.length) return false;
  const dayFolder = await graphFetch(`/drives/${board.driveId}/items/${parentId}/children`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: folderName, folder:{}, '@microsoft.graph.conflictBehavior':'replace' })
  });
  await mapLimit(toBackup, 4, item => graphFetchRaw(`/drives/${board.driveId}/items/${item.id}/copy`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ parentReference:{ driveId: board.driveId, id: dayFolder.id }, name: item.name })
  }).catch(e => console.warn('Backup-Kopie fehlgeschlagen', item.name, e)));
  return true;
}
async function cleanupOldBackups(driveId, backupFolderId){
  try{
    const res = await graphListAll(`/drives/${driveId}/items/${backupFolderId}/children?$select=id,name,folder&$top=500`);
    const days = res.filter(it => it.folder && /^\d{4}-\d{2}-\d{2}$/.test(it.name)).sort((a, b) => a.name.localeCompare(b.name));
    const safety = res.filter(it => it.folder && it.name.startsWith(SAFETY_BACKUP_PREFIX)).sort((a, b) => a.name.localeCompare(b.name));
    const toDelete = days.slice(0, Math.max(0, days.length - BACKUP_RETENTION_DAYS))
      .concat(safety.slice(0, Math.max(0, safety.length - SAFETY_BACKUP_KEEP)));
    for(const d of toDelete) await graphFetchRaw(`/drives/${driveId}/items/${d.id}`, { method:'DELETE' }).catch(() => {});
  }catch(e){}
}
async function listBackups(board){
  let backupFolder;
  try{ backupFolder = await getChildByPath(board.driveId, board.itemId, BACKUP_FOLDER); }
  catch(e){ if(isNotFound(e)) return []; throw e; }
  const res = await graphListAll(`/drives/${board.driveId}/items/${backupFolder.id}/children?$select=id,name,folder&$top=500`);
  return res.filter(it => it.folder).sort((a, b) => b.name.localeCompare(a.name));
}
// Wiederherstellen: 1) aktuellen Stand sichern, 2) Backup-Dateien in die bestehenden Dateien schreiben
// (gleiche Datei-IDs -> Verweise in "Wichtig" bleiben gültig), 3) erst danach überzählige Karten entfernen.
async function restoreFromBackup(board, dayFolderId){
  const backupFolder = await ensureSubfolder(board.driveId, board.itemId, BACKUP_FOLDER);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  await copyBoardNotesTo(board, backupFolder.id, SAFETY_BACKUP_PREFIX + stamp);

  const snap = (await graphListAll(`/drives/${board.driveId}/items/${dayFolderId}/children?$top=500`)).filter(it => it.file);
  const current = (await graphListAll(`/drives/${board.driveId}/items/${board.itemId}/children?$select=id,name,file&$top=500`))
    .filter(it => it.file && (isNoteFileName(it.name) || it.name === ORDER_FILE));
  const snapNames = new Set(snap.map(s => s.name));
  const snapNotes = snap.filter(s => isNoteFileName(s.name));
  const snapOrder = snap.find(s => s.name === ORDER_FILE);
  const failures = [];
  await mapLimit(snapNotes, 4, async s => {
    try{
      const body = await (await downloadItem(s, board.driveId)).text();
      await graphFetch(`/drives/${board.driveId}/items/${board.itemId}:/${encodeURIComponent(s.name)}:/content`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body
      });
    }catch(e){ failures.push(s.name); }
  });
  if(failures.length) throw new Error(`${failures.length} Karte(n) konnten nicht wiederhergestellt werden. Der aktuelle Stand wurde nicht gelöscht.`);
  if(snapOrder){
    const body = await (await downloadItem(snapOrder, board.driveId)).text();
    await graphFetch(`/drives/${board.driveId}/items/${board.itemId}:/${ORDER_FILE}:/content`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body
    });
  }
  for(const item of current){
    if(!snapNames.has(item.name)) await graphFetchRaw(`/drives/${board.driveId}/items/${item.id}`, { method:'DELETE' }).catch(() => {});
  }
}

// ---------- Archiv ----------
async function listArchivedNotes(board){
  let folder;
  try{ folder = await getChildByPath(board.driveId, board.itemId, ARCHIVE_FOLDER); }
  catch(e){ if(isNotFound(e)) return []; throw e; }
  const children = (await graphListAll(`/drives/${board.driveId}/items/${folder.id}/children?$top=500`)).filter(it => it.file && isNoteFileName(it.name));
  const items = await mapLimit(children, DOWNLOAD_CONCURRENCY, async f => {
    try{ return noteFromItem(f, await downloadItemJson(f, board.driveId), board.itemId); }
    catch(e){ return null; }
  });
  return items.filter(Boolean).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
}
async function moveItem(fileId, newParentId){
  return graphFetch(`/drives/${containerRef.driveId}/items/${fileId}`, {
    method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ parentReference: { id: newParentId } })
  });
}

// ---------- Offline-Warteschlange (IndexedDB) ----------
// Änderungen, die ohne Internet gemacht werden, landen hier und werden später übertragen.
const OfflineQueue = {
  db: null,
  items: [],
  async open(){
    if(this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('familyboard', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath:'qid', autoIncrement:true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async _store(mode){ const db = await this.open(); return db.transaction('queue', mode).objectStore('queue'); },
  _wrap(req){ return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); },
  async load(){
    try{ this.items = await this._wrap((await this._store('readonly')).getAll()); }
    catch(e){ console.warn('Offline-Speicher nicht verfügbar', e); this.items = []; }
    return this.items;
  },
  async add(op){
    op.createdAt = Date.now();
    op.qid = await this._wrap((await this._store('readwrite')).add(op));
    this.items.push(op);
    if(typeof renderConnectivity === 'function') renderConnectivity();
    return op;
  },
  async put(op){ await this._wrap((await this._store('readwrite')).put(op)); },
  async remove(op){
    await this._wrap((await this._store('readwrite')).delete(op.qid));
    this.items = this.items.filter(x => x.qid !== op.qid);
    if(typeof renderConnectivity === 'function') renderConnectivity();
  },
  findCreate(tempId){ return this.items.find(x => x.kind === 'create' && x.tempId === tempId); }
};

let syncRunning = false;
async function syncQueue(){
  if(syncRunning || !isOnline || !containerRef) return;
  syncRunning = true;
  try{
    await retryPendingOrders();
    for(const op of OfflineQueue.items.slice()){
      try{
        await runQueuedOp(op);
        await OfflineQueue.remove(op);
      }catch(e){
        if(isNetworkError(e)){ setOnline(false); break; }
        op.attempts = (op.attempts || 0) + 1;
        op.lastError = e.message;
        await OfflineQueue.put(op).catch(() => {});
        console.warn('Offline-Änderung konnte nicht übertragen werden', op, e);
      }
    }
  }finally{
    syncRunning = false;
    if(typeof renderConnectivity === 'function') renderConnectivity();
  }
}
async function runQueuedOp(op){
  const board = boardsList.find(b => b.itemId === op.boardItemId) || { driveId: containerRef.driveId, itemId: op.boardItemId };
  if(op.kind === 'create'){
    for(const a of (op.attachments || [])) await uploadAttachment(board.driveId, board.itemId, a.path, a.file);
    const created = await createNoteFile(board, op.note);
    const realNote = { ...op.note, fileId: created.id, eTag: created.eTag, cTag: created.cTag, originItemId: board.itemId };
    replaceTempNote(board.itemId, op.tempId, realNote);
    if(op.note.important) await setImportant(created.id, true);
    showStatus('Offline-Karte übertragen');
  } else if(op.kind === 'update'){
    for(const a of (op.attachments || [])) await uploadAttachment(board.driveId, board.itemId, a.path, a.file);
    try{
      const item = await writeNoteFile(op.fileId, op.note, op.baseETag);
      mutateBoardState(board.itemId, s => { s.notesById[op.fileId] = { ...op.note, fileId: op.fileId, eTag: item.eTag, cTag: item.cTag, originItemId: board.itemId }; });
      for(const p of (op.removeAttachments || [])) await deleteAttachment(board.driveId, board.itemId, p);
    }catch(e){
      if(!e.isConflict) throw e;
      // Inzwischen online geändert: die Offline-Version als zusätzliche Karte behalten
      const copy = { ...op.note, id: uuid(), timestamp: new Date().toISOString() };
      copy.text = (copy.text ? copy.text + '\n' : '') + '(Offline-Version – Konflikt)';
      const created = await createNoteFile(board, copy);
      mutateBoardState(board.itemId, s => { s.notesById[created.id] = { ...copy, fileId: created.id, eTag: created.eTag, cTag: created.cTag, originItemId: board.itemId }; s.noteOrder.unshift(created.id); });
      scheduleSaveOrder(board, (board.folderName === boardRef.folderName ? noteOrder : ((boardCache[board.folderName] || {}).noteOrder || [created.id])));
      showStatus('Konflikt: Offline-Version als neue Karte gespeichert', 5000);
    }
    await setImportant(op.fileId, !!op.note.important);
  } else if(op.kind === 'toggle'){
    const res = await updateNoteFile(op.fileId, data => {
      const it = (data.items || []).find(x => x.id === op.itemId);
      if(!it || it.done === op.done) return undefined;
      it.done = op.done; return data;
    });
    mutateBoardState(board.itemId, s => { const cur = s.notesById[op.fileId]; if(cur) s.notesById[op.fileId] = { ...cur, ...normalizeNote(res.data), fileId: op.fileId, eTag: res.item ? res.item.eTag : cur.eTag, cTag: res.item ? res.item.cTag : cur.cTag, pending: undefined }; });
  } else if(op.kind === 'delete'){
    await deleteNoteCompletely(op.fileId, op.note, board.itemId);
    removeNoteFromBoardState(board.itemId, op.fileId);
  }
  if(board.folderName === boardRef.folderName && typeof renderBoard === 'function') renderBoard();
}
function replaceTempNote(boardItemId, tempId, realNote){
  mutateBoardState(boardItemId, s => {
    delete s.notesById[tempId];
    s.notesById[realNote.fileId] = realNote;
    const idx = s.noteOrder.indexOf(tempId);
    if(idx >= 0) s.noteOrder[idx] = realNote.fileId; else s.noteOrder.unshift(realNote.fileId);
  });
  const board = boardsList.find(b => b.itemId === boardItemId);
  if(board){
    const s = board.folderName === boardRef.folderName ? { noteOrder } : (boardCache[board.folderName] || loadPersistedBoardCache(board.folderName) || { noteOrder: [realNote.fileId] });
    scheduleSaveOrder(board, s.noteOrder);
  }
}
// Offline-Änderungen in die Ansicht eines Boards einblenden
function overlayQueuedChanges(board){
  for(const op of OfflineQueue.items){
    if(op.boardItemId !== board.itemId) continue;
    if(op.kind === 'create'){
      notesById[op.tempId] = { ...op.note, fileId: op.tempId, originItemId: board.itemId, pending: true };
      if(!noteOrder.includes(op.tempId)) noteOrder.unshift(op.tempId);
      (op.attachments || []).forEach(a => { if(!imageCache[a.path]) imageCache[a.path] = URL.createObjectURL(a.file); });
    } else if(op.kind === 'update'){
      if(notesById[op.fileId]) notesById[op.fileId] = { ...notesById[op.fileId], ...op.note, fileId: op.fileId, pending: true };
      (op.attachments || []).forEach(a => { if(!imageCache[a.path]) imageCache[a.path] = URL.createObjectURL(a.file); });
    } else if(op.kind === 'toggle'){
      const n = notesById[op.fileId];
      const it = n && (n.items || []).find(x => x.id === op.itemId);
      if(it){ it.done = op.done; n.pending = true; }
    } else if(op.kind === 'delete'){
      delete notesById[op.fileId];
    }
  }
}
