// ============ Ergänzungen 2026-11 ============
// Erledigt-Status, Text → Checkliste, "Wichtig" (Uhrzeit, Erledigt, Kalender), Audio → Text (Azure),
// Boards ausblenden, Aufräumen verwaister Anhänge, Einstellungen.
// Grundsatz: Es werden nur Felder ergänzt/geändert, nie bestehende Inhalte entfernt (ausser der Nutzer will es ausdrücklich).

// ---------- Karte gezielt ändern (online, mit Konfliktschutz) ----------
// mutate(data) bekommt die Kartendaten aus OneDrive und gibt die geänderten zurück (undefined = nichts zu tun).
async function patchNote(fileId, mutate){
  const n = notesById[fileId];
  if(!n) throw new Error('Karte nicht gefunden');
  if(isTempId(fileId) || n.pending) throw new Error('Diese Karte wird noch übertragen – bitte kurz warten.');
  if(!isOnline) throw new NetworkError('Offline');
  const res = await updateNoteFile(fileId, mutate, n);
  const cur = notesById[fileId] || n;
  notesById[fileId] = { ...normalizeNote(res.data), fileId, originItemId: cur.originItemId, dueDate: cur.dueDate, dueTime: cur.dueTime,
    eTag: res.item ? res.item.eTag : cur.eTag, cTag: res.item ? res.item.cTag : cur.cTag };
  persistBoardCache(boardRef.folderName);
  return notesById[fileId];
}
function reportPatchError(prefix, e){
  if(isNetworkError(e)){ showStatus('Offline – das geht nur mit Internet', 3000); return; }
  showError(prefix, e);
}

// ---------- Anzeige: lange Texte, erledigte Punkte ----------
function toggleExpand(fileId){ if(expandedNotes.has(fileId)) expandedNotes.delete(fileId); else expandedNotes.add(fileId); renderBoard(); }
function toggleDoneItems(fileId){ if(expandedDone.has(fileId)) expandedDone.delete(fileId); else expandedDone.add(fileId); renderBoard(); }

// ---------- Karte als erledigt markieren ----------
async function toggleDoneFlag(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n) return;
  const value = !n.done;
  try{
    await patchNote(fileId, d => {
      if(!!d.done === value) return undefined;
      if(value){ d.done = true; d.doneAt = new Date().toISOString(); }
      else { delete d.done; delete d.doneAt; }
      return d;
    });
    renderBoard();
    showStatus(value ? 'Als erledigt markiert' : 'Nicht mehr erledigt');
  }catch(e){ reportPatchError('Konnte nicht gespeichert werden', e); }
}

// ---------- Text → Checkliste ----------
// Jede nicht-leere Zeile wird ein Punkt. "- ", "• ", "* ", "1. ", "[ ]" und "[x]" am Zeilenanfang werden erkannt.
function textToItems(text){
  return String(text || '').split(/\r?\n/).map(line => {
    let t = line.trim();
    let done = false;
    const box = /^\[( |x|X)\]\s*/.exec(t);
    if(box){ done = box[1].toLowerCase() === 'x'; t = t.slice(box[0].length); }
    t = t.replace(/^([-•*·–]|\d+[.)])\s+/, '');
    const box2 = /^\[( |x|X)\]\s*/.exec(t);
    if(box2){ done = box2[1].toLowerCase() === 'x'; t = t.slice(box2[0].length); }
    return { id: uuid(), text: t.trim(), done };
  }).filter(it => it.text);
}
async function convertTextToChecklist(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n || !n.text || !n.text.trim()) return;
  const newItems = textToItems(n.text);
  if(!newItems.length) return;
  const before = { text: n.text, items: n.items ? n.items.map(x => ({ ...x })) : undefined };
  try{
    await patchNote(fileId, d => {
      d.items = (d.items || []).concat(newItems);
      delete d.text;
      return d;
    });
    renderBoard();
    showUndoToast(`${newItems.length} Punkt(e) erstellt`, () => {
      patchNote(fileId, d => {
        d.text = before.text;
        if(before.items) d.items = before.items; else delete d.items;
        return d;
      }).then(() => { renderBoard(); showStatus('Rückgängig gemacht'); })
        .catch(e => reportPatchError('Rückgängig fehlgeschlagen', e));
    });
  }catch(e){ reportPatchError('Umwandeln fehlgeschlagen', e); }
}

