import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleBlockComment } from "@codemirror/commands";
import { autocompletion, closeBrackets, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, HighlightStyle, syntaxHighlighting, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { sql, PostgreSQL, MySQL, SQLite } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import type { Driver } from "../api";
import { useSettings } from "../lib/settings";

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--kw)" },
  { tag: [t.string, t.special(t.string)], color: "var(--str)" },
  { tag: [t.number, t.bool, t.null], color: "var(--num)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--kw)" },
  { tag: t.special(t.name), color: "var(--purple)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size, 12.5px)", backgroundColor: "var(--bg)", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--text)", padding: "6px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text-3)", border: "none", paddingLeft: "6px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 4%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-tooltip": { backgroundColor: "var(--panel-2)", border: "1px solid var(--border-soft)", borderRadius: "6px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "#fff" },
  ".cm-placeholder": { color: "var(--text-3)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
});

export interface SqlEditorHandle {
  getValue: () => string;
  setValue: (v: string) => void;
  getSelection: () => { from: number; to: number; head: number; text: string };
  replaceRange: (from: number, to: number, text: string) => void;
  focus: () => void;
  find: () => void;
}

interface Props {
  value: string;
  driver: Driver;
  tables: string[];
  onChange: (v: string) => void;
  onCursor: (line: number, col: number, pos: number) => void;
  onRunCurrent: () => void;
  onRunAll: () => void;
  onBeautify: () => void;
  onSave: () => void;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const lang = useRef(new Compartment());
  const brackets = useRef(new Compartment());
  const settings = useSettings();
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const run = (fn: () => void) => () => {
      fn();
      return true;
    };
    const shortcuts = Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: run(() => cb.current.onRunCurrent()) },
        { key: "Mod-Shift-Enter", run: run(() => cb.current.onRunAll()) },
        { key: "Mod-i", run: run(() => cb.current.onBeautify()) },
        { key: "Mod-s", run: run(() => cb.current.onSave()) },
        { key: "Mod-Alt-/", run: toggleBlockComment },
      ]),
    );
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          shortcuts,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          brackets.current.of(settings.closeBrackets ? closeBrackets() : []),
          autocompletion({ activateOnTyping: true }),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          placeholder("-- Write your SQL here. ⌘↵ runs the statement under the cursor."),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          lang.current.of(sql({ dialect: props.driver === "mysql" ? MySQL : props.driver === "sqlite" ? SQLite : PostgreSQL, upperCaseKeywords: settings.uppercaseKeywords })),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const pos = u.state.selection.main.head;
              const line = u.state.doc.lineAt(pos);
              cb.current.onCursor(line.number, pos - line.from + 1, pos);
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const schema = Object.fromEntries(props.tables.map((t) => [t, [] as string[]]));
    view.current?.dispatch({
      effects: [
        lang.current.reconfigure(
          sql({ dialect: props.driver === "mysql" ? MySQL : props.driver === "sqlite" ? SQLite : PostgreSQL, schema, upperCaseKeywords: settings.uppercaseKeywords }),
        ),
        brackets.current.reconfigure(settings.closeBrackets ? closeBrackets() : []),
      ],
    });
  }, [props.tables, props.driver, settings.uppercaseKeywords, settings.closeBrackets]);

  useImperativeHandle(ref, () => ({
    getValue: () => view.current?.state.doc.toString() ?? "",
    setValue: (text) => {
      const v = view.current;
      if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    getSelection: () => {
      const v = view.current!;
      const { from, to, head } = v.state.selection.main;
      return { from, to, head, text: v.state.sliceDoc(from, to) };
    },
    replaceRange: (from, to, text) => view.current?.dispatch({ changes: { from, to, insert: text } }),
    focus: () => view.current?.focus(),
    find: () => view.current && openSearchPanel(view.current),
  }));

  return <div ref={host} style={{ height: "100%", overflow: "hidden" }} />;
});
