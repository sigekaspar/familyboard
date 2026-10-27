// ============ Oberfläche ============

// ---------- Hilfsfunktionen ----------
function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const escapeAttr = escapeHtml;
// Nur echte Web-/Mail-/Telefon-Links zulassen (kein "javascript:" o.ä.)
function safeUrl(raw){
  const s = String(raw || '').trim();
  if(!s) return '';
  if(/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if(/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // anderes Schema -> blockieren
  return 'https://' + s.replace(/^\/+/, '');
}
function $(id){ return document.getElementById(id); }
function showStatus(msg, ms = 2500){
  const el = $('status-bar');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), ms);
}
function showError(prefix, err){
  if(err && err.message === 'redirecting_for_reauth') return;
  if(isNetworkError(err)){ setOnline(false); showStatus('Keine Verbindung – bitte später nochmals versuchen', 4000); return; }
  alert(prefix + (err && err.message ? ': ' + err.message : ''));
}
function contrastColor(hex){
  const h = (hex || '#000000').replace('#', '');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  return (0.299*r + 0.587*g + 0.114*b) / 255 > 0.6 ? '#000' : '#f2f2f2';
}
function revokeImageCache(){
  Object.values(imageCache).forEach(u => { try{ URL.revokeObjectURL(u); }catch(e){} });
  imageCache = {};
}
function formatShortDate(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return '';
  return d.toLocaleDateString('de-CH', { day:'2-digit', month:'2-digit' });
}

// ---------- Auswahl-Dialog (ersetzt prompt/confirm bei wichtigen Entscheidungen) ----------
function choose(title, message, options){
  return new Promise(resolve => {
    $('choice-title').textContent = title;
    $('choice-message').textContent = message || '';
    $('choice-message').style.display = message ? 'block' : 'none';
    const list = $('choice-list');
    list.innerHTML = options.map((o, i) =>
      `<button type="button" class="btn ${o.primary ? 'btn-primary' : 'btn-secondary'}" data-choice="${i}" ${o.danger ? 'style="color:#b23;"' : ''}>${escapeHtml(o.label)}${o.hint ? `<br><small style="font-weight:400;opacity:0.7;">${escapeHtml(o.hint)}</small>` : ''}</button>`
    ).join('');
    const close = val => { $('choice-modal').style.display = 'none'; list.onclick = null; $('choice-cancel').onclick = null; resolve(val); };
    list.onclick = e => { const b = e.target.closest('[data-choice]'); if(b) close(options[+b.dataset.choice].value); };
    $('choice-cancel').onclick = () => close(null);
    $('choice-modal').style.display = 'flex';
  });
}

// ---------- Kopfzeile: Verbindung + Warteschlange ----------
function renderHeader(){
  $('user-chip').textContent = me.name || me.email || '';
  renderConnectivity();
}
function renderConnectivity(){
  const el = $('connectivity');
  if(!el) return;
  const pending = OfflineQueue.items.length;
  let html = '';
  if(!isOnline) html += `<span class="offline-chip">📡 Offline</span>`;
  if(pending) html += `<button class="sync-chip" data-action="queue-info" style="border:none;cursor:pointer;">⏳ ${pending} ausstehend</button>`;
  el.innerHTML = html;
}
async function showQueueInfo(){
  const n = OfflineQueue.items.length;
  const failed = OfflineQueue.items.filter(o => o.attempts);
  const msg = `${n} Änderung(en) warten auf Übertragung.` + (failed.length ? `\n\n${failed.length} davon sind schon fehlgeschlagen:\n` + failed.map(f => '• ' + (f.lastError || 'Fehler')).slice(0, 3).join('\n') : '');
  const choice = await choose('Ausstehende Änderungen', msg, [
    { value:'retry', label:'Jetzt übertragen', primary:true },
    { value:'discard', label:'Alle verwerfen', danger:true, hint:'Offline erstellte Karten gehen verloren' }
  ]);
  if(choice === 'retry'){ setOnline(navigator.onLine); await syncQueue(); if(OfflineQueue.items.length) showStatus('Noch nicht alles übertragen'); else showStatus('Alles übertragen'); }
  if(choice === 'discard' && confirm('Wirklich alle ausstehenden Änderungen verwerfen?')){
    for(const op of OfflineQueue.items.slice()) await OfflineQueue.remove(op);
    await reloadCurrentBoard();
  }
}

