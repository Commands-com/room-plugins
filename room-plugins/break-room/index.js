import createBreakRoomPlugin from './plugin.js';
import { manifest } from './manifest.js';

function createPlugin() {
  return createBreakRoomPlugin();
}

export { manifest, createPlugin };

export default { manifest, createPlugin };
