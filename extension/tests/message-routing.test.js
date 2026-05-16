const assert = require('assert');

function routeBackendMessage(state, message) {
  if (message.type === 'START_MONITOR') return { ...state, activeMonitor: message.monitor };
  if (message.type === 'STOP_MONITOR') return { ...state, activeMonitor: undefined };
  return state;
}

const started = routeBackendMessage({ connectionStatus: 'connected' }, {
  type: 'START_MONITOR',
  monitor: { sourceCountry: 'uzb', destination: 'lva', visaCategoryCode: 'SCH', vacCode: 'TAS' },
});
assert.strictEqual(started.activeMonitor.destination, 'lva');

const stopped = routeBackendMessage(started, { type: 'STOP_MONITOR' });
assert.strictEqual(stopped.activeMonitor, undefined);

console.log('extension message routing tests passed');
