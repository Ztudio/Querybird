/**
 * Every color in the app comes from one of these themes. A theme only defines its base palette;
 * hover, border, stripe and highlight shades are derived in styles.css (`color-mix`), so adding a
 * theme means adding one object here. Palettes follow Paradev's built-in themes.
 */
export interface Theme {
  id: string;
  name: string;
  type: "dark" | "light";
  ui: {
    background: string; // editor / grid area
    foreground: string;
    mutedForeground: string;
    sidebar: string; // side panels
    card: string; // modals, menus, tab bar
    tertiary: string; // toolbars
    secondary: string; // controls
    secondaryHover: string;
    border: string;
    selection: string; // selected row / hovered menu item
    primary: string; // main button
    primaryForeground: string;
    highlight: string; // brand color: focus ring, active tab, links
    destructive: string;
    warning: string;
    success: string;
  };
  /** SQL editor colors */
  syntax: { keyword: string; string: string; number: string; comment: string; special: string };
}

const DARK_SYNTAX = { keyword: "#61afef", string: "#98c379", number: "#d19a66", comment: "#7d8590", special: "#c678dd" };
const LIGHT_SYNTAX = { keyword: "#3050c8", string: "#a8520f", number: "#7a46c9", comment: "#7d8798", special: "#7c4dd6" };

export const THEMES: Theme[] = [
  {
    id: "dark",
    name: "Ember",
    type: "dark",
    ui: {
      background: "#151110", foreground: "#eae8e6", mutedForeground: "#a8a5a3",
      sidebar: "#1a1716", card: "#201e1c", tertiary: "#1a1716", secondary: "#2a2827", secondaryHover: "#252220",
      border: "#2a2827", selection: "#252220", primary: "#eae8e6", primaryForeground: "#151110", highlight: "#e07850",
      destructive: "#cc4444", warning: "#e5c07b", success: "#00c950",
    },
    syntax: { ...DARK_SYNTAX, keyword: "#e07850" },
  },
  {
    id: "light",
    name: "Light",
    type: "light",
    ui: {
      background: "#f9f9fa", foreground: "#171717", mutedForeground: "#4a4847",
      sidebar: "#ececec", card: "#f4f4f4", tertiary: "#f1efee", secondary: "#f4f4f4", secondaryHover: "#e6e4e3",
      border: "#e2e2e2", selection: "#e4e4e4", primary: "#171717", primaryForeground: "#fafafa", highlight: "#d6561b",
      destructive: "#d92d20", warning: "#906d00", success: "#00a843",
    },
    syntax: { ...LIGHT_SYNTAX, keyword: "#c2410c" },
  },
  {
    id: "monokai",
    name: "Monokai",
    type: "dark",
    ui: {
      background: "#272822", foreground: "#f8f8f2", mutedForeground: "#b8b3a4",
      sidebar: "#1e1f1c", card: "#3e3d32", tertiary: "#1e1f1c", secondary: "#3e3d32", secondaryHover: "#49483e",
      border: "#49483e", selection: "#3e3d32", primary: "#a6e22e", primaryForeground: "#272822", highlight: "#a6e22e",
      destructive: "#f92672", warning: "#f4bf75", success: "#a6e22e",
    },
    syntax: { keyword: "#f92672", string: "#e6db74", number: "#ae81ff", comment: "#75715e", special: "#66d9ef" },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    type: "light",
    ui: {
      background: "#eff1f5", foreground: "#4c4f69", mutedForeground: "#6c6f85",
      sidebar: "#e6e9ef", card: "#e6e9ef", tertiary: "#dce0e8", secondary: "#ccd0da", secondaryHover: "#bcc0cc",
      border: "#bcc0cc", selection: "#ccd0da", primary: "#8839ef", primaryForeground: "#eff1f5", highlight: "#8839ef",
      destructive: "#d20f39", warning: "#885000", success: "#40a02b",
    },
    syntax: { keyword: "#8839ef", string: "#40a02b", number: "#fe640b", comment: "#9ca0b0", special: "#1e66f5" },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    type: "light",
    ui: {
      background: "#fdf6e3", foreground: "#586e75", mutedForeground: "#657b83",
      sidebar: "#f5eecb", card: "#eee8d5", tertiary: "#f5eecb", secondary: "#eee8d5", secondaryHover: "#e4ddc4",
      border: "#e4ddc4", selection: "#eee8d5", primary: "#268bd2", primaryForeground: "#fdf6e3", highlight: "#b58900",
      destructive: "#dc322f", warning: "#895900", success: "#859900",
    },
    syntax: { keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#93a1a1", special: "#268bd2" },
  },
  {
    id: "vellum",
    name: "Vellum",
    type: "light",
    ui: {
      background: "#f5efdc", foreground: "#1a1814", mutedForeground: "#6b5d3c",
      sidebar: "#efe7d0", card: "#ede5cc", tertiary: "#efe7d0", secondary: "#e2d8b8", secondaryHover: "#dccea7",
      border: "#d4c6a2", selection: "#dccea7", primary: "#8b3a1a", primaryForeground: "#f5efdc", highlight: "#a8862a",
      destructive: "#a82e2e", warning: "#7b6c05", success: "#5e6b3a",
    },
    syntax: { keyword: "#8b3a1a", string: "#5e6b3a", number: "#a8862a", comment: "#8a7c5c", special: "#6b4f9a" },
  },
];

/** "system" follows the OS: Ember in dark mode, Light otherwise. */
export const SYSTEM_THEME = "system";

export function findTheme(id: string, prefersDark: boolean): Theme {
  if (id === SYSTEM_THEME) return THEMES.find((t) => t.id === (prefersDark ? "dark" : "light"))!;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** The CSS custom properties a theme sets on :root. Everything else is derived from these. */
export function themeVars(t: Theme): Record<string, string> {
  const u = t.ui;
  const dark = t.type === "dark";
  return {
    "--bg": u.background,
    "--text": u.foreground,
    "--text-2": u.mutedForeground,
    "--panel": u.sidebar,
    "--panel-2": u.card,
    "--toolbar": u.tertiary,
    "--control": u.secondary,
    "--control-hover": u.secondaryHover,
    "--border": u.border,
    "--sel": u.selection,
    "--primary": u.primary,
    "--primary-fg": u.primaryForeground,
    "--accent": u.highlight,
    "--red": u.destructive,
    "--orange": u.warning,
    "--green": u.success,
    "--blue": t.syntax.keyword,
    "--purple": t.syntax.special,
    "--kw": t.syntax.keyword,
    "--str": t.syntax.string,
    "--num": t.syntax.number,
    "--comment": t.syntax.comment,
    "--shadow": dark
      ? "0 0 0 1px rgb(255 255 255 / 0.06), 0 2px 6px rgb(0 0 0 / 0.35), 0 16px 48px rgb(0 0 0 / 0.55)"
      : "0 0 0 1px rgb(20 20 30 / 0.07), 0 2px 6px rgb(20 20 30 / 0.07), 0 16px 40px rgb(20 20 30 / 0.15)",
    "--shadow-sm": dark ? "0 0 0 1px rgb(255 255 255 / 0.05), 0 1px 2px rgb(0 0 0 / 0.4)" : "0 0 0 1px rgb(20 20 30 / 0.07), 0 1px 2px rgb(20 20 30 / 0.06)",
    "--backdrop": dark ? "rgb(5 4 4 / 0.6)" : "rgb(20 20 30 / 0.3)",
  };
}
