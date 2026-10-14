import { createContext, useContext } from "react";
import type { Cell, ColumnMeta, Driver, Filter, ObjectList } from "../api";
import type { MenuState } from "../components/ui";

export interface Details {
  columns: ColumnMeta[];
  row: Cell[] | null;
  editable: boolean;
  onChange?: (col: number, value: Cell) => void;
  info?: [string, string][];
  selectedCount?: number;
}

export interface TabApi {
  reload?: () => void;
  commit?: () => void;
  discard?: () => void;
  preview?: () => void;
  save?: () => void;
  toggleFilters?: () => void;
  insertRow?: () => void;
  duplicate?: () => void;
  undo?: () => void;
  redo?: () => void;
  showData?: () => void;
  showStructure?: () => void;
  find?: () => void;
  beautify?: () => void;
  runCurrent?: () => void;
  runAll?: () => void;
}

export interface Ctx {
  sessionId: string;
  connId: string;
  driver: Driver;
  schema: string;
  objects: ObjectList;
  safeMode: boolean;
  log: (sql: string) => void;
  addHistory: (sql: string) => void;
  toast: (text: string, error?: boolean) => void;
  setMenu: (m: MenuState | null) => void;
  openTable: (schema: string, table: string, opts?: { filters?: Filter[]; newTab?: boolean; view?: "data" | "structure" }) => void;
  openQuery: (sql: string, title?: string, run?: boolean) => void;
  setLoading: (delta: number) => void;
}

export const WorkspaceContext = createContext<Ctx | null>(null);
export const useWs = () => useContext(WorkspaceContext)!;
