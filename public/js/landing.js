const $ = (s) => document.querySelector(s);
const nameInput = $('#name');
const codeInput = $('#code');

nameInput.value = localStorage.getItem('wp.name') || '';
nameInput.focus();

function go(roomId) {
  const name = nameInput.value.trim() || 'guest';
  localStorage.setItem('wp.name', name);
  location.href = `/r/${encodeURIComponent(roomId)}`;
}

$('#create').onclick = async () => {
  const r = await fetch('/api/rooms', { method: 'POST' });
  const { id } = await r.json();
  go(id);
};

$('#join').onclick = () => {
  const code = codeInput.value.trim();
  if (!code) { codeInput.focus(); return; }
  go(code);
};

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#join').click();
});