// ---------- "Wichtig": Erledigt ----------
// Markiert die Karte als erledigt und nimmt sie aus "Wichtig" (mit "Rückgängig"). Die Karte selbst bleibt in ihrem Board.
async function markImportantDone(fileId){
  const n = notesById[fileId];
  if(!n) return;
  if(!isOnline){ showStatus('Offline – das geht nur mit Internet'); return; }
  const prev = { done: !!n.done, doneAt: n.doneAt, dueDate: n.dueDate || null, dueTime: n.dueTime || null, note: n };
  try{
    await patchNote(fileId, d => {
      if(d.done && !d.important) return undefined;
      d.done = true; d.doneAt = d.doneAt || new Date().toISOString(); d.important = false;
      return d;
    });
    await setImportant(fileId, false);
    const saved = notesById[fileId];
    if(isImportantBoard()) delete notesById[fileId];
    persistBoardCache(boardRef.folderName);
    renderBoard();
    showUndoToast('Erledigt – aus "Wichtig" entfernt', async () => {
      try{
        if(isImportantBoard() && saved) notesById[fileId] = saved;
        await patchNote(fileId, d => {
          if(prev.done){ d.done = true; if(prev.doneAt) d.doneAt = prev.doneAt; } else { delete d.done; delete d.doneAt; }
          d.important = true;
          return d;
        });
        await setImportant(fileId, true);
        await setImportantDueDate(fileId, prev.dueDate, prev.dueTime);
        if(notesById[fileId]){ notesById[fileId].dueDate = prev.dueDate; notesById[fileId].dueTime = prev.dueTime; }
        persistBoardCache(boardRef.folderName);
        renderBoard();
        showStatus('Wiederhergestellt');
      }catch(e){ reportPatchError('Rückgängig fehlgeschlagen', e); if(isImportantBoard()) reloadCurrentBoard(); }
    });
  }catch(e){ reportPatchError('Konnte nicht gespeichert werden', e); }
}

// ---------- "Wichtig": Tag & Uhrzeit ----------
let dueEditId = null;
function openDueModal(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n) return;
  dueEditId = fileId;
  $('due-date-input').value = n.dueDate || '';
  $('due-time-input').value = validTime(n.dueTime) ? n.dueTime : '';
  $('due-modal-hint').textContent = notePreviewText(n);
  $('due-modal').style.display = 'flex';
}
function closeDueModal(){ $('due-modal').style.display = 'none'; dueEditId = null; }
async function saveDue(clear){
  const fileId = dueEditId;
  const n = notesById[fileId];
  if(!n){ closeDueModal(); return; }
  if(!isOnline){ showStatus('Offline – das geht nur mit Internet'); return; }
  const date = clear ? null : ($('due-date-input').value || null);
  const timeRaw = clear ? '' : $('due-time-input').value;
  const time = validTime(timeRaw) ? timeRaw : null;
  if(time && !date){ alert('Für eine Uhrzeit bitte auch einen Tag wählen.'); return; }
  try{
    await setImportantDueDate(fileId, date, time);
    n.dueDate = date; n.dueTime = time;
    persistBoardCache(boardRef.folderName);
    closeDueModal();
    renderBoard();
    showStatus('Gespeichert');
  }catch(e){ showError('Nicht gespeichert', e); }
}

