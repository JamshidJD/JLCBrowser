const tabs = document.querySelector('#tabs');
const address = document.querySelector('#address');
const command = (action, value) => window.browser.command(action, value);
document.querySelector('#new-tab').addEventListener('click', () => command('new'));
for (const action of ['back', 'forward', 'reload']) document.querySelector(`#${action}`).addEventListener('click', () => command(action));
document.querySelector('#translate').addEventListener('click', () => command('translate'));
document.querySelector('#navigation').addEventListener('submit', event => {
  event.preventDefault();
  if (address.value.trim()) { command('navigate', address.value.trim()); address.blur(); }
});
window.browser.onFocusAddress(() => { address.focus(); address.select(); });
window.browser.onState(state => {
  const previousActive = tabs.querySelector('[aria-selected="true"]')?.dataset.id;
  const focused = document.activeElement;
  const focusedId = focused?.dataset.id;
  const focusedAction = focused?.dataset.action;
  tabs.replaceChildren();
  for (const tab of state.tabs) {
    const row = document.createElement('div');
    row.className = `tab${tab.id === state.active ? ' selected' : ''}${tab.loading ? ' loading' : ''}${tab.error ? ' error' : ''}`;
    const select = document.createElement('button');
    select.className = 'tab-select';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(tab.id === state.active));
    select.setAttribute('aria-label', `${tab.title}${tab.loading ? ', loading' : ''}${tab.error ? ', page failed to load' : ''}`);
    select.tabIndex = tab.id === state.active ? 0 : -1;
    select.dataset.id = tab.id;
    select.dataset.action = 'select';
    select.title = tab.error ? `${tab.title}: ${tab.error}. Reload to retry.` : tab.title;
    const status = document.createElement('span'); status.className = 'status'; status.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = tab.title;
    select.append(status, label);
    select.addEventListener('click', () => command('select', tab.id));
    select.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const index = state.tabs.indexOf(tab);
        command('select', state.tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length].id);
      }
    });
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Close tab (Ctrl+W)';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.dataset.id = tab.id;
    close.dataset.action = 'close';
    close.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg>';
    close.addEventListener('click', () => command('close', tab.id));
    row.addEventListener('auxclick', event => { if (event.button === 1) command('close', tab.id); });
    row.append(select, close);
    tabs.append(row);
  }
  if (document.activeElement !== address || previousActive !== String(state.active)) address.value = state.url === 'about:blank' ? '' : state.url;
  address.title = state.error ? `${state.error}. Reload to retry.` : state.url;
  document.querySelector('#back').disabled = !state.canGoBack;
  document.querySelector('#forward').disabled = !state.canGoForward;
  const translation = state.translation;
  const translateButton = document.querySelector('#translate');
  translateButton.disabled = !translation || !/^https?:/.test(state.url);
  translateButton.setAttribute('aria-pressed', String(Boolean(translation?.enabled)));
  translateButton.setAttribute('aria-busy', String(Boolean(translation?.busy)));
  document.querySelector('#translate-label').textContent = translation?.busy ? 'Translating…' : translation?.enabled ? 'Original' : 'Translate';
  translateButton.title = translation?.enabled
    ? `Show original language. ${translation.saved} saved translations reused; ${translation.online} translated online.${translation.error ? ` ${translation.error}` : ''}`
    : 'Translate this page to English. Saved text works offline; new text is sent to Google.';
  const translationStatus = document.querySelector('#translate-status');
  translationStatus.hidden = !translation?.error;
  translationStatus.textContent = translation?.error ? (translation.saved + translation.online ? 'Partly translated' : 'Translation unavailable') : '';
  translationStatus.title = translation?.error || '';
  const selected = tabs.querySelector('[aria-selected="true"]');
  if (previousActive !== String(state.active)) selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusedId) tabs.querySelector(`[data-id="${focusedId}"][data-action="${focusedAction}"]`)?.focus();
});
