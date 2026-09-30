import React from 'react';
const paths:Record<string,React.ReactNode>={
  undo:<path d="M4 4v6h6M4 10a8 8 0 1 1 0 7"/>,
  redo:<path d="M20 4v6h-6m6 0a8 8 0 1 0 0 7"/>,
  snap:<><path d="M5 3v10a7 7 0 0 0 14 0V3h-5v10a2 2 0 0 1-4 0V3Z"/><path d="M5 7h5m4 0h5"/></>,
  media:<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Zm0 3h18"/>,
  text:<><path d="M4 5V3h16v2M12 3v18M8 21h8"/></>,
  audio:<><path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/></>,
  transform:<><path d="M6 4h12M20 6v12M18 20H6M4 18V6"/><path d="M2 2h4v4H2zM18 2h4v4h-4zM2 18h4v4H2zM18 18h4v4h-4z"/></>,
  video:<><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M7 3v18M17 3v18M3 8h4m10 0h4M3 16h4m10 0h4"/></>,
  play:<path d="m7 3 15 9-15 9Z" fill="currentColor"/>,pause:<path d="M7 4v16M17 4v16" strokeWidth="4"/>,
  previous:<><path d="M5 5v14m14-14L7 12l12 7Z" fill="currentColor"/></>,next:<><path d="M19 5v14M5 5l12 7-12 7Z" fill="currentColor"/></>,
  fullscreen:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
  trash:<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  left:<path d="M4 5h16M4 10h10M4 15h16M4 20h10"/>,center:<path d="M4 5h16M7 10h10M4 15h16M7 20h10"/>,right:<path d="M4 5h16M10 10h10M4 15h16M10 20h10"/>,
  more:<><circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/></>,
  justify:<path d="M4 5h16M4 10h16M4 15h16M4 20h16"/>,
  eyedropper:<><path d="m15 4 5 5M4 16l10-10 4 4L8 20H4v-4ZM3 21l2-2"/><path d="m15 5 3-3a2 2 0 0 1 3 3l-3 3"/></>,
  cut:<><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 13 13M8 16 21 3"/></>,
  saved:<><path d="m8 12 3 3 7-8M20 12a8 8 0 1 1-8-8"/></>,
  volume:<><path d="M4 9h4l5-4v14l-5-4H4Zm12-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/></>
};
export function EditorIcon({name}:{name:string}){return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]||paths.more}</svg>}
