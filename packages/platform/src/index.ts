import type { NativeBridge } from '../../contracts/src/index';

declare global { interface Window { mediaWorkbench?: NativeBridge } }

export function desktopBridge(): NativeBridge | undefined { return window.mediaWorkbench; }
export const browserCapabilities = {
  fileClipboard: { state: 'unavailable', reason: 'Copying a file reference requires the desktop application.' },
  nativeDragOut: { state: 'unavailable', reason: 'Native drag out requires the desktop application.' },
  revealFile: { state: 'unavailable', reason: 'A browser cannot reveal files on the service host.' },
  externalActions: { state: 'unavailable', reason: 'Executable bindings belong to the trusted local desktop owner.' }
};
