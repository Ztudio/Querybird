import type { CSSProperties, ComponentType } from "react";
import {
  ArrowRight, ArrowUp, ArrowDown, Check, ChatCircle, Circle, Palette, ArrowLineDown, ArrowLineUp, CaretDown, CaretLeft, CaretRight, ChartBar, Code, Cube, Database, DotsThree,
  Eye, Function as PhFunction, Gear, ListBullets, Lock, LockOpen, MagnifyingGlass, Minus, PencilSimple, Plugs, Plus,
  ArrowsClockwise, SlidersHorizontal, SquareHalfBottom, Table, Terminal, Trash, UsersThree, X, Columns, FileSql,
  ClockCounterClockwise, BookmarkSimple, ShieldCheck, Power, Info, SidebarSimple as PhSidebar, FolderSimple,
  type IconProps,
} from "@phosphor-icons/react";

type P = { size?: number; style?: CSSProperties; className?: string };

/** One icon family (Phosphor, regular weight) so every glyph shares stroke, corner and optical size. */
const mk = (Cmp: ComponentType<IconProps>, def: number, extra: Partial<IconProps> = {}) =>
  function Icon({ size = def, style, className }: P) {
    return <Cmp size={size} weight="regular" style={style} className={className} aria-hidden {...extra} />;
  };

export const IconSearch = mk(MagnifyingGlass, 14);
export const IconPlus = mk(Plus, 14);
/** Ask AI is a conversation, so it gets a chat bubble rather than a sparkle. */
export const IconChat = mk(ChatCircle, 14);
export const IconCheck = mk(Check, 14, { weight: "bold" });
export const IconPalette = mk(Palette, 16);
export const IconSortUp = mk(ArrowUp, 10, { weight: "bold" });
export const IconSortDown = mk(ArrowDown, 10, { weight: "bold" });
export const IconDot = mk(Circle, 8, { weight: "fill" });
export const IconMinus = mk(Minus, 12);
export const IconPlug = mk(Plugs, 16);
export const IconClose = mk(X, 16);
export const IconX = mk(X, 12);
export const IconEye = mk(Eye, 16);
export const IconList = mk(ListBullets, 16);
export const IconLock = mk(Lock, 16);
export const IconUnlock = mk(LockOpen, 16);
export const IconDatabase = mk(Database, 16);
export const IconChart = mk(ChartBar, 16);
export const IconRefresh = mk(ArrowsClockwise, 16);
export const IconMore = mk(DotsThree, 18, { weight: "bold" });
export const IconSidebarLeft = mk(PhSidebar, 18);
export const IconSidebarRight = mk(PhSidebar, 18, { mirrored: true });
export const IconSidebarBottom = mk(SquareHalfBottom, 18);
export const IconChevronDown = mk(CaretDown, 12);
export const IconLeft = mk(CaretLeft, 14);
export const IconRight = mk(CaretRight, 14);
export const IconSliders = mk(SlidersHorizontal, 14);
export const IconUsers = mk(UsersThree, 16);
export const IconPencil = mk(PencilSimple, 14);
export const IconArrowUp = mk(ArrowUp, 14, { weight: "bold" });
export const IconTrash = mk(Trash, 14);
export const IconSplit = mk(Columns, 14);
export const IconArrow = mk(ArrowRight, 10);
export const IconGear = mk(Gear, 16);
export const IconTerminal = mk(Terminal, 16);
export const IconShield = mk(ShieldCheck, 16);
export const IconPower = mk(Power, 16);
export const IconInfo = mk(Info, 16);
export const IconFolder = mk(FolderSimple, 14);
export const IconHistory = mk(ClockCounterClockwise, 14);
export const IconBookmark = mk(BookmarkSimple, 14);
export const IconCode = mk(Code, 14);

/** Sidebar object icons are monochrome: the label and the active row carry the meaning, not a color. */
export const IconTable = mk(Table, 14);
export const IconView = mk(Eye, 14);
export const IconFunction = mk(PhFunction, 14);
export const IconQuery = mk(FileSql, 14);

export const IconBox = ({ down, size = 16, ...p }: P & { down: boolean }) => {
  const Cmp = down ? ArrowLineDown : ArrowLineUp;
  return <Cmp size={size} weight="regular" aria-hidden {...p} />;
};
export const IconCube = mk(Cube, 16);

export const IconChevron = ({ size = 12, open = false, style, className }: P & { open?: boolean }) => (
  <CaretRight
    size={size}
    weight="bold"
    aria-hidden
    className={className}
    style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 150ms cubic-bezier(0.23, 1, 0.32, 1)", ...style }}
  />
);