// ---------- Kalender-Export (.ics) ----------
function icsEscape(s){ return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line){
  // Zeilen nach RFC 5545 auf max. 75 Bytes umbrechen
  const enc = new TextEncoder();
  if(enc.encode(line).length <= 75) return line;
  const out = []; let cur = '';
  for(const ch of line){
    if(enc.encode(cur + ch).length > (out.length ? 74 : 75)){ out.push(cur); cur = ch; }
    else cur += ch;
  }
  if(cur) out.push(cur);
  return out.join('\r\n ');
}
function icsDate(iso){ return iso.replace(/-/g, ''); }
function addDaysIso(iso, days){
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return isoDateLocal(dt);
}
function buildIcs(n){
  // Auf "Wichtig" zählt der dort geplante Tag; sonst der Termin der Karte
  let date = null, time = null;
  if(isImportantBoard() && n.dueDate){ date = n.dueDate; time = validTime(n.dueTime) ? n.dueTime : null; }
  else if(n.appointmentDate){ date = n.appointmentDate; time = validTime(n.appointmentTime) ? n.appointmentTime : null; }
  if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const firstLine = (n.text || '').split('\n').map(s => s.trim()).find(Boolean);
  const title = firstLine || notePreviewText(n);
  const descParts = [];
  if(n.text) descParts.push(n.text);
  if(n.items && n.items.length) descParts.push(n.items.map(i => (i.done ? '[x] ' : '[ ] ') + i.text).join('\n'));
  if(n.url) descParts.push(n.url);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Board//DE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${n.id || n.fileId}@familyboard`, `DTSTAMP:${stamp}`];
  if(time){
    // "Schwebende" Ortszeit: der Kalender nimmt die Zeitzone des Geräts
    const [h, mi] = time.split(':').map(Number);
    const end = new Date(2000, 0, 1, h + 1, mi);
    const endDate = end.getDate() === 2 ? addDaysIso(date, 1) : date;
    const endTime = String(end.getHours()).padStart(2, '0') + String(end.getMinutes()).padStart(2, '0');
    lines.push(`DTSTART:${icsDate(date)}T${time.replace(':', '')}00`, `DTEND:${icsDate(endDate)}T${endTime}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(date)}`, `DTEND;VALUE=DATE:${icsDate(addDaysIso(date, 1))}`);
  }
  lines.push(`SUMMARY:${icsEscape(title.slice(0, 120))}`);
  if(descParts.length) lines.push(`DESCRIPTION:${icsEscape(descParts.join('\n\n'))}`);
  if(n.url) lines.push(`URL:${n.url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
function exportIcs(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n) return;
  const ics = buildIcs(n);
  if(!ics){ showStatus('Diese Karte hat keinen Tag'); return; }
  const name = 'termin-' + (sanitizeFilename(((n.text || '').split('\n')[0] || 'karte').slice(0, 30)) || 'karte') + '.ics';
  const file = new File([ics], name, { type: 'text/calendar' });
  // Auf dem Handy: über "Teilen" direkt an die Kalender-App; sonst als Datei herunterladen
  try{
    if(navigator.canShare && navigator.canShare({ files: [file] })){
      navigator.share({ files: [file], title: name }).catch(err => { if(err && err.name !== 'AbortError') downloadBlob(file, name); });
      return;
    }
  }catch(e){}
  downloadBlob(file, name);
}
function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- Einstellungen ----------
function speechSettings(){
  return {
    key: (localGet('speech_key') || '').trim(),
    region: (localGet('speech_region') || '').trim().toLowerCase().replace(/\s+/g, ''),
    locale: (localGet('speech_locale') || SPEECH_DEFAULT_LOCALE).trim()
  };
}
function openSettings(){
  const s = speechSettings();
  $('speech-key-input').value = s.key;
  $('speech-region-input').value = s.region;
  $('speech-locale-input').value = s.locale;
  $('speech-test-status').textContent = '';
  $('orphan-status').textContent = '';
  $('settings-modal').style.display = 'flex';
}
function readSettingsForm(){
  return {
    key: $('speech-key-input').value.trim(),
    region: $('speech-region-input').value.trim().toLowerCase().replace(/\s+/g, ''),
    locale: $('speech-locale-input').value.trim() || SPEECH_DEFAULT_LOCALE
  };
}
function saveSettings(){
  const s = readSettingsForm();
  if(s.key) localSet('speech_key', s.key); else localRemove('speech_key');
  if(s.region) localSet('speech_region', s.region); else localRemove('speech_region');
  localSet('speech_locale', s.locale);
  $('settings-modal').style.display = 'none';
  updateTranscribeButton();
  showStatus('Einstellungen gespeichert');
}
function clearSpeechSettings(){
  localRemove('speech_key'); localRemove('speech_region');
  $('speech-key-input').value = ''; $('speech-region-input').value = '';
  $('speech-test-status').textContent = 'Schlüssel entfernt.';
  updateTranscribeButton();
}

// ---------- Audio → Text (Azure Speech) ----------
class SpeechError extends Error {}
function speechConfigured(){ const s = speechSettings(); return !!(s.key && s.region); }
// 1) "Fast transcription" (nimmt webm/ogg/m4a direkt). 2) Falls nicht verfügbar: Kurz-Audio-Schnittstelle mit WAV in 55-s-Stücken.
async function transcribeBlob(blob, filename, settings){
  const s = settings || speechSettings();
  if(!s.key || !s.region) throw new SpeechError('Bitte zuerst unter ⚙ Einstellungen den Azure-Schlüssel und die Region eintragen.');
  let firstErr;
  try{ return await transcribeFast(blob, filename, s); }
  catch(e){
    if(e.authFailed) throw e;
    firstErr = e;
    console.warn('Fast transcription nicht möglich, versuche Kurz-Audio', e);
  }
  try{ return await transcribeShortChunks(blob, s); }
  catch(e2){
    if(e2.authFailed) throw e2;
    throw new SpeechError((e2.message || 'Umwandeln fehlgeschlagen') + (firstErr ? ` (zuvor: ${firstErr.message})` : ''));
  }
}
function speechHttpError(status, body){
  const err = new SpeechError(status === 401 || status === 403
    ? 'Azure lehnt den Schlüssel ab (falscher Schlüssel oder falsche Region).'
    : `Azure-Fehler ${status}${body ? ': ' + String(body).slice(0, 160) : ''}`);
  err.status = status;
  err.authFailed = status === 401 || status === 403;
  return err;
}
async function transcribeFast(blob, filename, s){
  const fd = new FormData();
  fd.append('audio', blob, filename || 'aufnahme.webm');
  fd.append('definition', JSON.stringify({ locales: [s.locale] }));
  let res;
  try{
    res = await fetch(`https://${encodeURIComponent(s.region)}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${SPEECH_API_VERSION}`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': s.key }, body: fd
    });
  }catch(e){ throw new SpeechError('Keine Verbindung zu Azure (Internet oder Region prüfen).'); }
  if(!res.ok) throw speechHttpError(res.status, await res.text().catch(() => ''));
  const data = await res.json();
  const text = ((data.combinedPhrases || []).map(p => p.text).join(' ') || (data.phrases || []).map(p => p.text).join(' ')).trim();
  return text;
}
async function decodeToMono16k(blob){
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try{ decoded = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if(p && p.then) p.then(res, rej); }); }
  finally{ try{ ctx.close(); }catch(e){} }
  const rate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}
