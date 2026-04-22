import manifest from './manifest.js';
import createQualityRoomPlugin from './plugin.js';

function createPlugin() {
  return createQualityRoomPlugin();
}

export { manifest, createPlugin };

export default { manifest, createPlugin };
