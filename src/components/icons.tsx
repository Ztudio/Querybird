import type { CSSProperties } from "react";

type P = { size?: number; style?: CSSProperties; className?: string };
const base = (size = 16) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconSearch = ({ size = 13, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
);
export const IconPlus = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M8 3v10M3 8h10" /></svg>
);
export const IconSparkle = ({ size = 13, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M8 1.8 9.3 6l4.2 1.3-4.2 1.3L8 12.8 6.7 8.6 2.5 7.3 6.7 6zM12.6 11.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" /></svg>
);
export const IconMinus = ({ size = 10, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 8h10" /></svg>
);
export const IconPlug = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.3" /><path d="M6.3 4.8v2.2M9.7 4.8v2.2M5.3 7h5.4v1.3a2.7 2.7 0 0 1-5.4 0zM8 11v1.6" /></svg>
);
export const IconClose = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.3" /><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" /></svg>
);
export const IconX = ({ size = 10, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="m4 4 8 8m0-8-8 8" /></svg>
);
export const IconEye = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
);
export const IconList = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M2.5 4h11M2.5 7h11M2.5 10h7M2.5 13h5" /></svg>
);
export const IconLock = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1.3" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
);
export const IconUnlock = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1.3" /><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" /></svg>
);
export const IconDatabase = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" /></svg>
);
export const IconChart = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M2.5 13.5h11M4.5 11V8M7.5 11V5M10.5 11V7M13 11V3.5" /></svg>
);
export const IconRefresh = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></svg>
);
export const IconMore = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="8" cy="3.5" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="12.5" r=".6" fill="currentColor" /></svg>
);
export const IconSidebarLeft = ({ size = 18, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M5.5 2.5v11" /><path d="M2.6 4.5h1.8M2.6 6.5h1.8" /></svg>
);
export const IconSidebarBottom = ({ size = 18, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M1.5 10h13" /></svg>
);
export const IconSidebarRight = ({ size = 18, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10.5 2.5v11" /><path d="M11.6 4.5h1.8M11.6 6.5h1.8" /></svg>
);
export const IconChevron = ({ size = 10, open = false, ...p }: P & { open?: boolean }) => (
  <svg {...base(size)} {...p} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s", ...p.style }}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);
export const IconChevronDown = ({ size = 10, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="m3.5 6 4.5 4.5L12.5 6" /></svg>
);
export const IconLeft = ({ size = 12, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M10 3 5 8l5 5" /></svg>
);
export const IconRight = ({ size = 12, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="m6 3 5 5-5 5" /></svg>
);
export const IconSliders = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M2 4.5h12M2 8h12M2 11.5h12" /><circle cx="5" cy="4.5" r="1.4" fill="var(--panel)" /><circle cx="10.5" cy="8" r="1.4" fill="var(--panel)" /><circle cx="7" cy="11.5" r="1.4" fill="var(--panel)" /></svg>
);
export const IconTrash = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" /></svg>
);
export const IconSplit = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M8 2.5v11" /></svg>
);
export const IconArrow = ({ size = 9, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M2 8h11M9 4l4 4-4 4" /></svg>
);

export const IconTable = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16">
    <rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="#3d7ac2" />
    <path d="M1.5 6h13M1.5 10h13M6 6v8M10.5 6v8" stroke="#bcd6f5" strokeWidth="1" />
  </svg>
);
export const IconView = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="6.5" fill="#9a5cc8" />
    <path d="M3.5 8S5.3 5 8 5s4.5 3 4.5 3-1.8 3-4.5 3-4.5-3-4.5-3z" fill="none" stroke="#efdcff" strokeWidth="1" />
    <circle cx="8" cy="8" r="1.2" fill="#efdcff" />
  </svg>
);
export const IconFunction = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16">
    <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="#3f9b6a" />
    <text x="8" y="11.6" textAnchor="middle" fontSize="9.5" fontStyle="italic" fontFamily="Georgia, serif" fill="#e2fff0">f</text>
  </svg>
);
export const IconQuery = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16">
    <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="#6f7782" />
    <path d="M5 5h6M5 8h6M5 11h4" stroke="#e9edf2" strokeWidth="1" />
  </svg>
);
