const $ = (s) => document.querySelector(s);

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  $('#server').value = status.serverUrl || 'http://localhost:3000';
  $('#room').value = status.roomId || '';
  if (status.connected) {
    $('#status').textContent = 'Connected to room ' + status.roomId;
    $('#status').className = 'status ok';
  } else if (status.roomId) {
    $('#status').textContent = 'Not connected (server unreachable?)';
    $('#status').className = 'status';
  } else {
    $('#status').textContent = '';
  }
}

$('#save').onclick = async () => {
  const roomId = $('#room').value.trim();
  const serverUrl = $('#server').value.trim() || 'http://localhost:3000';
  if (!roomId) { $('#room').focus(); return; }
  $('#status').textContent = 'Connecting…';
  $('#status').className = 'status';
  await chrome.runtime.sendMessage({ type: 'set-room', roomId, serverUrl });
  setTimeout(refresh, 800);
};

refresh();