// ---------- Update-Erkennung ----------
async function checkForUpdate(){
  if(!navigator.onLine) return;
  try{
    const res = await fetch('js/config.js?t=' + Date.now(), { cache:'no-store' });
    const text = await res.text();
    const match = /APP_VERSION\s*=\s*'([^']+)'/.exec(text);
    if(match && match[1] !== APP_VERSION) showUpdateBanner();
  }catch(e){}
}
function showUpdateBanner(){
  if($('update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.innerHTML = `<span>Es gibt eine neuere Version der App.</span><button data-action="apply-update">Neu laden</button>`;
  document.body.appendChild(el);
}
async function applyUpdate(){
  try{
    if('caches' in window){ const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    if(navigator.serviceWorker){ const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.update().catch(() => {}))); }
  }catch(e){}
  location.reload();
}

// ---------- Anmelden + Verbinden ----------
async function login(){
  if(msalInitError){
    $('login-area').innerHTML = `<div class="error-box">${escapeHtml(msalInitError.message)}</div>
      <button class="btn btn-primary" style="margin-top:10px;" data-action="reload">Seite neu laden</button>`;
    return;
  }
  try{ await msalLogin(); }
  catch(err){
    $('login-area').innerHTML = `<div class="error-box">Login konnte nicht gestartet werden: ${escapeHtml(err.message)}</div>
      <button class="btn btn-primary" style="margin-top:10px;" data-action="login">Erneut versuchen</button>`;
  }
}
async function connectContainer(){
  const errEl = $('setup-error');
  errEl.innerHTML = '';
  try{
    const { own, shared } = await findContainerCandidates();
    let ref;
    if(own && shared){
      const ownerName = (shared.remoteItem.shared && shared.remoteItem.shared.owner && shared.remoteItem.shared.owner.user && shared.remoteItem.shared.owner.user.displayName) || 'jemand anderem';
      const choice = await choose('Welchen "Boards"-Ordner verwenden?',
        'Es gibt einen eigenen "Boards"-Ordner in deinem OneDrive und einen, der mit dir geteilt wurde.',
        [{ value:'shared', label:`Geteilter Ordner von ${ownerName}`, hint:'Richtig, wenn du einem bestehenden Team beitrittst', primary:true },
         { value:'own', label:'Mein eigener Ordner' }]);
      if(!choice) return;
      ref = choice === 'shared' ? containerRefFrom(shared, true) : containerRefFrom(own, false);
    } else if(shared){ ref = containerRefFrom(shared, true); }
    else if(own){ ref = containerRefFrom(own, false); }
    else { ref = containerRefFrom(await createOwnContainer(), false); }
    containerRef = ref;
    localSet('container_ref', JSON.stringify(containerRef));
    await refreshBoardsList();
    $('login-screen').style.display = 'none';
    if(boardsList.length){
      const activeName = localGet('active_board_name');
      boardRef = boardsList.find(b => b.folderName === activeName) || boardsList[0];
      startBoard();
    } else showNoBoardsScreen();
  }catch(err){
    errEl.innerHTML = `<div class="error-box">Verbindung fehlgeschlagen: ${escapeHtml(err.message)}</div>`;
  }
}
function showNoBoardsScreen(){
  $('board').style.display = 'none';
  $('fab-add').style.display = 'none';
  $('setup-connect').style.display = 'none';
  $('setup-nofirst').style.display = 'block';
  $('setup-screen').style.display = 'block';
}

// ---------- Board-Tabs ----------
function applyBoardColor(){ document.documentElement.style.setProperty('--bg', isImportantBoard() ? '#000000' : (boardRef.color || BOARD_COLORS[0])); }
function updateFabVisibility(){ $('fab-add').style.display = (isImportantBoard() || searchState.all) ? 'none' : 'block'; }
function renderBoardTabs(){
  const el = $('board-tabs');
  if(!boardsList.length){ el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = boardsList.map(b => {
    const isActive = b.folderName === boardRef.folderName;
    const isSpecial = b.folderName === IMPORTANT_BOARD_NAME;
    const name = escapeAttr(b.folderName);
    return `<div class="board-tab-wrap ${isActive ? 'has-settings' : ''}">
      <button class="board-tab ${isActive ? 'active' : ''}" style="${isActive ? '' : `background:${escapeAttr(b.color)};color:${contrastColor(b.color)};`}" data-action="switch-board" data-board="${name}">${isSpecial ? '⭐ ' : ''}${escapeHtml(b.folderName)}</button>
      ${isActive ? `<button class="board-tab-settings" data-action="edit-board" data-board="${name}" title="Board bearbeiten">⚙</button>` : ''}
    </div>`;
  }).join('')
    + `<button class="board-tab-add" data-action="manage-boards" title="Boards verwalten / Reihenfolge ändern">☰</button>`
    + `<button class="board-tab-add" data-action="add-board" title="Neues Board hinzufügen">+</button>`;
  const activeTab = el.querySelector('.board-tab.active');
  if(activeTab) activeTab.scrollIntoView({ inline:'center', block:'nearest' });
}

// ---------- Boards verwalten ----------
function openManageBoardsModal(){ renderManageBoardsList(); $('manage-boards-modal').style.display = 'flex'; }
function closeManageBoardsModal(){ $('manage-boards-modal').style.display = 'none'; }
function renderManageBoardsList(){
  $('manage-boards-list').innerHTML = boardsList.map((b, i) => `
    <div class="manage-board-row">
      <span class="swatch" style="background:${escapeAttr(b.color)};"></span>
      <span class="name">${b.folderName === IMPORTANT_BOARD_NAME ? '⭐ ' : ''}${escapeHtml(b.folderName)}</span>
      <button data-action="move-board" data-board="${escapeAttr(b.folderName)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Nach oben">↑</button>
      <button data-action="move-board" data-board="${escapeAttr(b.folderName)}" data-dir="1" ${i === boardsList.length - 1 ? 'disabled' : ''} title="Nach unten">↓</button>
    </div>`).join('');
}
async function moveBoardOrder(name, direction){
  const idx = boardsList.findIndex(b => b.folderName === name);
  const newIdx = idx + direction;
  if(idx < 0 || newIdx < 0 || newIdx >= boardsList.length) return;
  const arr = boardsList.map(b => b.folderName);
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  [boardsList[idx], boardsList[newIdx]] = [boardsList[newIdx], boardsList[idx]];
  renderManageBoardsList(); renderBoardTabs();
  try{
    await updateBoardsMeta(meta => {
      // Boards anderer Personen (privat) behalten ihren Platz am Ende
      const rest = (meta._order || []).filter(n => !arr.includes(n));
      meta._order = arr.concat(rest);
      return meta;
    });
    persistBoardsList();
  }catch(e){ showError('Reihenfolge nicht gespeichert', e); }
}

// ---------- Board erstellen/bearbeiten ----------
let boardModalMode = 'add';
let boardModalColor = BOARD_COLORS[0];
let boardModalOriginalName = null;
function renderColorSwatches(){
  $('board-color-swatches').innerHTML = BOARD_COLORS.map(c =>
    `<div class="color-swatch ${c === boardModalColor ? 'selected' : ''}" style="background:${c};" data-action="pick-color" data-color="${c}"></div>`).join('');
}
function openAddBoardModal(){
  boardModalMode = 'add';
  boardModalColor = nextUnusedColor();
  boardModalOriginalName = null;
  $('board-modal-title').textContent = 'Board erstellen';
  $('board-modal-hint').textContent = 'Es wird ein neuer Unterordner mit diesem Namen in "Boards" angelegt.';
  $('board-name-input').value = '';
  $('board-name-input').disabled = false;
  $('board-private-checkbox').checked = false;
  $('board-save-btn').textContent = 'Erstellen';
  ['board-delete-btn', 'board-history-btn', 'board-archive-btn'].forEach(id => $(id).style.display = 'none');
  renderColorSwatches();
  $('board-modal').style.display = 'flex';
  setTimeout(() => $('board-name-input').focus(), 50);
}
function openEditBoardModal(folderName){
  const b = boardsList.find(x => x.folderName === folderName);
  if(!b) return;
  boardModalMode = 'edit';
  boardModalColor = b.color || BOARD_COLORS[0];
  boardModalOriginalName = b.folderName;
  const isSpecial = folderName === IMPORTANT_BOARD_NAME;
  $('board-modal-title').textContent = 'Board bearbeiten';
  $('board-modal-hint').textContent = isSpecial
    ? 'Dieses Board wird automatisch von der App verwaltet (Sammlung markierter Karten) und kann nicht umbenannt werden.'
    : 'Name kann geändert werden – wird für alle sichtbar umbenannt (der OneDrive-Ordner selbst wird mit umbenannt).';
  $('board-name-input').value = b.folderName;
  $('board-name-input').disabled = isSpecial;
  $('board-private-checkbox').checked = b.visibility === 'private';
  $('board-save-btn').textContent = 'Speichern';
  ['board-delete-btn', 'board-history-btn', 'board-archive-btn'].forEach(id => $(id).style.display = isSpecial ? 'none' : 'inline-block');
  renderColorSwatches();
  $('board-modal').style.display = 'flex';
}
function closeBoardModal(){ $('board-modal').style.display = 'none'; }
function validBoardName(name){
  if(!name) return 'Bitte einen Namen eingeben.';
  if(/[\\/:*?"<>|#%]/.test(name)) return 'Der Name darf keines dieser Zeichen enthalten: \\ / : * ? " < > | # %';
  if(name.startsWith('_') || name.startsWith('.')) return 'Der Name darf nicht mit _ oder . beginnen.';
  return null;
}
async function saveBoardModal(){
  const name = $('board-name-input').value.trim();
  const isPrivate = $('board-private-checkbox').checked;
  const err = validBoardName(name);
  if(err){ alert(err); return; }
  if(!isOnline){ showStatus('Offline – Boards können nur online geändert werden', 3500); return; }
  const btn = $('board-save-btn'); btn.disabled = true;
  try{
    if(boardModalMode === 'add'){
      if(boardsList.some(b => b.folderName === name)){ closeBoardModal(); showStatus('Board existiert schon'); await switchBoard(name); return; }
      await createBoardFolder(name);
      await updateBoardsMeta(meta => { meta[name] = { color: boardModalColor, visibility: isPrivate ? 'private' : 'shared', owner: isPrivate ? me.email : null }; return meta; });
      await refreshBoardsList();
      closeBoardModal();
      $('setup-screen').style.display = 'none';
      $('board').style.display = 'block';
      await switchBoard(name);
    } else {
      const oldName = boardModalOriginalName;
      const isSpecial = oldName === IMPORTANT_BOARD_NAME;
      const finalName = isSpecial ? oldName : name;
      if(finalName !== oldName){
        if(boardsList.some(b => b.folderName === finalName)){ alert('Ein Board mit diesem Namen existiert bereits.'); return; }
        const b = boardsList.find(x => x.folderName === oldName);
        await graphFetch(`/drives/${b.driveId}/items/${b.itemId}`, {
          method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: finalName })
        });
        const cached = localGet(cacheStorageKey(oldName));
        if(cached){ localSet(cacheStorageKey(finalName), cached); localRemove(cacheStorageKey(oldName)); }
        if(boardCache[oldName]){ boardCache[finalName] = boardCache[oldName]; delete boardCache[oldName]; }
      }
      await updateBoardsMeta(meta => {
        const prev = meta[oldName] || {};
        if(finalName !== oldName){ delete meta[oldName]; meta._order = (meta._order || []).map(n => n === oldName ? finalName : n); }
        meta[finalName] = { ...prev, color: boardModalColor, visibility: isPrivate ? 'private' : 'shared', owner: isPrivate ? (prev.owner || me.email) : null };
        return meta;
      });
      await refreshBoardsList();
      if(boardRef.folderName === oldName){
        boardRef = boardsList.find(x => x.folderName === finalName) || boardRef;
        localSet('active_board_name', finalName);
        applyBoardColor();
      }
      renderBoardTabs();
      closeBoardModal();
    }
  }catch(e){ showError('Speichern fehlgeschlagen', e); }
  finally{ btn.disabled = false; }
}
async function deleteBoard(){
  const name = boardModalOriginalName;
  if(name === IMPORTANT_BOARD_NAME) return;
  const b = boardsList.find(x => x.folderName === name);
  if(!b) return;
  if(!confirm(`Board "${name}" WIRKLICH löschen? Der Ordner samt Inhalt wird in OneDrive gelöscht (landet im Papierkorb, ca. 30 Tage wiederherstellbar).`)) return;
  try{
    const state = boardCache[name] || loadPersistedBoardCache(name) || (boardRef.folderName === name ? { notesById } : null);
    await graphFetchRaw(`/drives/${b.driveId}/items/${b.itemId}`, { method:'DELETE' });
    await updateBoardsMeta(meta => { delete meta[name]; meta._order = (meta._order || []).filter(n => n !== name); return meta; });
    if(state) await removeImportantIds(Object.keys(state.notesById || {})).catch(() => {});
    localRemove(cacheStorageKey(name)); delete boardCache[name];
    closeBoardModal();
    await refreshBoardsList();
    if(boardsList.length){ boardRef = { folderName:null }; await switchBoard(boardsList[0].folderName); }
    else showNoBoardsScreen();
  }catch(e){ showError('Löschen fehlgeschlagen', e); }
}

// ---------- Verlauf / Wiederherstellen ----------
function backupLabel(name){
  if(/^\d{4}-\d{2}-\d{2}$/.test(name)) return dayHeaderLabel(name) + '.' + name.slice(0, 4);
  if(name.startsWith(SAFETY_BACKUP_PREFIX)){
    const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(name);
    return m ? `Stand vor Wiederherstellung (${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]} UTC)` : name;
  }
  return name;
}
async function openBackupHistory(){
  const b = boardsList.find(x => x.folderName === boardModalOriginalName);
  if(!b) return;
  if(!isOnline){ showStatus('Offline – Verlauf nur online verfügbar'); return; }
  try{
    showStatus('Lade Verlauf…');
    const days = await listBackups(b);
    if(!days.length){ alert('Noch keine Sicherung vorhanden. Die erste entsteht automatisch beim nächsten Öffnen dieses Boards an einem neuen Tag.'); return; }
    const day = await choose(`Verlauf "${b.folderName}"`, 'Welcher Stand soll wiederhergestellt werden?',
      days.map(d => ({ value: d, label: backupLabel(d.name) })));
    if(!day) return;
    const ok = await choose('Wiederherstellen?',
      `Die Karten von "${b.folderName}" werden auf den Stand "${backupLabel(day.name)}" zurückgesetzt.\n\nDer aktuelle Stand wird vorher automatisch gesichert und erscheint danach ebenfalls im Verlauf. Bilder und Dateien bleiben unverändert.`,
      [{ value:true, label:'Wiederherstellen', primary:true }]);
    if(!ok) return;
    showStatus('Stelle wieder her…', 10000);
    await restoreFromBackup(b, day.id);
    closeBoardModal();
    showStatus('Board wurde wiederhergestellt', 3000);
    delete boardCache[b.folderName];
    if(boardRef.folderName === b.folderName) await reloadCurrentBoard();
  }catch(e){ showError('Wiederherstellen fehlgeschlagen', e); }
}

// ---------- Archiv ----------
let archiveItems = [];
async function openArchiveModal(){
  const el = $('archive-list');
  el.innerHTML = '<div class="empty-hint"><span class="spinner"></span>Lädt…</div>';
  $('archive-modal').style.display = 'flex';
  const b = boardsList.find(x => x.folderName === boardModalOriginalName);
  if(!b) return;
  try{
    archiveItems = await listArchivedNotes(b);
    if(!archiveItems.length){ el.innerHTML = '<div class="empty-hint">Archiv ist leer.</div>'; return; }
    el.innerHTML = archiveItems.map(n => `
      <div class="manage-board-row">
        <span class="name">${escapeHtml(notePreviewText(n))}</span>
        <button data-action="unarchive" data-id="${escapeAttr(n.fileId)}" title="Zurückholen">↩</button>
        <button data-action="delete-archived" data-id="${escapeAttr(n.fileId)}" title="Endgültig löschen">🗑</button>
      </div>`).join('');
  }catch(e){
    el.innerHTML = `<div class="empty-hint">${isNetworkError(e) ? 'Offline – Archiv nur online verfügbar.' : 'Archiv konnte nicht geladen werden.'}</div>`;
  }
}
function notePreviewText(n){
  if(n.type === 'divider') return '➖ ' + (n.text || 'Trennlinie');
  if(n.text) return n.text.slice(0, 60);
  if(n.url) return n.url;
  if(n.items && n.items.length) return '☑️ ' + n.items.length + ' Punkte';
  if(n.imageAttachmentName) return '🖼️ ' + n.imageAttachmentName;
  if(n.fileAttachmentName) return '📎 ' + n.fileAttachmentName;
  if(n.audioAttachmentName) return '🎤 Audioaufnahme';
  if(n.appointmentDate) return '📅 ' + n.appointmentDate;
  return '(leer)';
}
async function archiveNote(fileId){
  const n = notesById[fileId];
  if(!n) return;
  if(!isOnline){ showStatus('Offline – Archivieren nur online möglich'); return; }
  const originId = n.originItemId || boardRef.itemId;
  try{
    const board = boardsList.find(b => b.itemId === originId) || boardRef;
    const folder = await ensureSubfolder(board.driveId, originId, ARCHIVE_FOLDER);
    await moveItem(fileId, folder.id);
    removeNoteFromBoardState(originId, fileId);
    if(isImportantBoard()) delete notesById[fileId];
    renderBoard();
    await setImportant(fileId, false);
    showStatus('Notiz archiviert');
  }catch(e){ showError('Archivieren fehlgeschlagen', e); }
}
async function unarchiveNote(fileId){
  const b = boardsList.find(x => x.folderName === boardModalOriginalName);
  if(!b) return;
  try{
    await moveItem(fileId, b.itemId);
    removedIdsFor(b.itemId).delete(fileId);
    showStatus('Notiz wiederhergestellt');
    openArchiveModal();
    if(boardRef.folderName === b.folderName) await reloadCurrentBoard();
  }catch(e){ showError('Zurückholen fehlgeschlagen', e); }
}
async function deleteArchivedNote(fileId){
  const b = boardsList.find(x => x.folderName === boardModalOriginalName);
  const n = archiveItems.find(x => x.fileId === fileId);
  if(!b || !confirm('Diese archivierte Notiz endgültig löschen (inkl. Bilder/Dateien)?')) return;
  try{
    await deleteNoteCompletely(fileId, n, b.itemId);
    showStatus('Endgültig gelöscht');
    openArchiveModal();
  }catch(e){ showError('Löschen fehlgeschlagen', e); }
}
function closeArchiveModal(){ $('archive-modal').style.display = 'none'; }

// ---------- Board wechseln / laden ----------
let pollTimer = null;
let pollBusy = false;
let pollTick = 0;
function showBoardLoading(){ $('board-grid').innerHTML = `<div class="empty-hint"><span class="spinner"></span>Lädt…</div>`; }
function startPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollDelta, document.hidden ? POLL_BACKGROUND_MS : POLL_ACTIVE_MS);
}
async function startBoard(){
  $('setup-screen').style.display = 'none';
  $('login-screen').style.display = 'none';
  $('board').style.display = 'block';
  const name = boardRef.folderName;
  boardRef = { folderName: null };
  await switchBoard(name);
  startPolling();
}
async function switchBoard(name){
  const ref = boardsList.find(b => b.folderName === name);
  if(!ref) return;
  if(boardRef.folderName === name && Object.keys(notesById).length) return;
  snapshotCurrentBoard();
  if(boardRef.folderName) persistBoardCache(boardRef.folderName);
  boardRef = ref;
  localSet('active_board_name', name);
  revokeImageCache();
  applyBoardColor();
  renderBoardTabs();
  updateFabVisibility();

  const mem = boardCache[name];
  const persisted = mem ? null : loadPersistedBoardCache(name);
  const state = mem || persisted;
  if(state){
    notesById = state.notesById || {}; noteOrder = state.noteOrder || [];
    deltaLink = mem ? state.deltaLink : (state.deltaLink || null); orderCTag = state.orderCTag || null;
    overlayQueuedChanges(ref);
    renderBoard();
  } else {
    notesById = {}; noteOrder = []; deltaLink = null; orderCTag = null;
    overlayQueuedChanges(ref);
    if(Object.keys(notesById).length) renderBoard(); else showBoardLoading();
  }
  // In dieser Sitzung zum ersten Mal geöffnet -> vollständig abgleichen; sonst reichen die Änderungen (Delta)
  if(isImportantBoard() || !freshlyLoadedBoards.has(name) || !deltaLink) await reloadCurrentBoard();
  else pollDelta();
  if(!isImportantBoard()) maybeRunDailyBackup(ref);
}
async function reloadCurrentBoard(){
  const board = boardRef;
  if(!board.folderName) return;
  const prev = { notesById, noteOrder, orderCTag };
  try{
    const result = isImportantBoard() ? await loadImportantFromServer(prev) : await loadBoardFromServer(board, prev);
    if(board.itemId !== boardRef.itemId) return; // inzwischen gewechselt
    Object.keys(pendingDeletes).forEach(id => delete result.notesById[id]);
    notesById = result.notesById; noteOrder = result.noteOrder; deltaLink = result.deltaLink; orderCTag = result.orderCTag;
    freshlyLoadedBoards.add(board.folderName);
    persistBoardCache(board.folderName);
    overlayQueuedChanges(board);
    renderBoard();
    setOnline(true);
  }catch(err){
    if(err && err.message === 'redirecting_for_reauth') return;
    console.warn('Laden fehlgeschlagen', err);
    if(isNetworkError(err)) setOnline(false);
    if(board.itemId !== boardRef.itemId) return;
    if(!Object.keys(notesById).length){
      $('board-grid').innerHTML = `<div class="error-box">${isNetworkError(err) ? 'Keine Internetverbindung und noch kein gespeicherter Stand für dieses Board vorhanden.' : 'Board konnte nicht geladen werden: ' + escapeHtml(err.message)}</div>`;
    } else if(!isNetworkError(err)) showStatus('Aktualisieren fehlgeschlagen');
  }
}
async function pollDelta(){
  if(!boardRef.folderName || (drag && drag.active) || pollBusy || !navigator.onLine) return;
  if(isOnline === false && navigator.onLine){ setOnline(true); return; }
  if(isImportantBoard()){
    // "Wichtig" ca. jede Minute neu abgleichen
    if(++pollTick % 4 === 0 && !document.hidden){ pollBusy = true; try{ await reloadCurrentBoard(); } finally{ pollBusy = false; } }
    return;
  }
  if(!deltaLink) return reloadCurrentBoard();
  const board = boardRef;
  pollBusy = true;
  try{
    let res = await graphFetch(deltaLink);
    let items = res.value || [];
    let link = res['@odata.deltaLink'] || deltaLink;
    while(res['@odata.nextLink']){ res = await graphFetch(res['@odata.nextLink']); items = items.concat(res.value || []); link = res['@odata.deltaLink'] || link; }
    if(board.itemId !== boardRef.itemId) return;
    const changed = items.length ? await applyDeltaItems(board, items) : false;
    deltaLink = link;
    if(changed){ renderBoard(); }
    persistBoardCache(board.folderName);
    if(!isOnline) setOnline(true);
  }catch(err){
    if(isNetworkError(err)) setOnline(false);
    else if(err && err.message === 'redirecting_for_reauth') return;
    else { console.warn('Delta-Abfrage fehlgeschlagen', err); deltaLink = null; reloadCurrentBoard(); }
  }finally{ pollBusy = false; }
}
document.addEventListener('visibilitychange', () => {
  if(document.hidden) flushPendingDeletes();
  if(!boardRef.folderName) return;
  startPolling();
  if(!document.hidden){ pollDelta(); checkForUpdate(); syncQueue(); }
});
window.addEventListener('pagehide', flushPendingDeletes);

