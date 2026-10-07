// DOM events between page-bridge.ts (page world) and the content script
// (isolated world). Both worlds see DOM events, nothing else.
export const LOCATION_EVENT = 'claude-outline:locationchange';
export const DEBUG_EVENT = 'claude-outline:debug';
