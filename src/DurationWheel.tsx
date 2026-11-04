import { useEffect, useRef, useState } from 'react';

const ROW = 40;
const MAX_MINUTES = 1440;

/** One drum of the wheel: scrolls and snaps to a row; a tap or the arrow keys work too. */
function Drum({ label, testId, options, value, unit, onChange }: { label: string; testId: string; options: number[]; value: number; unit: string; onChange: (value: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const settle = useRef(0);
  const first = useRef(true);
  const index = Math.max(0, options.indexOf(value));

  // Follows the value; the first time without the animation.
  useEffect(() => {
    const element = list.current;
    if (element && Math.round(element.scrollTop / ROW) !== index) element.scrollTo({ top: index * ROW, behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [index]);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  const onScroll = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const next = options[Math.min(options.length - 1, Math.max(0, Math.round((list.current?.scrollTop ?? 0) / ROW)))];
      if (next !== value) onChange(next);
    }, 90);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    onChange(options[Math.min(options.length - 1, Math.max(0, index + step))]);
  };

  return <div ref={list} className="wheel-drum" role="spinbutton" tabIndex={0} aria-label={label} aria-valuenow={value} aria-valuetext={`${value} ${unit}`} aria-valuemin={options[0]} aria-valuemax={options[options.length - 1]} data-testid={testId} onScroll={onScroll} onKeyDown={onKeyDown}>
    {options.map((option) => <button type="button" tabIndex={-1} key={option} className={option === value ? 'selected' : ''} onClick={() => onChange(option)}>{option} {unit}</button>)}
  </div>;
}

export const durationText = (minutes: number) => [Math.floor(minutes / 60) && `${Math.floor(minutes / 60)} ч`, minutes % 60 && `${minutes % 60} мин`].filter(Boolean).join(' ') || '0 мин';

/** The time of a service as on a phone's alarm clock: hours and minutes on two drums, nothing to mistype. */
export function DurationWheel({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  // Every 5 minutes, plus an exact value a service already has.
  const [minuteOptions] = useState(() => [...new Set([...Array.from({ length: 12 }, (_, at) => at * 5), rest])].sort((left, right) => left - right));
  const set = (nextHours: number, nextMinutes: number) => onChange(Math.min(MAX_MINUTES, nextHours * 60 + nextMinutes));
  return <div className="duration-wheel" data-testid="service-duration">
    <span className="wheel-band" aria-hidden="true"/>
    <Drum label="Часы" testId="duration-hours" unit="ч" options={Array.from({ length: 25 }, (_, at) => at)} value={hours} onChange={(value) => set(value, rest)}/>
    <Drum label="Минуты" testId="duration-minutes" unit="мин" options={minuteOptions} value={rest} onChange={(value) => set(hours, value)}/>
  </div>;
}