// ---------- Darstellung ----------
function renderBoard(){
  if(searchState.query || searchState.all){ renderSearch(); return; }
  if(isImportantBoard()){ renderImportantBoardGrid(); return; }
  const grid = $('board-grid');
  const notes = orderedNotes();
  if(!notes.length){
    grid.innerHTML = `<div class="empty-hint">Noch keine Notizen. Tippe unten rechts auf "+" um die erste anzuheften.</div>`;
    return;
  }
  grid.innerHTML = notes.map(n => renderNote(n)).join('');
  observeImages();
}
function renderNote(n, opts = {}){
  if(!opts.static && drag && drag.active && drag.id === n.fileId){
    return `<div class="note drag-placeholder" data-id="${escapeAttr(n.fileId)}" style="width:${drag.width}px;height:${drag.height}px;"></div>`;
  }
  const id = escapeAttr(n.fileId);
  const origin = escapeAttr(n.originItemId || boardRef.itemId);
  if(n.type === 'divider'){
    return `<div class="note divider-note${n.pending ? ' pending' : ''}" data-id="${id}">
      <div class="divider-row">
        ${n.text ? `<span class="divider-label">${escapeHtml(n.text)}</span>` : ''}
        <span class="divider-line"></span>
        <span class="divider-actions">
          <button data-action="edit-note" data-id="${id}" title="Bearbeiten">✎</button>
          <button data-action="delete-note" data-id="${id}" title="Löschen">🗑</button>
        </span>
      </div>
    </div>`;
  }
  const parts = [];
  if(n.text) parts.push(`<div class="note-text">${escapeHtml(n.text)}</div>`);
  if(n.url){
    const href = safeUrl(n.url);
    parts.push(href
      ? `<div class="note-text"><a class="note-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.url)}</a></div>`
      : `<div class="note-text">${escapeHtml(n.url)}</div>`);
  }
  if(n.imageAttachmentPath){
    const cached = imageCache[n.imageAttachmentPath];
    const alt = escapeAttr(n.imageAttachmentName || 'Bild');
    const path = escapeAttr(n.imageAttachmentPath);
    parts.push(cached
      ? `<img alt="${alt}" src="${cached}" draggable="false" data-action="zoom" data-path="${path}" data-origin="${origin}">`
      : `<img loading="lazy" alt="${alt}" draggable="false" data-lazy="${path}" data-origin="${origin}" data-action="zoom" data-path="${path}">`);
  }
  if(n.fileAttachmentPath){
    parts.push(`<div class="note-text">📎 ${escapeHtml(n.fileAttachmentName || 'Datei')}
      <br><button type="button" class="note-file-link" data-action="download" data-path="${escapeAttr(n.fileAttachmentPath)}" data-name="${escapeAttr(n.fileAttachmentName || 'datei')}" data-origin="${origin}">Herunterladen</button></div>`);
  }
  if(n.audioAttachmentPath){
    const cachedAudio = imageCache[n.audioAttachmentPath];
    parts.push(cachedAudio
      ? `<audio controls src="${cachedAudio}"></audio>`
      : `<button type="button" class="note-file-link" data-action="play-audio" data-path="${escapeAttr(n.audioAttachmentPath)}" data-origin="${origin}">🎤 Audio abspielen</button>`);
  }
  if(n.appointmentDate && /^\d{4}-\d{2}-\d{2}$/.test(n.appointmentDate)){
    const isPast = n.appointmentDate < isoDateLocal(new Date());
    const [ay, am, ad] = n.appointmentDate.split('-');
    parts.push(`<div class="note-text" style="color:${isPast ? '#ff8080' : '#7be07b'}; font-weight:600;">📅 ${ad}.${am}.${ay}</div>`);
  }
  if(n.items && n.items.length){
    parts.push(n.items.map(it => `
      <label class="checklist-item ${it.done ? 'done' : ''}">
        <input type="checkbox" ${it.done ? 'checked' : ''} data-action="toggle-item" data-id="${id}" data-item="${escapeAttr(it.id)}">
        <span class="checklist-text">${escapeHtml(it.text)}</span>
      </label>`).join(''));
  }
  const lastEditorEmail = n.editedByEmail || n.authorEmail;
  if(lastEditorEmail && me.email && lastEditorEmail !== me.email){
    const who = n.editedBy || n.author || lastEditorEmail;
    const when = formatShortDate(n.editedAt || n.timestamp);
    parts.push(`<div class="note-meta">${n.editedAt ? '✎ ' : ''}${escapeHtml(who)}${when ? ' · ' + when : ''}</div>`);
  }
  let cardStyle = '';
  if(isImportantBoard() || opts.boardColor){
    const originBoard = boardsList.find(b => b.itemId === n.originItemId);
    const bg = opts.boardColor || (originBoard ? originBoard.color : '#333333');
    cardStyle = ` style="background:${escapeAttr(bg)}; color:${contrastColor(bg)};"`;
  }
  return `<div class="note${n.pending ? ' pending' : ''}" data-id="${id}"${cardStyle}>
    ${n.important ? '<span class="important-badge" title="Auch in \'Wichtig\'">⭐</span>' : ''}
    <div class="note-actions"><button data-action="note-menu" data-id="${id}" title="Menü">⋮</button></div>
    ${parts.join('')}
    ${n.pending ? '<span class="pending-badge" title="Wird übertragen, sobald du online bist">⏳</span>' : ''}
  </div>`;
}

