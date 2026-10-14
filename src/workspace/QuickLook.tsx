import { useMemo, useState } from "react";
import type { Cell, ColumnMeta } from "../api";
import { Modal, mod } from "../components/ui";

/** Large editor for one cell value, with JSON pretty-printing (TablePlus "Quick Look Editor"). */
export function QuickLook({
  column,
  value,
  editable,
  onSave,
  onClose,
}: {
  column: ColumnMeta;
  value: Cell;
  editable: boolean;
  onSave: (v: Cell) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value ?? "");
  const [isNull, setIsNull] = useState(value === null);
  const json = useMemo(() => {
    try {
      const v = JSON.parse(text);
      return typeof v === "object" && v !== null ? v : null;
    } catch {
      return null;
    }
  }, [text]);
  const save = () => {
    onSave(isNull ? null : text);
    onClose();
  };
  return (
    <Modal
      title={`${column.name}${column.typeName ? ` · ${column.typeName}` : ""}`}
      width={720}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12 }}>{isNull ? "NULL" : `${text.length.toLocaleString()} characters`}</span>
          {json && (
            <>
              <button className="btn" disabled={!editable} onClick={() => setText(JSON.stringify(json, null, 2))}>Pretty JSON</button>
              <button className="btn" disabled={!editable} onClick={() => setText(JSON.stringify(json))}>Minify</button>
            </>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => navigator.clipboard.writeText(isNull ? "NULL" : text)}>Copy</button>
          {editable && <button className="btn" onClick={() => setIsNull(true)}>Set NULL</button>}
          <button className="btn" onClick={onClose}>{editable ? "Cancel" : "Close"}</button>
          {editable && <button className="btn primary" onClick={save}>Update {mod}↵</button>}
        </>
      }
    >
      <textarea
        className="input mono"
        autoFocus
        readOnly={!editable}
        spellCheck={false}
        value={isNull ? "" : text}
        placeholder={isNull ? "NULL" : ""}
        onChange={(e) => {
          setIsNull(false);
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && editable) {
            e.preventDefault();
            save();
          }
        }}
        style={{ width: "100%", height: "52vh", padding: 10, lineHeight: 1.5, resize: "none" }}
      />
    </Modal>
  );
}
