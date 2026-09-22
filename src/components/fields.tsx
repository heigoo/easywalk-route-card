/**
 * 表单字段（需求 A07、D07、14.4）：
 * - 空白＝未知（null），不自动改成 0；
 * - 非法输入保留在草稿中，就地提示错误，不写入领域模型；
 * - 分钟输入在提交时转为内部秒。
 */
import { useEffect, useState } from 'react';
import editor from '../features/itinerary/Editor.module.css';

export interface MinutesFieldProps {
  id: string;
  label: string;
  valueSeconds: number | null;
  onCommit: (seconds: number | null) => void;
  hint?: string;
}

export function parseMinutesInput(text: string): { ok: true; seconds: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === '') return { ok: true, seconds: null };
  if (!/^\d+$/.test(t)) return { ok: false, error: '请输入非负整数分钟，或留空表示未知' };
  const m = Number(t);
  if (!Number.isSafeInteger(m) || m > 24 * 60) return { ok: false, error: '数值过大' };
  return { ok: true, seconds: m * 60 };
}

export function MinutesField({ id, label, valueSeconds, onCommit, hint }: MinutesFieldProps) {
  const [text, setText] = useState(valueSeconds === null ? '' : String(valueSeconds / 60));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(valueSeconds === null ? '' : String(valueSeconds / 60));
    setError(null);
  }, [valueSeconds]);

  const commit = () => {
    const parsed = parseMinutesInput(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.seconds !== valueSeconds) onCommit(parsed.seconds);
  };

  return (
    <div className={editor.field}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={text}
        placeholder="未知"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {error ? (
        <span className={editor.fieldError} id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className={editor.fieldError} style={{ color: 'var(--text-muted)' }} id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
}

export function TextField({ id, label, value, onCommit, placeholder }: TextFieldProps) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className={editor.field}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== value) onCommit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}