// ---------- "Wichtig": 7-Tage-Ansicht ----------
function importantDayKeys(){
  const today = new Date(); today.setHours(0,0,0,0);
  const keys = [];
  for(let i = 0; i < 7; i++){ const d = new Date(today); d.setDate(d.getDate() + i); keys.push(isoDateLocal(d)); }
  return keys;
}
function dayHeaderLabel(iso){
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString('de-CH', { weekday:'long' });
  const datePart = date.toLocaleDateString('de-CH', { day:'2-digit', month:'2-digit' });
  return `${weekday}, ${datePart}`;
}
function bucketKeyFor(dueDate, days){
  if(!dueDate || dueDate < days[0]) return 'neutral'; // vergangene Tage rutschen automatisch ins Allgemeine
  return days.includes(dueDate) ? dueDate : 'neutral';
}
function renderImportantBoardGrid(){
  const grid = $('board-grid');
  const all = Object.values(notesById);
  if(!all.length){
    grid.innerHTML = `<div class="empty-hint">Noch keine Karte als "Wichtig" markiert. Markiere Karten in ihren Boards über "Bearbeiten" → ⭐.</div>`;
    return;
  }
  const days = importantDayKeys();
  const byId = {}; all.forEach(n => byId[n.fileId] = n);
  const orderedIds = noteOrder.filter(id => byId[id]);
  all.forEach(n => { if(!orderedIds.includes(n.fileId)) orderedIds.push(n.fileId); });
  const buckets = { neutral: [] };
  days.forEach(d => buckets[d] = []);
  orderedIds.forEach(id => buckets[bucketKeyFor(byId[id].dueDate, days)].push(byId[id]));
  let html = renderDayHeader('neutral', 'Allgemein') + buckets.neutral.map(n => renderNote(n)).join('');
  days.forEach(d => { html += renderDayHeader(d, dayHeaderLabel(d)) + buckets[d].map(n => renderNote(n)).join(''); });
  grid.innerHTML = html;
  observeImages();
}
function renderDayHeader(key, label){ return `<div class="day-header" data-day-header="${escapeAttr(key)}">${escapeHtml(label)}</div>`; }

