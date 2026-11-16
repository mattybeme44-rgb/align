/*
 * The shell around the measurement: the setup popovers on the toolbar and the
 * tabbed column that keeps everything which is not needed while reading a
 * curve out of the plot's way.
 *
 * It only moves panels and focus. Every control it reveals is already bound by
 * app.js, so nothing here touches the measurement.
 */

const STORE_KEY = 'align.panel';

const menu = document.getElementById('tbMenus');
const popovers = Array.from(document.querySelectorAll('.popover'));
const menuButtons = menu
  ? Array.from(menu.querySelectorAll('[data-panel]'))
  : [];

function closePopovers(except) {
  for (const panel of popovers) {
    if (panel === except) continue;
    panel.hidden = true;
  }
  for (const button of menuButtons) {
    const target = document.getElementById(button.dataset.panel);
    if (!target || target.hidden) button.setAttribute('aria-expanded', 'false');
  }
}

function openPopover(button) {
  const panel = document.getElementById(button.dataset.panel);
  if (!panel) return;

  const wasOpen = !panel.hidden;
  closePopovers(panel);
  if (wasOpen) {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return;
  }

  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');

  // Anchor the panel over its own button, kept inside the window.
  const rect = button.getBoundingClientRect();
  const width = panel.offsetWidth || 320;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  panel.style.left = Math.round(left) + 'px';
}

for (const button of menuButtons) {
  button.addEventListener('click', () => openPopover(button));
}

document.addEventListener('pointerdown', (event) => {
  if (!popovers.some((panel) => !panel.hidden)) return;
  if (event.target.closest('.popover')) return;
  if (event.target.closest('#tbMenus')) return;
  closePopovers(null);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closePopovers(null);
});

/* ---------- the tabbed column ---------- */

const tabs = Array.from(document.querySelectorAll('#toolTabs [data-tool]'));
const panels = tabs
  .map((tab) => document.getElementById(tab.dataset.tool))
  .filter(Boolean);

function showPanel(id) {
  for (const tab of tabs) {
    const on = tab.dataset.tool === id;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const panel of panels) {
    panel.hidden = panel.id !== id;
  }
  const body = document.querySelector('.tool-body');
  if (body) body.scrollTop = 0;
  // A canvas measured while its panel was hidden comes back at the wrong size,
  // so every chart is re-measured and repainted once the panel is on screen.
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  try {
    window.localStorage.setItem(STORE_KEY, id);
  } catch (err) {
    /* private browsing: the column just starts on Impulse again */
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => showPanel(tab.dataset.tool));
}

let storedPanel = null;
try {
  storedPanel = window.localStorage.getItem(STORE_KEY);
} catch (err) {
  storedPanel = null;
}

if (storedPanel && panels.some((panel) => panel.id === storedPanel)) {
  showPanel(storedPanel);
} else if (panels.length) {
  showPanel(panels[0].id);
}

// Opening a sheet from a panel must not leave a menu over it.
const sheetButtons = document.querySelectorAll('.tool-body .btn, .tool-body .link-btn');
for (const button of sheetButtons) {
  button.addEventListener('click', () => closePopovers(null));
}

// A sheet opened from a setup menu covers the plot and the menu with it, so the
// menu goes as soon as a sheet is on screen.
const sheetObserver = new MutationObserver(() => {
  const anySheet = Array.from(document.querySelectorAll('.sheet'))
    .some((sheet) => !sheet.hidden);
  if (anySheet) closePopovers(null);
});

for (const sheet of document.querySelectorAll('.sheet')) {
  sheetObserver.observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
}
