// ============ Start der App ============

if('serviceWorker' in navigator){
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
setInterval(checkForUpdate, 10 * 60 * 1000);
setTimeout(checkForUpdate, 8000);

function showLoginError(html){
  $('login-screen').style.display = 'flex';
  $('login-area').innerHTML = html;
}
function showSetupScreen(message){
  $('login-screen').style.display = 'none';
  $('board').style.display = 'none';
  $('setup-connect').style.display = 'block';
  $('setup-nofirst').style.display = 'none';
  $('setup-screen').style.display = 'block';
  if(message) $('setup-error').innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
}

// Board-Liste im Hintergrund prüfen, während schon der gespeicherte Stand angezeigt wird
async function refreshBoardsInBackground(){
  try{
    await graphFetch(`/drives/${containerRef.driveId}/items/${containerRef.itemId}?$select=id`);
    const before = JSON.stringify(boardsList.map(b => [b.folderName, b.color, b.itemId]));
    await refreshBoardsList();
    const after = JSON.stringify(boardsList.map(b => [b.folderName, b.color, b.itemId]));
    if(before !== after){
      if(!boardsList.length){ showNoBoardsScreen(); return; }
      if(!boardsList.some(b => b.itemId === boardRef.itemId)){ boardRef = { folderName:null }; await switchBoard(boardsList[0].folderName); }
      renderBoardTabs(); applyBoardColor();
    }
    setOnline(true);
    syncQueue();
  }catch(e){
    if(e && e.message === 'redirecting_for_reauth') return;
    if(isNetworkError(e)){ setOnline(false); return; }
    if(e.status === 404 || e.status === 403){
      localRemove('container_ref');
      showSetupScreen('Der "Boards"-Ordner ist nicht mehr erreichbar (gelöscht oder Freigabe entfernt). Bitte neu verbinden.');
    }
  }
}

(async function boot(){
  renderConnectivity();
  await OfflineQueue.load();
  if(msalInitError){
    showLoginError(`<div class="error-box">${escapeHtml(msalInitError.message)}</div>
      <button class="btn btn-primary" style="margin-top:10px;" data-action="reload">Seite neu laden</button>`);
    return;
  }
  try{
    const response = await msalInstance.handleRedirectPromise();
    const account = response ? response.account : msalInstance.getAllAccounts()[0];
    if(!account){ $('login-screen').style.display = 'flex'; return; }
    me.account = account; me.name = account.name; me.email = account.username;
    renderHeader();
    $('login-screen').style.display = 'none';

    const saved = localGet('container_ref');
    if(!saved){ showSetupScreen(); return; }
    containerRef = JSON.parse(saved);

    // Sofort den gespeicherten Stand zeigen (funktioniert auch offline) ...
    if(loadPersistedBoardsList() && boardsList.length){
      const activeName = localGet('active_board_name');
      boardRef = boardsList.find(b => b.folderName === activeName) || boardsList[0];
      startBoard();
      refreshBoardsInBackground(); // ... und im Hintergrund abgleichen
      return;
    }
    // Erster Start auf diesem Gerät: Internet nötig
    try{
      await graphFetch(`/drives/${containerRef.driveId}/items/${containerRef.itemId}?$select=id`);
      await refreshBoardsList();
    }catch(e){
      if(e && e.message === 'redirecting_for_reauth') return;
      if(isNetworkError(e)){ setOnline(false); showSetupScreen('Offline – beim ersten Start auf diesem Gerät wird eine Internetverbindung benötigt.'); return; }
      showSetupScreen(); return;
    }
    if(boardsList.length){
      const activeName = localGet('active_board_name');
      boardRef = boardsList.find(b => b.folderName === activeName) || boardsList[0];
      startBoard();
      syncQueue();
    } else showNoBoardsScreen();
  }catch(err){
    showLoginError(`<div class="error-box">Anmeldung fehlgeschlagen: ${escapeHtml(err.message)}</div>
      <button class="btn btn-primary" style="margin-top:10px;" data-action="login">Erneut versuchen</button>`);
  }
})();