// ---------- Suche ----------
const searchState = { open:false, query:'', all:false, loading:false };
function noteSearchText(n){
  return [n.text, n.url, n.imageAttachmentName, n.fileAttachmentName, n.appointmentDate, ...(n.items || []).map(i => i.text)]
    .filter(Boolean).join(' ').toLowerCase();
}
function noteMatches(n, words){ const t = noteSearchText(n); return words.every(w => t.includes(w)); }
function searchWords(){ return searchState.query.toLowerCase().split(/\s+/).filter(Boolean); }
function toggleSearch(){
  searchState.open = !searchState.open;
  $('search-bar').classList.toggle('open', searchState.open);
  $('search-btn').classList.toggle('active', searchState.open);
  if(searchState.open) setTimeout(() => $('search-input').focus(), 30);
  else { searchState.query = ''; searchState.all = false; $('search-input').value = ''; $('search-all').checked = false; updateFabVisibility(); renderBoard(); }
}
function onSearchInput(){
  searchState.query = $('search-input').value.trim();
  searchState.all = $('search-all').checked;
  updateFabVisibility();
  if(searchState.all) ensureAllBoardsLoaded();
  renderBoard();
}
function boardStateFor(board){
  if(board.folderName === boardRef.folderName) return { notesById, noteOrder };
  return boardCache[board.folderName] || loadPersistedBoardCache(board.folderName);
}
async function ensureAllBoardsLoaded(){
  if(searchState.loading) return;
  const missing = boardsList.filter(b => b.folderName !== IMPORTANT_BOARD_NAME && !boardStateFor(b));
  if(!missing.length || !isOnline) return;
  searchState.loading = true; renderBoard();
  try{
    for(const b of missing){
      const s = await loadBoardFromServer(b, null);
      boardCache[b.folderName] = s; persistBoardCache(b.folderName, s);
      if(searchState.all) renderBoard();
    }
  }catch(e){ console.warn('Boards für Suche nicht geladen', e); }
  finally{ searchState.loading = false; renderBoard(); }
}
function renderSearch(){
  const grid = $('board-grid');
  const words = searchWords();
  if(!searchState.all){
    if(isImportantBoard() && !words.length){ renderImportantBoardGrid(); return; }
    const notes = (isImportantBoard() ? Object.values(notesById) : orderedNotes()).filter(n => n.type !== 'divider' && noteMatches(n, words));
    grid.innerHTML = notes.length ? notes.map(n => renderNote(n, { static:true })).join('') : `<div class="empty-hint">Keine Treffer in "${escapeHtml(boardRef.folderName)}".</div>`;
    observeImages();
    return;
  }
  if(!words.length){ grid.innerHTML = `<div class="empty-hint">Suchbegriff eingeben – gesucht wird in allen Boards.</div>`; return; }
  const results = [];
  const notLoaded = [];
  for(const b of boardsList){
    if(b.folderName === IMPORTANT_BOARD_NAME) continue;
    const s = boardStateFor(b);
    if(!s){ notLoaded.push(b.folderName); continue; }
    Object.values(s.notesById || {}).forEach(n => { if(n.type !== 'divider' && noteMatches(n, words)) results.push({ b, n }); });
  }
  results.sort((x, y) => (y.n.editedAt || y.n.timestamp || '').localeCompare(x.n.editedAt || x.n.timestamp || ''));
  let html = '<div class="search-results">';
  if(searchState.loading) html += `<div class="empty-hint" style="padding:10px;"><span class="spinner"></span>Lade weitere Boards…</div>`;
  html += results.slice(0, 200).map(({ b, n }) => `
    <button class="search-result" data-action="open-result" data-board="${escapeAttr(b.folderName)}" data-id="${escapeAttr(n.fileId)}">
      <span class="swatch" style="background:${escapeAttr(b.color)};"></span>
      <span><span class="board-name">${escapeHtml(b.folderName)}</span>${escapeHtml(notePreviewText(n))}</span>
    </button>`).join('');
  if(!results.length && !searchState.loading) html += `<div class="empty-hint">Keine Treffer.</div>`;
  if(notLoaded.length && !searchState.loading) html += `<div class="hint" style="color:#000;opacity:0.7;">Nicht durchsucht (offline, noch nie geöffnet): ${escapeHtml(notLoaded.join(', '))}</div>`;
  html += '</div>';
  grid.innerHTML = html;
}
async function openSearchResult(boardName, fileId){
  searchState.open = true; toggleSearch(); // schliesst die Suche
  await switchBoard(boardName);
  const el = document.querySelector(`.note[data-id="${CSS.escape(fileId)}"]`);
  if(el){ el.scrollIntoView({ block:'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}

// ---------- Kontextmenü ----------
let lastMenuAnchorRect = null;
function closeContextMenu(){ document.querySelectorAll('.context-menu, .context-menu-backdrop').forEach(el => el.remove()); }
function showMenu(rect, buttonsHtml){
  closeContextMenu();
  const backdrop = document.createElement('div');
  backdrop.className = 'context-menu-backdrop';
  backdrop.dataset.action = 'close-menu';
  document.body.appendChild(backdrop);
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = buttonsHtml;
  document.body.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width, top = rect.bottom + 4;
  if(left < 8) left = 8;
  if(top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
}
function openNoteContextMenu(btn, fileId){
  const n = notesById[fileId];
  if(!n) return;
  lastMenuAnchorRect = btn.getBoundingClientRect();
  const id = escapeAttr(fileId);
  if(n.pending && isTempId(fileId)){
    showMenu(lastMenuAnchorRect, `
      <button data-action="edit-note" data-id="${id}">✎ Bearbeiten</button>
      <button class="danger" data-action="delete-note" data-id="${id}">🗑 Löschen</button>`);
    return;
  }
  showMenu(lastMenuAnchorRect, `
    <button data-action="edit-note" data-id="${id}">✎ Bearbeiten</button>
    ${n.type !== 'divider' ? `<button data-action="toggle-important" data-id="${id}">${n.important ? '☆ Nicht mehr wichtig' : '⭐ Wichtig'}</button>` : ''}
    ${n.type !== 'divider' && !isImportantBoard() ? `<button data-action="move-menu" data-id="${id}">➡️ Verschieben</button>` : ''}
    ${n.type !== 'divider' ? `<button data-action="archive-note" data-id="${id}">🗄 Archivieren</button>` : ''}
    <button class="danger" data-action="delete-note" data-id="${id}">🗑 Löschen</button>`);
}
function openMoveNoteMenu(fileId){
  const n = notesById[fileId];
  if(!n) return;
  const originId = n.originItemId || boardRef.itemId;
  const targets = boardsList.filter(b => b.folderName !== IMPORTANT_BOARD_NAME && b.itemId !== originId);
  if(!targets.length){ closeContextMenu(); showStatus('Kein anderes Board vorhanden'); return; }
  showMenu(lastMenuAnchorRect || { right: window.innerWidth / 2, bottom: 100, top: 80 },
    targets.map(b => `<button data-action="move-note" data-id="${escapeAttr(fileId)}" data-board="${escapeAttr(b.folderName)}">${escapeHtml(b.folderName)}</button>`).join(''));
}
async function moveNoteToBoard(fileId, targetFolderName){
  const n = notesById[fileId];
  const target = boardsList.find(b => b.folderName === targetFolderName);
  if(!n || !target) return;
  if(!isOnline){ showStatus('Offline – Verschieben nur online möglich'); return; }
  const originId = n.originItemId || boardRef.itemId;
  showStatus('Verschiebe…');
  try{
    await moveItem(fileId, target.itemId);
    const attachFolder = await ensureSubfolder(target.driveId, target.itemId, ATTACH_SUBFOLDER);
    for(const path of noteAttachmentPaths(n)){
      try{
        await graphFetch(`/drives/${containerRef.driveId}/items/${originId}:/${ATTACH_SUBFOLDER}/${encodeURIComponent(path)}`, {
          method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ parentReference:{ id: attachFolder.id } })
        });
      }catch(e){ console.warn('Anhang konnte nicht mitverschoben werden', path, e); }
    }
    const res = await updateNoteFile(fileId, d => { if(d.originItemId === target.itemId) return undefined; d.originItemId = target.itemId; return d; });
    if(isImportantBoard()){
      notesById[fileId] = { ...notesById[fileId], originItemId: target.itemId, eTag: res.item ? res.item.eTag : n.eTag, cTag: res.item ? res.item.cTag : n.cTag };
    } else {
      removeNoteFromBoardState(originId, fileId);
    }
    delete boardCache[target.folderName]; // Ziel-Board beim nächsten Öffnen frisch laden
    freshlyLoadedBoards.delete(target.folderName);
    renderBoard();
    showStatus(`In "${targetFolderName}" verschoben`);
  }catch(e){ showError('Verschieben fehlgeschlagen', e); }
}
async function toggleImportantFlag(fileId){
  const n = notesById[fileId];
  if(!n) return;
  const value = !n.important;
  if(!isOnline){ showStatus('Offline – nur online möglich'); return; }
  n.important = value; renderBoard();
  try{
    const res = await updateNoteFile(fileId, d => { if(!!d.important === value) return undefined; d.important = value; return d; }, { ...n, important: !value });
    if(res.item){ n.eTag = res.item.eTag; n.cTag = res.item.cTag; }
    await setImportant(fileId, value);
    if(isImportantBoard() && !value) delete notesById[fileId];
    persistBoardCache(boardRef.folderName);
    renderBoard();
    showStatus(value ? 'In "Wichtig" aufgenommen' : 'Aus "Wichtig" entfernt');
  }catch(e){ n.important = !value; renderBoard(); showError('Konnte nicht gespeichert werden', e); }
}

// ---------- Checklisten ----------
async function toggleChecklistItem(fileId, itemId){
  const n = notesById[fileId];
  if(!n || !n.items) return;
  const it = n.items.find(x => x.id === itemId);
  if(!it) return;
  const done = !it.done;
  const before = { ...n, items: n.items.map(x => ({ ...x })) };
  it.done = done;
  renderBoard();
  if(isTempId(fileId)){
    const op = OfflineQueue.findCreate(fileId);
    if(op){ const qi = (op.note.items || []).find(x => x.id === itemId); if(qi) qi.done = done; await OfflineQueue.put(op); }
    return;
  }
  const queueToggle = async () => {
    await OfflineQueue.add({ kind:'toggle', boardItemId: n.originItemId || boardRef.itemId, fileId, itemId, done });
    n.pending = true; persistBoardCache(boardRef.folderName); renderBoard();
  };
  if(!isOnline) return queueToggle();
  try{
    const res = await updateNoteFile(fileId, data => {
      const x = (data.items || []).find(i => i.id === itemId);
      if(!x || x.done === done) return undefined;
      x.done = done; return data;
    }, before);
    const cur = notesById[fileId];
    if(cur){
      notesById[fileId] = { ...normalizeNote(res.data), fileId, originItemId: cur.originItemId, dueDate: cur.dueDate,
        eTag: res.item ? res.item.eTag : cur.eTag, cTag: res.item ? res.item.cTag : cur.cTag };
    }
    persistBoardCache(boardRef.folderName);
    renderBoard();
  }catch(err){
    if(isNetworkError(err)){ setOnline(false); return queueToggle(); }
    it.done = !done;
    renderBoard();
    showStatus('Konnte nicht gespeichert werden');
  }
}

// ---------- Bilder, Dateien, Audio ----------
function attachmentUrl(origin, path){ return `/drives/${containerRef.driveId}/items/${origin}:/${ATTACH_SUBFOLDER}/${encodeURIComponent(path)}`; }
const imgObserver = new IntersectionObserver(async entries => {
  for(const entry of entries){
    if(!entry.isIntersecting) continue;
    const img = entry.target;
    imgObserver.unobserve(img);
    const path = img.dataset.lazy; const origin = img.dataset.origin || boardRef.itemId;
    if(!path || img.getAttribute('src')) continue;
    if(imageCache[path]){ img.src = imageCache[path]; continue; }
    try{
      const res = await graphFetchRaw(`${attachmentUrl(origin, path)}:/thumbnails/0/medium/content`);
      const url = URL.createObjectURL(await res.blob());
      imageCache[path] = url; img.src = url;
    }catch(e){
      try{
        const res = await graphFetchRaw(`${attachmentUrl(origin, path)}:/content`);
        const url = URL.createObjectURL(await res.blob());
        imageCache[path] = url; img.src = url;
      }catch(e2){ img.alt = '🖼️ Bild nicht verfügbar'; console.warn('Bild konnte nicht geladen werden', e2); }
    }
  }
}, { rootMargin: '200px' });
function observeImages(){ document.querySelectorAll('.note img[data-lazy]:not([src])').forEach(img => imgObserver.observe(img)); }
async function showFullImage(path, origin){
  const box = $('lightbox');
  const img = $('lightbox-img');
  img.removeAttribute('src');
  box.style.display = 'flex';
  $('lightbox-status').textContent = 'Lädt…';
  try{
    let url;
    if(imageCache['full:' + path]) url = imageCache['full:' + path];
    else if(Object.values(OfflineQueue.items).some(op => (op.attachments || []).some(a => a.path === path))) url = imageCache[path];
    else{
      const res = await graphFetchRaw(`${attachmentUrl(origin, path)}:/content`);
      url = URL.createObjectURL(await res.blob());
      imageCache['full:' + path] = url;
    }
    img.src = url;
    $('lightbox-status').textContent = '';
  }catch(e){ $('lightbox-status').textContent = 'Bild konnte nicht geladen werden'; }
}
function closeLightbox(){ $('lightbox').style.display = 'none'; }
async function downloadAttachment(path, filename, origin){
  try{
    const res = await graphFetchRaw(`${attachmentUrl(origin || boardRef.itemId, path)}:/content`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }catch(e){ showStatus(isNetworkError(e) ? 'Offline – Download nicht möglich' : 'Download fehlgeschlagen'); }
}
async function loadAudioAttachment(btn, path, origin){
  btn.textContent = 'Lädt…'; btn.disabled = true;
  try{
    let url = imageCache[path];
    if(!url){
      const res = await graphFetchRaw(`${attachmentUrl(origin, path)}:/content`);
      url = URL.createObjectURL(await res.blob());
      imageCache[path] = url;
    }
    const audio = document.createElement('audio');
    audio.controls = true; audio.src = url; audio.style.width = '100%';
    btn.replaceWith(audio);
    audio.play().catch(() => {});
  }catch(e){ btn.textContent = '🎤 Fehler – erneut versuchen'; btn.disabled = false; }
}

// ---------- Löschen mit "Rückgängig" ----------
let pendingDeletes = {};
function showUndoToast(msg, onUndo){
  const existing = $('undo-toast'); if(existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'undo-toast';
  el.className = 'undo-toast';
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button>Rückgängig</button>`;
  el.querySelector('button').onclick = () => { onUndo(); el.remove(); };
  document.body.appendChild(el);
  setTimeout(() => { if(el.parentNode) el.remove(); }, UNDO_MS);
}
function deleteNoteWithUndo(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n) return;
  if(isTempId(fileId)){
    const op = OfflineQueue.findCreate(fileId);
    if(op) OfflineQueue.remove(op);
    delete notesById[fileId];
    noteOrder = noteOrder.filter(id => id !== fileId);
    renderBoard();
    showStatus('Offline-Entwurf verworfen');
    return;
  }
  const boardItemId = n.originItemId || boardRef.itemId;
  const viewBoard = boardRef;
  const index = noteOrder.indexOf(fileId);
  delete notesById[fileId];
  noteOrder = noteOrder.filter(id => id !== fileId);
  renderBoard();
  const timeoutId = setTimeout(() => commitDelete(fileId), UNDO_MS);
  pendingDeletes[fileId] = { timeoutId, note: n, boardItemId };
  showUndoToast('Notiz gelöscht', () => {
    const pending = pendingDeletes[fileId];
    if(!pending) return;
    clearTimeout(pending.timeoutId);
    delete pendingDeletes[fileId];
    if(boardRef.itemId !== viewBoard.itemId) return;
    notesById[fileId] = n;
    if(!noteOrder.includes(fileId)) noteOrder.splice(index >= 0 ? Math.min(index, noteOrder.length) : 0, 0, fileId);
    renderBoard();
  });
}
async function commitDelete(fileId){
  const p = pendingDeletes[fileId];
  if(!p) return;
  delete pendingDeletes[fileId];
  removeNoteFromBoardState(p.boardItemId, fileId);
  try{
    if(!isOnline) throw new NetworkError();
    await deleteNoteCompletely(fileId, p.note, p.boardItemId);
  }catch(e){
    if(isNetworkError(e)){ setOnline(false); await OfflineQueue.add({ kind:'delete', boardItemId: p.boardItemId, fileId, note: noteToFile(p.note) }); }
    else console.warn('Löschen fehlgeschlagen', e);
  }
}
// Wird die App innerhalb der Rückgängig-Frist geschlossen, trotzdem löschen.
function flushPendingDeletes(){
  const ids = Object.keys(pendingDeletes);
  if(!ids.length) return;
  const t = $('undo-toast'); if(t) t.remove();
  for(const fileId of ids){
    const p = pendingDeletes[fileId];
    clearTimeout(p.timeoutId);
    delete pendingDeletes[fileId];
    removeNoteFromBoardState(p.boardItemId, fileId);
    // Sicherheitsnetz: in die Warteschlange (Anhänge + Wichtig werden beim nächsten Start aufgeräumt) ...
    OfflineQueue.add({ kind:'delete', boardItemId: p.boardItemId, fileId, note: noteToFile(p.note) }).catch(() => {});
    // ... und sofort versuchen, die Karte zu löschen – auch wenn die Seite gerade geschlossen wird
    if(lastAccessToken && navigator.onLine){
      try{ fetch(`${GRAPH}/drives/${containerRef.driveId}/items/${fileId}`, { method:'DELETE', keepalive:true, headers:{ 'Authorization':'Bearer ' + lastAccessToken } }).catch(() => {}); }catch(e){}
    }
  }
}

// ---------- Pull-to-Refresh ----------
(function initPullToRefresh(){
  let startY = null, pulling = false, dist = 0;
  const indicator = $('pull-indicator');
  const textEl = $('pull-indicator-text');
  const THRESHOLD = 70;
  document.addEventListener('touchstart', e => {
    if(window.scrollY <= 0 && $('board').style.display === 'block' && !document.querySelector('.modal-overlay[style*="flex"]')){
      startY = e.touches[0].clientY; pulling = true; dist = 0;
    }
  }, { passive:true });
  document.addEventListener('touchmove', e => {
    if(!pulling) return;
    if(drag && drag.active){ pulling = false; indicator.classList.remove('visible'); return; }
    const dy = e.touches[0].clientY - startY;
    if(dy > 0 && window.scrollY <= 0){
      dist = Math.min(dy, 100);
      indicator.style.transform = `translate(-50%, ${dist - 40}px)`;
      indicator.classList.add('visible');
      textEl.textContent = dist >= THRESHOLD ? 'Zum Aktualisieren loslassen' : 'Herunterziehen zum Aktualisieren';
    } else { pulling = false; indicator.classList.remove('visible'); }
  }, { passive:true });
  document.addEventListener('touchend', () => {
    if(!pulling) return;
    pulling = false;
    if(dist >= THRESHOLD){
      textEl.textContent = 'Aktualisiere…';
      indicator.style.transform = 'translate(-50%, 20px)';
      Promise.resolve(syncQueue()).then(() => reloadCurrentBoard()).finally(() => {
        indicator.classList.remove('visible');
        showStatus(isOnline ? 'Aktualisiert' : 'Offline – letzter bekannter Stand');
      });
    } else indicator.classList.remove('visible');
  });
})();

// ---------- Drag & Drop ----------
let drag = null;
let dragEndedAt = 0;
function onNotePointerDown(e){
  const el = e.target.closest('.note[data-id]');
  if(!el || el.classList.contains('drag-placeholder')) return;
  if(e.target.closest('button, a, input, audio, label.checklist-item')) return;
  if(searchState.query || searchState.all) return;
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  drag = { id: el.dataset.id, startX: e.clientX, startY: e.clientY, pointerType: e.pointerType, active: false };
  if(e.pointerType === 'touch') drag.longPressTimer = setTimeout(() => activateDrag(e, el), 160);
  document.addEventListener('pointermove', onPointerMove, { passive:false });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
}
function activateDrag(e, el){
  if(!drag || drag.active) return;
  drag.active = true;
  const rect = el.getBoundingClientRect();
  drag.offsetX = e.clientX - rect.left; drag.offsetY = e.clientY - rect.top;
  drag.width = rect.width; drag.height = rect.height;
  const ghost = el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: rect.width + 'px', left: rect.left + 'px', top: rect.top + 'px', margin: '0', pointerEvents: 'none' });
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  document.body.style.userSelect = 'none';
  renderBoard();
}
function onPointerMove(e){
  if(!drag) return;
  if(!drag.active){
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if(drag.pointerType === 'mouse'){
      if(Math.abs(dx) > 4 || Math.abs(dy) > 4){
        const el = document.querySelector(`.note[data-id="${CSS.escape(drag.id)}"]`);
        if(el) activateDrag(e, el);
      }
    } else if(Math.abs(dx) > 10 || Math.abs(dy) > 10){ endDrag(false); }
    return;
  }
  e.preventDefault();
  drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
  drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
  const target = document.elementFromPoint(e.clientX, e.clientY);
  const targetCard = target && target.closest('.note[data-id]');
  const targetHeader = target && target.closest('[data-day-header]');
  if(targetCard && targetCard.dataset.id !== drag.id){
    const targetId = targetCard.dataset.id;
    const ids = noteOrder.length ? noteOrder.slice() : Object.values(notesById).map(n => n.fileId);
    if(!ids.includes(drag.id)) ids.unshift(drag.id);
    if(!ids.includes(targetId)) ids.push(targetId);
    const from = ids.indexOf(drag.id), to = ids.indexOf(targetId);
    if(from !== to){
      ids.splice(from, 1); ids.splice(to, 0, drag.id);
      noteOrder = ids;
      if(isImportantBoard()){
        const draggedNote = notesById[drag.id], targetNote = notesById[targetId];
        if(draggedNote && targetNote) draggedNote.dueDate = targetNote.dueDate || null;
      }
      renderBoard();
    }
  } else if(targetHeader && isImportantBoard()){
    const dayKey = targetHeader.dataset.dayHeader;
    const draggedNote = notesById[drag.id];
    if(draggedNote){
      const newDue = dayKey === 'neutral' ? null : dayKey;
      if(draggedNote.dueDate !== newDue){
        draggedNote.dueDate = newDue;
        noteOrder = [drag.id].concat(noteOrder.filter(id => id !== drag.id));
        renderBoard();
      }
    }
  }
}
function onPointerUp(){ endDrag(true); }
function endDrag(persist){
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerUp);
  if(!drag) return;
  if(drag.longPressTimer) clearTimeout(drag.longPressTimer);
  const wasActive = drag.active;
  const draggedId = drag.id;
  if(drag.ghost) drag.ghost.remove();
  document.body.style.userSelect = '';
  drag = null;
  if(wasActive){
    dragEndedAt = Date.now();
    if(persist){
      scheduleSaveOrder();
      if(isImportantBoard() && notesById[draggedId] && isOnline){
        setImportantDueDate(draggedId, notesById[draggedId].dueDate || null).catch(e => showError('Termin nicht gespeichert', e));
      }
      persistBoardCache(boardRef.folderName);
    }
    renderBoard();
  }
}
document.addEventListener('pointerdown', onNotePointerDown);
// Langes Drücken auf Bilder soll kein Browser-Menü öffnen (stört beim Verschieben)
document.addEventListener('contextmenu', e => { if(e.target.closest('.note img')) e.preventDefault(); });

// ---------- Audioaufnahme ----------
let audioRecorder = null, audioChunks = [], audioBlob = null, audioStream = null, audioPreviewUrl = null;
function pickAudioMime(){
  if(typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}
function audioExtension(mime){ return /mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm'; }
async function startAudioRecording(){
  try{
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mime = pickAudioMime();
    audioRecorder = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
    audioRecorder.ondataavailable = e => { if(e.data.size > 0) audioChunks.push(e.data); };
    audioRecorder.onstop = () => {
      audioBlob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
      renderAudioPreview();
      audioStream.getTracks().forEach(t => t.stop());
    };
    audioRecorder.start();
    $('audio-record-btn').style.display = 'none';
    $('audio-stop-btn').style.display = 'inline-block';
    $('audio-status').textContent = '🔴 Aufnahme läuft…';
  }catch(e){ alert('Mikrofonzugriff nicht möglich: ' + e.message); }
}
function stopAudioRecording(){
  if(audioRecorder && audioRecorder.state !== 'inactive') audioRecorder.stop();
  $('audio-record-btn').style.display = 'inline-block';
  $('audio-stop-btn').style.display = 'none';
}
function renderAudioPreview(){
  const el = $('audio-preview');
  if(audioPreviewUrl){ URL.revokeObjectURL(audioPreviewUrl); audioPreviewUrl = null; }
  if(audioBlob){
    audioPreviewUrl = URL.createObjectURL(audioBlob);
    el.innerHTML = `<audio controls src="${audioPreviewUrl}" style="width:100%;"></audio> <button type="button" class="btn btn-secondary" data-action="discard-audio">✕ Verwerfen</button>`;
    $('audio-status').textContent = 'Neue Aufnahme bereit';
  } else { el.innerHTML = ''; $('audio-status').textContent = ''; }
}
function discardAudioRecording(){ audioBlob = null; renderAudioPreview(); }
function stopRecordingIfRunning(){
  if(audioRecorder && audioRecorder.state !== 'inactive'){ audioRecorder.onstop = null; audioRecorder.stop(); }
  if(audioStream) audioStream.getTracks().forEach(t => t.stop());
  $('audio-record-btn').style.display = 'inline-block';
  $('audio-stop-btn').style.display = 'none';
}

// ---------- Notiz erstellen / bearbeiten ----------
let noteMode = 'note'; // 'note' | 'divider'
let activeComponents = new Set(['text']);
let checklistItemsDraft = [];
let editingNoteId = null;

function setNoteMode(mode){
  noteMode = mode;
  document.querySelectorAll('#mode-tabs .type-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('component-toggles').style.display = mode === 'note' ? 'flex' : 'none';
  $('important-row').style.display = mode === 'note' ? 'flex' : 'none';
  $('field-divider').style.display = mode === 'divider' ? 'block' : 'none';
  document.querySelectorAll('.comp-toggle').forEach(btn => {
    const c = btn.dataset.comp;
    const isOn = activeComponents.has(c);
    btn.classList.toggle('active', isOn);
    $('field-' + c).style.display = (mode === 'note' && isOn) ? 'block' : 'none';
  });
  if(mode === 'divider') setTimeout(() => $('input-divider-text').focus(), 60);
  else if(activeComponents.has('text')) setTimeout(() => $('input-text').focus(), 60);
}
function toggleComponent(comp){
  if(activeComponents.has(comp)) activeComponents.delete(comp); else activeComponents.add(comp);
  const isOn = activeComponents.has(comp);
  document.querySelector(`.comp-toggle[data-comp="${comp}"]`).classList.toggle('active', isOn);
  $('field-' + comp).style.display = isOn ? 'block' : 'none';
  if(comp === 'checklist' && isOn && checklistItemsDraft.length === 0) addChecklistItemRow();
  if(isOn && comp === 'text') setTimeout(() => $('input-text').focus(), 30);
  if(isOn && comp === 'link') setTimeout(() => $('input-link').focus(), 30);
}
function addChecklistItemRow(prefill = ''){ checklistItemsDraft.push({ id: uuid(), text: prefill, done: false }); renderChecklistDraft(); }
function removeChecklistItemRow(id){ checklistItemsDraft = checklistItemsDraft.filter(it => it.id !== id); renderChecklistDraft(); }
function renderChecklistDraft(){
  const el = $('checklist-items-container');
  el.innerHTML = checklistItemsDraft.map(it => `
    <div class="modal-checklist-row">
      <input type="text" value="${escapeAttr(it.text)}" placeholder="Punkt..." data-draft-item="${escapeAttr(it.id)}">
      <button type="button" data-action="remove-draft-item" data-item="${escapeAttr(it.id)}" title="Entfernen">✕</button>
    </div>`).join('');
}
$('checklist-items-container').addEventListener('input', e => {
  const id = e.target.dataset.draftItem; if(!id) return;
  const it = checklistItemsDraft.find(x => x.id === id); if(it) it.text = e.target.value;
});
$('checklist-items-container').addEventListener('keydown', e => {
  const id = e.target.dataset.draftItem;
  if(!id || e.key !== 'Enter') return;
  e.preventDefault();
  const idx = checklistItemsDraft.findIndex(x => x.id === id);
  if(idx === checklistItemsDraft.length - 1) addChecklistItemRow();
  setTimeout(() => { const rows = document.querySelectorAll('#checklist-items-container input[type=text]'); if(rows[idx + 1]) rows[idx + 1].focus(); }, 20);
});
function resetNoteForm(){
  ['input-text', 'input-link', 'input-image', 'input-file', 'input-date', 'input-divider-text'].forEach(id => $(id).value = '');
  $('input-important').checked = false;
  $('audio-existing').innerHTML = '';
  audioBlob = null;
  renderAudioPreview();
  checklistItemsDraft = [];
  renderChecklistDraft();
}
function openAddModal(){
  editingNoteId = null;
  resetNoteForm();
  activeComponents = new Set(['text']);
  $('note-modal-title').textContent = 'Neue Notiz';
  $('save-note-btn').textContent = 'Anheften';
  setNoteMode('note');
  $('add-modal').style.display = 'flex';
}
function openEditNoteModal(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n) return;
  resetNoteForm();
  editingNoteId = fileId;
  $('note-modal-title').textContent = 'Notiz bearbeiten';
  $('save-note-btn').textContent = 'Speichern';
  $('input-important').checked = !!n.important;
  $('input-date').value = n.appointmentDate || '';
  if(n.type === 'divider'){
    $('input-divider-text').value = n.text || '';
    setNoteMode('divider');
  } else {
    activeComponents = new Set();
    if(n.text) activeComponents.add('text');
    if(n.url) activeComponents.add('link');
    if(n.imageAttachmentPath) activeComponents.add('image');
    if(n.fileAttachmentPath) activeComponents.add('file');
    if(n.audioAttachmentPath) activeComponents.add('audio');
    if(n.items && n.items.length) activeComponents.add('checklist');
    if(n.appointmentDate) activeComponents.add('date');
    if(!activeComponents.size) activeComponents.add('text');
    $('input-text').value = n.text || '';
    $('input-link').value = n.url || '';
    checklistItemsDraft = (n.items || []).map(it => ({ ...it }));
    renderChecklistDraft();
    setNoteMode('note');
    if(n.audioAttachmentPath){
      $('audio-existing').innerHTML = `<button type="button" class="note-file-link" style="color:#000;" data-action="play-audio" data-path="${escapeAttr(n.audioAttachmentPath)}" data-origin="${escapeAttr(n.originItemId || boardRef.itemId)}">🎤 Vorhandene Aufnahme abspielen</button>`;
    }
  }
  $('add-modal').style.display = 'flex';
}
function closeAddModal(){
  stopRecordingIfRunning();
  $('add-modal').style.display = 'none';
  resetNoteForm();
  editingNoteId = null;
  activeComponents = new Set(['text']);
  setNoteMode('note');
}

// Baut die Karte aus dem Formular. Gibt {note, attachments, removeAttachments} zurück oder wirft eine Meldung.
async function buildNoteFromForm(existing){
  const id = (existing && existing.id) || uuid();
  const now = new Date().toISOString();
  const note = {
    id, type: noteMode,
    author: existing ? existing.author : me.name,
    authorEmail: existing ? existing.authorEmail : me.email,
    timestamp: existing ? existing.timestamp : now,
    important: noteMode === 'divider' ? false : $('input-important').checked
  };
  if(existing){ note.editedBy = me.name; note.editedByEmail = me.email; note.editedAt = now; }
  const attachments = [];
  const keepPaths = new Set();
  if(noteMode === 'divider'){
    note.text = $('input-divider-text').value.trim();
  } else {
    if(activeComponents.size === 0) throw new Error('Bitte mindestens einen Baustein wählen (Text, Link, Foto, Datei, Audio, Checkliste oder Termin).');
    if(activeComponents.has('text')) note.text = $('input-text').value.trim();
    if(activeComponents.has('link')){
      const raw = $('input-link').value.trim();
      if(!raw) throw new Error('Bitte Link eingeben oder den Link-Baustein wieder abwählen.');
      const href = safeUrl(raw);
      if(!href) throw new Error('Dieser Link ist nicht erlaubt. Bitte eine Adresse mit http(s):// eingeben.');
      note.url = href;
    }
    if(activeComponents.has('image')){
      const f = $('input-image').files[0];
      if(f){
        const file = await maybeShrinkImage(f);
        note.imageAttachmentName = file.name; note.imageAttachmentPath = id + '_img_' + sanitizeFilename(file.name);
        attachments.push({ path: note.imageAttachmentPath, file });
      } else if(existing && existing.imageAttachmentPath){
        note.imageAttachmentName = existing.imageAttachmentName; note.imageAttachmentPath = existing.imageAttachmentPath;
      } else throw new Error('Bitte Bild auswählen oder den Foto-Baustein wieder abwählen.');
    }
    if(activeComponents.has('file')){
      const f = $('input-file').files[0];
      if(f){
        note.fileAttachmentName = f.name; note.fileAttachmentPath = id + '_file_' + sanitizeFilename(f.name);
        attachments.push({ path: note.fileAttachmentPath, file: f });
      } else if(existing && existing.fileAttachmentPath){
        note.fileAttachmentName = existing.fileAttachmentName; note.fileAttachmentPath = existing.fileAttachmentPath;
      } else throw new Error('Bitte Datei auswählen oder den Datei-Baustein wieder abwählen.');
    }
    if(activeComponents.has('audio')){
      if(audioRecorder && audioRecorder.state === 'recording') throw new Error('Bitte die Aufnahme zuerst stoppen.');
      if(audioBlob){
        const ext = audioExtension(audioBlob.type);
        note.audioAttachmentName = 'aufnahme.' + ext;
        note.audioAttachmentPath = id + '_audio_' + Date.now() + '.' + ext;
        attachments.push({ path: note.audioAttachmentPath, file: new File([audioBlob], note.audioAttachmentName, { type: audioBlob.type || 'audio/webm' }) });
      } else if(existing && existing.audioAttachmentPath){
        note.audioAttachmentName = existing.audioAttachmentName; note.audioAttachmentPath = existing.audioAttachmentPath;
      } else throw new Error('Bitte eine Audioaufnahme erstellen oder den Audio-Baustein wieder abwählen.');
    }
    if(activeComponents.has('checklist')){
      const items = checklistItemsDraft.map(it => ({ id: it.id, text: it.text.trim(), done: !!it.done })).filter(it => it.text);
      if(!items.length) throw new Error('Bitte mindestens einen Checklisten-Punkt hinzufügen oder den Checklisten-Baustein wieder abwählen.');
      note.items = items;
    }
    if(activeComponents.has('date')){
      note.appointmentDate = $('input-date').value;
      if(!note.appointmentDate) throw new Error('Bitte ein Termin-Datum wählen oder den Termin-Baustein wieder abwählen.');
    }
    const hasAnything = note.text || note.url || note.imageAttachmentPath || note.fileAttachmentPath || note.audioAttachmentPath || note.appointmentDate || (note.items && note.items.length);
    if(!hasAnything) throw new Error('Bitte mindestens einen Inhalt hinzufügen.');
  }
  noteAttachmentPaths(note).forEach(p => keepPaths.add(p));
  const removeAttachments = noteAttachmentPaths(existing).filter(p => !keepPaths.has(p));
  return { note, attachments, removeAttachments };
}

async function saveNote(){
  const btn = $('save-note-btn');
  const isEdit = !!editingNoteId;
  const existing = isEdit ? notesById[editingNoteId] : null;
  if(isEdit && !existing){ closeAddModal(); return; }
  btn.disabled = true; btn.textContent = 'Speichert…';
  try{
    const built = await buildNoteFromForm(existing);
    const boardItemId = existing ? (existing.originItemId || boardRef.itemId) : boardRef.itemId;
    const board = boardsList.find(b => b.itemId === boardItemId) || boardRef;
    built.note.originItemId = board.itemId;

    // Noch nicht übertragene Offline-Karte bearbeiten
    if(isEdit && isTempId(editingNoteId)){
      const op = OfflineQueue.findCreate(editingNoteId);
      if(op){
        op.note = built.note;
        const newPaths = new Set(built.attachments.map(a => a.path));
        op.attachments = (op.attachments || []).filter(a => !newPaths.has(a.path) && noteAttachmentPaths(built.note).includes(a.path)).concat(built.attachments);
        await OfflineQueue.put(op);
      }
      notesById[editingNoteId] = { ...built.note, fileId: editingNoteId, originItemId: board.itemId, pending: true };
      built.attachments.forEach(a => { imageCache[a.path] = URL.createObjectURL(a.file); });
      renderBoard(); closeAddModal(); showStatus('Offline gespeichert – wird später übertragen');
      return;
    }
    if(!isOnline){ await saveNoteOffline(built, board, existing); return; }
    try{
      await saveNoteOnline(built, board, existing);
    }catch(err){
      if(isNetworkError(err)){ setOnline(false); await saveNoteOffline(built, board, existing); return; }
      if(err.isConflict){ await resolveEditConflict(built, board, existing); return; }
      throw err;
    }
  }catch(err){
    if(err && err.message === 'redirecting_for_reauth') return;
    alert(err.message || 'Fehler beim Speichern');
  }finally{
    btn.disabled = false;
    btn.textContent = editingNoteId ? 'Speichern' : 'Anheften';
  }
}
async function saveNoteOnline(built, board, existing, { overrideETag } = {}){
  const { note, attachments, removeAttachments } = built;
  for(const a of attachments) await uploadAttachment(board.driveId, board.itemId, a.path, a.file);
  const item = existing
    ? await writeNoteFile(existing.fileId, note, overrideETag !== undefined ? overrideETag : existing.eTag)
    : await createNoteFile(board, note);
  const stored = { ...note, fileId: item.id, eTag: item.eTag, cTag: item.cTag, originItemId: board.itemId };
  if(existing && existing.dueDate !== undefined) stored.dueDate = existing.dueDate;
  attachments.forEach(a => { if(a.file.type.startsWith('image/') || a.file.type.startsWith('audio/')) imageCache[a.path] = URL.createObjectURL(a.file); });
  if(isImportantBoard()){
    if(note.important) notesById[item.id] = stored; else delete notesById[item.id];
  } else if(board.itemId === boardRef.itemId){
    notesById[item.id] = stored;
    if(!existing){ noteOrder.unshift(item.id); scheduleSaveOrder(board, noteOrder); }
  } else {
    mutateBoardState(board.itemId, s => { s.notesById[item.id] = stored; });
  }
  persistBoardCache(boardRef.folderName);
  closeAddModal();
  renderBoard();
  showStatus(existing ? 'Notiz gespeichert' : 'Notiz angeheftet');
  // Nacharbeiten (dürfen das Speichern nicht mehr scheitern lassen)
  const wasImportant = !!(existing && existing.important);
  if(wasImportant !== !!note.important) setImportant(item.id, note.important).catch(e => console.warn(e));
  for(const p of removeAttachments) deleteAttachment(board.driveId, board.itemId, p);
}
async function saveNoteOffline(built, board, existing){
  const { note, attachments, removeAttachments } = built;
  if(existing){
    await OfflineQueue.add({ kind:'update', boardItemId: board.itemId, fileId: existing.fileId, baseETag: existing.eTag || null, note, attachments, removeAttachments });
    notesById[existing.fileId] = { ...existing, ...note, pending: true };
  } else {
    const tempId = 'tmp_' + uuid();
    await OfflineQueue.add({ kind:'create', boardItemId: board.itemId, tempId, note, attachments });
    notesById[tempId] = { ...note, fileId: tempId, originItemId: board.itemId, pending: true };
    noteOrder.unshift(tempId);
  }
  attachments.forEach(a => { imageCache[a.path] = URL.createObjectURL(a.file); });
  closeAddModal();
  renderBoard();
  showStatus('Offline gespeichert – wird übertragen, sobald du online bist', 3500);
}
async function resolveEditConflict(built, board, existing){
  let latest;
  try{ latest = await fetchNoteLatest(existing.fileId); }
  catch(e){
    if(isNotFound(e)){
      const c = await choose('Karte wurde gelöscht', 'Jemand hat diese Karte inzwischen gelöscht.', [{ value:'copy', label:'Meine Version als neue Karte speichern', primary:true }]);
      if(c === 'copy') await saveAsNewCard(built, board);
      return;
    }
    throw e;
  }
  const who = latest.editedBy || latest.author || 'Jemand';
  const choice = await choose('Karte wurde inzwischen geändert',
    `${who} hat diese Karte geändert, während du sie bearbeitet hast.\n\nAktuell: "${notePreviewText(latest)}"`,
    [{ value:'mine', label:'Meine Version speichern', hint:'überschreibt die andere Änderung', primary:true },
     { value:'copy', label:'Meine Version als neue Karte', hint:'beide Versionen bleiben erhalten' },
     { value:'theirs', label:'Andere Version übernehmen', hint:'meine Änderung verwerfen' }]);
  if(choice === 'mine') await saveNoteOnline(built, board, existing, { overrideETag: latest.eTag });
  else if(choice === 'copy') await saveAsNewCard(built, board);
  else if(choice === 'theirs'){
    notesById[existing.fileId] = { ...latest, dueDate: existing.dueDate };
    built.attachments.forEach(a => deleteAttachment(board.driveId, board.itemId, a.path));
    closeAddModal(); renderBoard();
  }
}
async function saveAsNewCard(built, board){
  const id = uuid();
  const note = { ...built.note, id, timestamp: new Date().toISOString(), author: me.name, authorEmail: me.email };
  delete note.editedAt; delete note.editedBy; delete note.editedByEmail;
  // Anhänge der Original-Karte nicht teilen (sonst würde Löschen der einen Karte die andere beschädigen)
  const own = new Set(built.attachments.map(a => a.path));
  ['image', 'file', 'audio'].forEach(k => {
    if(note[k + 'AttachmentPath'] && !own.has(note[k + 'AttachmentPath'])){ delete note[k + 'AttachmentPath']; delete note[k + 'AttachmentName']; }
  });
  await saveNoteOnline({ note, attachments: built.attachments, removeAttachments: [] }, board, null);
}

// ---------- Klicks (zentral, statt onclick im HTML) ----------
const actions = {
  'login': () => login(),
  'reload': () => location.reload(),
  'apply-update': () => applyUpdate(),
  'queue-info': () => showQueueInfo(),
  'connect': () => connectContainer(),
  'switch-board': el => switchBoard(el.dataset.board),
  'edit-board': el => openEditBoardModal(el.dataset.board),
  'manage-boards': () => openManageBoardsModal(),
  'add-board': () => openAddBoardModal(),
  'move-board': el => moveBoardOrder(el.dataset.board, +el.dataset.dir),
  'pick-color': el => { boardModalColor = el.dataset.color; renderColorSwatches(); },
  'close-board-modal': () => closeBoardModal(),
  'save-board': () => saveBoardModal(),
  'delete-board': () => deleteBoard(),
  'history': () => openBackupHistory(),
  'archive': () => openArchiveModal(),
  'close-archive': () => closeArchiveModal(),
  'close-manage': () => closeManageBoardsModal(),
  'unarchive': el => unarchiveNote(el.dataset.id),
  'delete-archived': el => deleteArchivedNote(el.dataset.id),
  'note-menu': el => openNoteContextMenu(el, el.dataset.id),
  'close-menu': () => closeContextMenu(),
  'edit-note': el => openEditNoteModal(el.dataset.id),
  'delete-note': el => deleteNoteWithUndo(el.dataset.id),
  'archive-note': el => { closeContextMenu(); archiveNote(el.dataset.id); },
  'move-menu': el => openMoveNoteMenu(el.dataset.id),
  'move-note': el => { closeContextMenu(); moveNoteToBoard(el.dataset.id, el.dataset.board); },
  'toggle-important': el => { closeContextMenu(); toggleImportantFlag(el.dataset.id); },
  'toggle-item': el => toggleChecklistItem(el.dataset.id, el.dataset.item),
  'zoom': el => { if(Date.now() - dragEndedAt > 400) showFullImage(el.dataset.path, el.dataset.origin); },
  'close-lightbox': () => closeLightbox(),
  'download': el => downloadAttachment(el.dataset.path, el.dataset.name, el.dataset.origin),
  'play-audio': el => loadAudioAttachment(el, el.dataset.path, el.dataset.origin),
  'add-note': () => openAddModal(),
  'note-mode': el => setNoteMode(el.dataset.mode),
  'toggle-comp': el => toggleComponent(el.dataset.comp),
  'add-draft-item': () => addChecklistItemRow(),
  'remove-draft-item': el => removeChecklistItemRow(el.dataset.item),
  'record-audio': () => startAudioRecording(),
  'stop-audio': () => stopAudioRecording(),
  'discard-audio': () => discardAudioRecording(),
  'close-note-modal': () => closeAddModal(),
  'save-note': () => saveNote(),
  'toggle-search': () => toggleSearch(),
  'open-result': el => openSearchResult(el.dataset.board, el.dataset.id),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const fn = actions[el.dataset.action];
  if(!fn) return;
  if(el.tagName !== 'INPUT') e.preventDefault();
  fn(el, e);
});
$('search-input').addEventListener('input', onSearchInput);
$('search-all').addEventListener('change', onSearchInput);
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  if($('lightbox').style.display === 'flex') closeLightbox();
  else if(document.querySelector('.context-menu')) closeContextMenu();
});
