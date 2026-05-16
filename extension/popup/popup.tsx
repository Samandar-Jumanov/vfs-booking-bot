import type { RuntimeState } from '../shared/types';

interface StateResponse {
  state: RuntimeState;
  settings: { customerEmail?: string };
}

const statusDot = document.getElementById('statusDot');
const connectionStatus = document.getElementById('connectionStatus');
const customerEmail = document.getElementById('customerEmail');

document.getElementById('openVfs')?.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'OPEN_VFS' });
});

document.getElementById('disconnect')?.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'DISCONNECT' }).then(refresh);
});

document.getElementById('openOptions')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

void refresh();

async function refresh(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' }) as StateResponse;
  const state = response.state;
  const connected = state.connectionStatus === 'connected';
  statusDot?.classList.toggle('connected', connected);
  if (connectionStatus) {
    connectionStatus.textContent = state.connectionStatus[0].toUpperCase() + state.connectionStatus.slice(1);
  }
  if (customerEmail) {
    customerEmail.textContent = state.customerEmail ?? response.settings.customerEmail ?? 'Not paired';
  }
}
