export interface ColorTheme {
  name: string;
  colorCustomizations: Record<string, string>;
}

function build(
  name: string,
  primary: string,
  dark: string,
  fg: string,
  badge: string,
): ColorTheme {
  const fgMuted  = `${fg}99`;
  const primaryA = `${primary}99`;
  const darkA    = `${dark}99`;

  return {
    name,
    colorCustomizations: {
      'activityBar.activeBackground':      primaryA,
      'activityBar.background':            primaryA,
      'activityBar.foreground':            fg,
      'activityBar.inactiveForeground':    fgMuted,
      'activityBarBadge.background':       badge,
      'activityBarBadge.foreground':       fg,
      'commandCenter.border':              fgMuted,
      'sash.hoverBorder':                  primaryA,
      'statusBar.background':              darkA,
      'statusBar.foreground':              fg,
      'statusBarItem.hoverBackground':     primaryA,
      'statusBarItem.remoteBackground':    darkA,
      'statusBarItem.remoteForeground':    fg,
      'titleBar.activeBackground':         darkA,
      'titleBar.activeForeground':         fg,
      'titleBar.inactiveBackground':       darkA,
      'titleBar.inactiveForeground':       fgMuted,
    },
  };
}

export const THEMES: ColorTheme[] = [
  // — warm —
  build('Scarlet',  '#5c0f18', '#2e080c', '#f5e8ea', '#22d3ee'),  //   0°  red
  build('Rust',     '#5c200a', '#2e1005', '#f5ebe8', '#4ade80'),  //  18°  red-orange
  build('Amber',    '#5c3d08', '#2e1f04', '#f5edd8', '#818cf8'),  //  43°  dark honey/gold
  build('Moss',     '#3a4508', '#1d2204', '#eef0e7', '#f43f5e'),  //  80°  military olive

  // — cool —
  build('Forest',   '#0f4524', '#08231a', '#e8f2ec', '#f59e0b'),  // 145°  deep green
  build('Teal',     '#0d3d48', '#071f24', '#e7f4f6', '#f97316'),  // 185°  ocean teal
  build('Cobalt',   '#1a3d80', '#0d1f40', '#e7eef8', '#fb923c'),  // 217°  steel blue
  build('Navy',     '#081f66', '#040f33', '#e7e8f5', '#f43f5e'),  // 228°  deep navy

  // — violet → rose —
  build('Indigo',   '#1a0f5e', '#0d082f', '#ece8f8', '#f59e0b'),  // 258°  true indigo
  build('Violet',   '#2e0f50', '#170828', '#f0e8f8', '#4ade80'),  // 280°  purple
  build('Fuchsia',  '#4a0d44', '#250722', '#f5e8f4', '#22d3ee'),  // 305°  fuchsia
  build('Rose',     '#4a0f2a', '#250715', '#f5e8ee', '#4ade80'),  // 335°  dusty rose

  build('Obsidian', '#1a1a2e', '#0d0d1a', '#e7e7f5', '#fb923c'),
];