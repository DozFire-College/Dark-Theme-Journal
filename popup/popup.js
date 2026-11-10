const DEFAULTS = { enabled: true, palette: 'graphite', smart: true };

const $enabled = document.getElementById('enabled');
const $smart = document.getElementById('smart');
const $status = document.getElementById('status');
const $paletteBlock = document.getElementById('paletteBlock');
const $smartRow = document.getElementById('smartRow');
const $pals = [...document.querySelectorAll('.pal')];

function render(s) {
  $enabled.checked = s.enabled;
  $smart.checked = s.smart;
  $status.textContent = s.enabled ? 'Тема включена' : 'Тема выключена';
  $status.classList.toggle('on', s.enabled);
  $paletteBlock.classList.toggle('disabled', !s.enabled);
  $smartRow.classList.toggle('disabled', !s.enabled);
  for (const b of $pals) b.setAttribute('aria-checked', String(b.dataset.palette === s.palette));
}

chrome.storage.sync.get(DEFAULTS, render);
chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'sync') chrome.storage.sync.get(DEFAULTS, render);
});

$enabled.addEventListener('change', () => chrome.storage.sync.set({ enabled: $enabled.checked }));
$smart.addEventListener('change', () => chrome.storage.sync.set({ smart: $smart.checked }));
for (const b of $pals) {
  b.addEventListener('click', () => chrome.storage.sync.set({ palette: b.dataset.palette }));
}
