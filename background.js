// Горячая клавиша Alt+Shift+D: включает / выключает тёмную тему.
const DEFAULTS = { enabled: true, palette: 'graphite', smart: true };

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(current);
  updateBadge(current.enabled);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-theme') return;
  const { enabled } = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set({ enabled: !enabled });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) updateBadge(changes.enabled.newValue);
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await chrome.storage.sync.get(DEFAULTS);
  updateBadge(enabled);
});

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#5b6573' });
}
