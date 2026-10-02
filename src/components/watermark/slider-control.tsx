'use client';

import * as React from 'react';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Coarse step used by the slider (e.g. 0.01 for floats, 1 for pixels). */
  sliderStep: number;
  /** Fine step used by arrow keys / wheel on the input box (0.001). */
  inputStep?: number;
  suffix?: string;
  /** Number of decimals kept when normalizing typed values. */
  decimals?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** Format a value with up to `decimals` decimals, trimming trailing zeros. */
function fmt(value: number, decimals: number): string {
  const v = Number.isFinite(value) ? value : 0;
  return String(parseFloat(v.toFixed(decimals)));
}

const COMPLETE_NUMBER_RE = /^-?\d+\.?\d*$|^-?\.\d+$/;

export function SliderControl({
  label,
  value,
  min,
  max,
  sliderStep,
  inputStep = 0.001,
  suffix,
  decimals = 3,
  disabled,
  onChange,
}: SliderControlProps) {
  const [text, setText] = React.useState(() => fmt(value, decimals));
  const focused = React.useRef(false);
  const inputId = React.useId();

  // Sync box text when the value changes externally (slider, preset, reset).
  React.useEffect(() => {
    if (!focused.current) {
      setText(fmt(value, decimals));
    }
  }, [value, decimals]);

  const clampAndEmit = React.useCallback(
    (raw: string) => {
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed)) return false;
      const clamped = Math.min(max, Math.max(min, parsed));
      const normalized = parseFloat(clamped.toFixed(decimals));
      onChange(normalized);
      setText(fmt(normalized, decimals));
      return true;
    },
    [min, max, decimals, onChange],
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    // Live-apply only complete numbers; partial input ("-", "0.") waits for blur.
    if (raw !== '' && COMPLETE_NUMBER_RE.test(raw)) {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
        onChange(parseFloat(parsed.toFixed(decimals)));
      }
    }
  };

  const handleBlur = () => {
    focused.current = false;
    if (text.trim() === '' || !clampAndEmit(text)) {
      setText(fmt(value, decimals));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const base = parseFloat(text);
      const from = Number.isFinite(base) ? base : value;
      const next = from + dir * inputStep * (e.shiftKey ? 100 : 10);
      clampAndEmit(String(next));
    }
  };

  return (
    <div className="group">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-[13px] font-medium text-foreground/90 select-none"
        >
          {label}
        </label>
        <div className="relative flex items-center">
          <Input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className={cn(
              'h-7 w-[76px] rounded-md border bg-background/60 px-2 pr-6 text-right font-mono text-[12px] tabular-nums',
              'hover:border-muted-foreground/40 focus-visible:ring-1',
            )}
            value={text}
            onFocus={() => (focused.current = true)}
            onChange={handleTextChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            aria-label={`${label} exact value`}
          />
          {suffix ? (
            <span className="pointer-events-none absolute right-2 font-mono text-[10px] text-muted-foreground">
              {suffix}
            </span>
          ) : null}
        </div>
      </div>
      <Slider
        min={min}
        max={max}
        step={sliderStep}
        value={[Math.min(max, Math.max(min, value))]}
        disabled={disabled}
        onValueChange={(vals) => {
          const v = vals[0];
          onChange(parseFloat(v.toFixed(decimals)));
          setText(fmt(v, decimals));
        }}
        className="cursor-pointer py-1"
        aria-label={label}
      />
      <div className="mt-0.5 flex justify-between font-mono text-[10px] text-muted-foreground/70">
        <span>{fmt(min, decimals)}</span>
        <span>{fmt(max, decimals)}</span>
      </div>
    </div>
  );
}
