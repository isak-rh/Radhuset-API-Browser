// Stroke icons on a 24×24 grid, drawn in currentColor.

const lower = 'M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15';

export const ICONS = {
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M16 16l4.5 4.5' }]],
  box: [['rect', { x: 4, y: 5.5, width: 16, height: 13, rx: 1.5, 'stroke-dasharray': '3 2.4' }]],
  polygon: [
    ['path', { d: 'M6 5 18 7.5 19.5 16 10.5 19.5 4.5 13z', 'stroke-dasharray': '3 2.4' }],
    ['circle', { cx: 6, cy: 5, r: 1.4, fill: 'currentColor' }],
    ['circle', { cx: 19.5, cy: 16, r: 1.4, fill: 'currentColor' }],
  ],
  upload: [['path', { d: 'M12 15V4.5m0 0L7.5 9M12 4.5 16.5 9' }], ['path', { d: lower }]],
  download: [['path', { d: 'M12 4.5V15m0 0-4.5-4.5M12 15l4.5-4.5' }], ['path', { d: lower }]],
  x: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  trash: [['path', { d: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10.5 11v5M13.5 11v5' }]],
  key: [['circle', { cx: 8, cy: 15.5, r: 3.5 }], ['path', { d: 'M10.5 13 19 4.5M16.5 7l2.5 2.5M14 9.5l1.8 1.8' }]],
  lock: [['rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 1.5 }], ['path', { d: 'M8 10.5V7.5a4 4 0 0 1 8 0v3' }]],
  unlock: [['rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 1.5 }], ['path', { d: 'M8 10.5V7.5a4 4 0 0 1 7.7-1.5' }]],
  settings: [
    ['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }],
    ['circle', { cx: 15, cy: 7, r: 2 }],
    ['circle', { cx: 9, cy: 17, r: 2 }],
  ],
  chevronDown: [['path', { d: 'M6.5 9.5 12 15l5.5-5.5' }]],
  chevronUp: [['path', { d: 'M6.5 14.5 12 9l5.5 5.5' }]],
  chevronRight: [['path', { d: 'M9.5 6.5 15 12l-5.5 5.5' }]],
  chevronLeft: [['path', { d: 'M14.5 6.5 9 12l5.5 5.5' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  info: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 11v5.5M12 7.9v.1' }]],
  alert: [['path', { d: 'M12 4.5 20.5 19H3.5z' }], ['path', { d: 'M12 10v4.5M12 16.9v.1' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  edit: [['path', { d: 'M15.5 5.5l3 3L9 18H6v-3z' }]],
  folder: [['path', { d: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.5l2 2H19A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z' }]],
  file: [['path', { d: 'M6.5 3.5h7l4 4v13h-11z' }], ['path', { d: 'M13.5 3.5v4h4' }]],
  layers: [
    ['path', { d: 'M12 4 20.5 8.5 12 13 3.5 8.5z' }],
    ['path', { d: 'M3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5' }],
  ],
  target: [['circle', { cx: 12, cy: 12, r: 6.5 }], ['path', { d: 'M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21' }]],
  panelRight: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 1.5 }], ['path', { d: 'M14.5 4.5v15' }]],
  panelLeft: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 1.5 }], ['path', { d: 'M9.5 4.5v15' }]],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 1.5 }]],
  refresh: [['path', { d: 'M19 12a7 7 0 1 1-2.05-4.95M19 4.5V9h-4.5' }]],
  copy: [
    ['rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 1.5 }],
    ['path', { d: 'M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5' }],
  ],
  externalLink: [
    ['path', { d: 'M13.5 4.5h6v6M19.5 4.5 11 13' }],
    ['path', { d: 'M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10' }],
  ],
  filter: [['path', { d: 'M4 5.5h16l-6.2 7.3v5.7l-3.6 1.8v-7.5z' }]],
  passkey: [
    ['circle', { cx: 9, cy: 8, r: 3.5 }],
    ['path', { d: 'M3.5 19.5a5.5 5.5 0 0 1 9.2-4.1' }],
    ['circle', { cx: 17.5, cy: 14, r: 2.3 }],
    ['path', { d: 'M17.5 16.3V21m0-2h2' }],
  ],
  eye: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  eyeOff: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
    ['path', { d: 'M4 4l16 16' }],
  ],
  image: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 1.5 }],
    ['circle', { cx: 9, cy: 10, r: 1.6 }],
    ['path', { d: 'M20.5 15.5l-4.5-4.5-8.5 8' }],
  ],
  map: [['path', { d: 'M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z' }], ['path', { d: 'M9 4.5v13M15 6.5v13' }]],
  calendar: [['rect', { x: 4, y: 5.5, width: 16, height: 14, rx: 1.5 }], ['path', { d: 'M4 10h16M8.5 3.5v4M15.5 3.5v4' }]],
  arrowUp: [['path', { d: 'M12 19V5m0 0-5 5m5-5 5 5' }]],
  arrowDown: [['path', { d: 'M12 5v14m0 0-5-5m5 5 5-5' }]],
  more: [
    ['circle', { cx: 12, cy: 5.5, r: 1.3, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 18.5, r: 1.3, fill: 'currentColor', stroke: 'none' }],
  ],
  api: [
    ['rect', { x: 4, y: 4.5, width: 16, height: 6, rx: 1.5 }],
    ['rect', { x: 4, y: 13.5, width: 16, height: 6, rx: 1.5 }],
    ['path', { d: 'M7.5 7.5h.1M7.5 16.5h.1' }],
  ],
  shield: [['path', { d: 'M12 3.5 19 6v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z' }], ['path', { d: 'M9 12l2.2 2.2L15.5 10' }]],
  import: [['path', { d: 'M12 4.5V15m0 0-4.5-4.5M12 15l4.5-4.5' }], ['path', { d: lower }]],
  export: [['path', { d: 'M12 15V4.5m0 0L7.5 9M12 4.5 16.5 9' }], ['path', { d: lower }]],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4' }],
  ],
};