function pcmToWav(samples, rate){
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const w = (o, str) => { for(let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for(let i = 0; i < samples.length; i++){ const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([buffer], { type: 'audio/wav' });
}
async function transcribeShortChunks(blob, s){
  const samples = await decodeToMono16k(blob);
  const rate = 16000, chunk = 55 * rate;
  const parts = [];
  for(let start = 0; start < samples.length; start += chunk){
    const wav = pcmToWav(samples.subarray(start, Math.min(samples.length, start + chunk)), rate);
    parts.push(await transcribeShortWav(wav, s));
  }
  return parts.filter(Boolean).join(' ').trim();
}
async function transcribeShortWav(wav, s){
  let res;
  try{
    res = await fetch(`https://${encodeURIComponent(s.region)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(s.locale)}&format=simple`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': s.key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', 'Accept': 'application/json' }, body: wav
    });
  }catch(e){ throw new SpeechError('Keine Verbindung zu Azure (Internet oder Region prüfen).'); }
  if(!res.ok) throw speechHttpError(res.status, await res.text().catch(() => ''));
  const data = await res.json();
  if(data.RecognitionStatus && data.RecognitionStatus !== 'Success') return '';
  return (data.DisplayText || '').trim();
}
async function testSpeech(){
  const s = readSettingsForm();
  const el = $('speech-test-status');
  if(!s.key || !s.region){ el.textContent = 'Bitte Schlüssel und Region eingeben.'; return; }
  el.textContent = 'Teste…';
  const silence = pcmToWav(new Float32Array(16000), 16000); // 1 s Stille
  try{
    await transcribeFast(silence, 'test.wav', s);
    el.textContent = '✅ Verbindung ok (Fast transcription). Nicht vergessen: Speichern.';
  }catch(e){
    if(e.authFailed){ el.textContent = '❌ ' + e.message; return; }
    try{ await transcribeShortWav(silence, s); el.textContent = '✅ Verbindung ok (Kurz-Audio, max. 55 s pro Stück). Nicht vergessen: Speichern.'; }
    catch(e2){ el.textContent = '❌ ' + e2.message; }
  }
}

// Im Bearbeiten-Dialog
let transcribeBusy = false;
function resetTranscribeUi(){
  const st = $('audio-transcribe-status'); if(st) st.textContent = '';
  updateTranscribeButton();
}
function updateTranscribeButton(){
  const btn = $('audio-transcribe-btn');
  if(!btn) return;
  const hasExisting = !!(editingNoteId && notesById[editingNoteId] && notesById[editingNoteId].audioAttachmentPath);
  btn.style.display = (audioBlob || hasExisting) ? 'inline-block' : 'none';
  btn.disabled = transcribeBusy;
}
async function fetchAttachmentBlob(n){
  const origin = n.originItemId || boardRef.itemId;
  const res = await graphFetchRaw(`${attachmentUrl(origin, n.audioAttachmentPath)}:/content`);
  return res.blob();
}
async function transcribeDraft(){
  if(transcribeBusy) return;
  const status = $('audio-transcribe-status');
  if(!speechConfigured()){ status.textContent = 'Bitte zuerst unter ⚙ Einstellungen den Azure-Schlüssel und die Region eintragen.'; return; }
  transcribeBusy = true; updateTranscribeButton();
  status.textContent = 'Wandle um…';
  try{
    let blob = audioBlob, name = audioBlob ? 'aufnahme.' + audioExtension(audioBlob.type) : null;
    if(!blob){
      const n = notesById[editingNoteId];
      if(!n || !n.audioAttachmentPath) throw new SpeechError('Keine Aufnahme vorhanden.');
      blob = await fetchAttachmentBlob(n); name = n.audioAttachmentName || n.audioAttachmentPath;
    }
    const text = await transcribeBlob(blob, name);
    if(!text){ status.textContent = 'Keine Sprache erkannt.'; return; }
    // Text wird angehängt – vorhandener Text bleibt
    if(!activeComponents.has('text')) toggleComponent('text');
    const ta = $('input-text');
    ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' + text : text;
    status.textContent = '✅ Text eingefügt – mit "Speichern" übernehmen.';
  }catch(e){
    status.textContent = '❌ ' + (isNetworkError(e) ? 'Keine Verbindung' : e.message);
  }finally{ transcribeBusy = false; updateTranscribeButton(); }
}
// Aus dem Kartenmenü: Text direkt an die Karte anhängen
async function transcribeNote(fileId){
  closeContextMenu();
  const n = notesById[fileId];
  if(!n || !n.audioAttachmentPath) return;
  if(!speechConfigured()){ showStatus('Bitte zuerst unter ⚙ Einstellungen Azure einrichten', 4000); openSettings(); return; }
  if(!isOnline){ showStatus('Offline – das geht nur mit Internet'); return; }
  showStatus('Wandle Audio in Text um…', 30000);
  try{
    const blob = await fetchAttachmentBlob(n);
    const text = await transcribeBlob(blob, n.audioAttachmentName || n.audioAttachmentPath);
    if(!text){ showStatus('Keine Sprache erkannt', 3000); return; }
    await patchNote(fileId, d => {
      d.text = d.text && d.text.trim() ? d.text.replace(/\s+$/, '') + '\n\n' + text : text;
      return d;
    });
    renderBoard();
    showStatus('Text zur Karte hinzugefügt', 3000);
  }catch(e){
    if(e instanceof SpeechError) showStatus(e.message, 5000);
    else reportPatchError('Umwandeln fehlgeschlagen', e);
  }
}

// ---------- Boards ausblenden ----------
async function toggleBoardHidden(name){
  const b = boardsList.find(x => x.folderName === name);
  if(!b) return;
  if(!isOnline){ showStatus('Offline – Boards können nur online geändert werden'); return; }
  const value = !b.hidden;
  b.hidden = value;
  renderManageBoardsList(); renderBoardTabs();
  try{
    await updateBoardsMeta(meta => {
      const m = meta[name] || {};
      if(!!m.hidden === value) return undefined;
      if(value) m.hidden = true; else delete m.hidden;
      meta[name] = m;
      return meta;
    });
    persistBoardsList();
    showStatus(value ? `"${name}" ausgeblendet` : `"${name}" wieder eingeblendet`);
  }catch(e){ b.hidden = !value; renderManageBoardsList(); renderBoardTabs(); showError('Nicht gespeichert', e); }
}

// ---------- Aufräumen: verwaiste Anhänge ----------
// Ein Anhang gilt nur dann als verwaist, wenn KEINE Karte ihn mehr braucht:
//  - keine aktuelle Karte, keine archivierte Karte und keine Karte in irgendeiner Sicherung mit derselben Karten-ID,
//  - und kein aktueller/archivierter/gesicherter Karteninhalt verweist auf genau diesen Dateinamen.
// Gelöschte Anhänge landen im OneDrive-Papierkorb (wiederherstellbar).
function attachmentOwnerId(name){ const m = /^([0-9a-fA-F-]{36})_/.exec(name || ''); return m ? m[1] : null; }
function referencedPaths(note){
  if(!note) return [];
  return ['attachmentPath', 'imageAttachmentPath', 'fileAttachmentPath', 'audioAttachmentPath'].map(k => note[k]).filter(Boolean);
}
async function listChildrenSafe(driveId, parentId, path){
  try{
    const folder = await getChildByPath(driveId, parentId, path);
    return { folder, children: await graphListAll(`/drives/${driveId}/items/${folder.id}/children?$top=500`) };
  }catch(e){ if(isNotFound(e)) return { folder: null, children: [] }; throw e; }
}
async function readNotesContent(items, driveId, onProgress){
  let done = 0;
  const out = await mapLimit(items, DOWNLOAD_CONCURRENCY, async it => {
    try{ return await downloadItemJson(it, driveId); }
    catch(e){ if(isNetworkError(e)) throw e; return { __unreadable: true, name: it.name }; }
    finally{ done++; if(onProgress && done % 10 === 0) onProgress(done, items.length); }
  });
  return out;
}
async function findOrphanAttachments(progress){
  const result = [];
  for(const b of boardsList){
    if(b.folderName === IMPORTANT_BOARD_NAME) continue;
    progress(`Prüfe "${b.folderName}"…`);
    const att = await listChildrenSafe(b.driveId, b.itemId, ATTACH_SUBFOLDER);
    const files = att.children.filter(c => c.file);
    if(!files.length) continue;
    // 1) Karten-IDs aus Dateinamen: aktuell, Archiv, alle Sicherungen
    const ids = new Set();
    const noteName = n => { const m = /^note_(.+)\.json$/.exec(n || ''); return m ? m[1] : null; };
    const live = (await graphListAll(`/drives/${b.driveId}/items/${b.itemId}/children?$top=500`)).filter(c => c.file && isNoteFileName(c.name));
    live.forEach(c => ids.add(noteName(c.name)));
    const arch = (await listChildrenSafe(b.driveId, b.itemId, ARCHIVE_FOLDER)).children.filter(c => c.file && isNoteFileName(c.name));
    arch.forEach(c => ids.add(noteName(c.name)));
    const backups = (await listChildrenSafe(b.driveId, b.itemId, BACKUP_FOLDER)).children.filter(c => c.folder);
    const backupNotes = [];
    for(const day of backups){
      const kids = await graphListAll(`/drives/${b.driveId}/items/${day.id}/children?$top=500`);
      kids.filter(c => c.file && isNoteFileName(c.name)).forEach(c => { ids.add(noteName(c.name)); backupNotes.push(c); });
    }
    // Dateien ohne erkennbare Karten-ID (z.B. von Hand abgelegt) werden nie angefasst
    let candidates = files.filter(f => { const owner = attachmentOwnerId(f.name); return owner && !ids.has(owner); });
    if(!candidates.length) continue;
    // 2) Sicherheitsprüfung: Inhalte lesen (z.B. Kopien von Karten verweisen auf Anhänge mit anderer ID)
    const refs = new Set();
    let unreadable = false;
    const scan = async (items, label) => {
      const contents = await readNotesContent(items, b.driveId, (d, t) => progress(`Prüfe "${b.folderName}" – ${label} ${d}/${t}…`));
      contents.forEach(c => { if(c && c.__unreadable) unreadable = true; else referencedPaths(c).forEach(p => refs.add(p)); });
    };
    await scan(live, 'Karten');
    await scan(arch, 'Archiv');
    await scan(backupNotes, 'Sicherungen');
    // Offline-Warteschlange (lokal) ebenfalls berücksichtigen
    OfflineQueue.items.forEach(op => { referencedPaths(op.note).forEach(p => refs.add(p)); (op.attachments || []).forEach(a => refs.add(a.path)); });
    if(unreadable){ progress(`"${b.folderName}": eine Karte war nicht lesbar – dieses Board wird zur Sicherheit übersprungen.`); continue; }
    candidates = candidates.filter(f => !refs.has(f.name));
    candidates.forEach(f => result.push({ board: b, item: f }));
  }
  return result;
}
let orphanSearchRunning = false;
async function runOrphanCleanup(){
  if(orphanSearchRunning) return;
  const status = $('orphan-status');
  if(!isOnline){ status.textContent = 'Offline – nur mit Internet möglich.'; return; }
  if(OfflineQueue.items.length){ status.textContent = 'Es gibt noch ausstehende Offline-Änderungen. Bitte zuerst übertragen (⏳ oben), dann nochmals versuchen.'; return; }
  orphanSearchRunning = true;
  try{
    const orphans = await findOrphanAttachments(msg => { status.textContent = msg; });
    if(!orphans.length){ status.textContent = '✅ Keine verwaisten Anhänge gefunden.'; return; }
    const total = orphans.reduce((s, o) => s + (o.item.size || 0), 0);
    const mb = (total / 1024 / 1024).toFixed(1);
    const list = orphans.slice(0, 12).map(o => `• ${o.board.folderName}: ${o.item.name.replace(/^[0-9a-fA-F-]{36}_/, '')} (${Math.round((o.item.size || 0) / 1024)} KB)`).join('\n')
      + (orphans.length > 12 ? `\n… und ${orphans.length - 12} weitere` : '');
    status.textContent = `${orphans.length} verwaiste(r) Anhang/Anhänge gefunden (${mb} MB).`;
    const ok = await choose('Verwaiste Anhänge', `Diese Dateien gehören zu keiner Karte mehr – weder aktuell, noch im Archiv, noch in einer Sicherung:\n\n${list}\n\nSie werden in den OneDrive-Papierkorb verschoben (dort ca. 30 Tage wiederherstellbar).`,
      [{ value: true, label: `${orphans.length} Datei(en) in den Papierkorb`, primary: true }]);
    if(!ok){ status.textContent = 'Nichts gelöscht.'; return; }
    let deleted = 0;
    for(const o of orphans){
      try{ await graphFetchRaw(`/drives/${o.board.driveId}/items/${o.item.id}`, { method: 'DELETE' }); deleted++; }
      catch(e){ if(!isNotFound(e)) console.warn('Konnte nicht löschen', o.item.name, e); }
    }
    status.textContent = `✅ ${deleted} Datei(en) in den OneDrive-Papierkorb verschoben (${mb} MB).`;
  }catch(e){
    status.textContent = '❌ ' + (isNetworkError(e) ? 'Verbindung unterbrochen – nichts weiter gelöscht.' : e.message);
  }finally{ orphanSearchRunning = false; }
}

// ---------- Dauerhafter Speicher (schützt Offline-Warteschlange und Cache vor dem automatischen Löschen) ----------
(async function requestPersistentStorage(){
  try{
    if(navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  }catch(e){}
})();

// ---------- Klicks ----------
Object.assign(actions, {
  'toggle-expand': el => toggleExpand(el.dataset.id),
  'toggle-done-items': el => toggleDoneItems(el.dataset.id),
  'toggle-done': el => toggleDoneFlag(el.dataset.id),
  'text-to-checklist': el => convertTextToChecklist(el.dataset.id),
  'important-done': el => markImportantDone(el.dataset.id),
  'open-due': el => openDueModal(el.dataset.id),
  'close-due': () => closeDueModal(),
  'save-due': () => saveDue(false),
  'clear-due': () => saveDue(true),
  'export-ics': el => exportIcs(el.dataset.id),
  'open-settings': () => openSettings(),
  'save-settings': () => saveSettings(),
  'test-speech': () => testSpeech(),
  'clear-speech': () => clearSpeechSettings(),
  'transcribe-draft': () => transcribeDraft(),
  'transcribe-note': el => transcribeNote(el.dataset.id),
  'toggle-board-hidden': el => toggleBoardHidden(el.dataset.board),
  'find-orphans': () => runOrphanCleanup(),
});
// Einstellungen/Tag-Dialog schliessen, wenn man daneben tippt
['settings-modal', 'due-modal'].forEach(id => {
  const el = $(id);
  if(el) el.addEventListener('click', e => { if(e.target === el) el.style.display = 'none'; });
});
