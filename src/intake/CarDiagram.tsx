import { useId } from 'react';
import type { CarLayout, LayoutElement } from '../shared/carLayouts';
import type { IntakeFinding } from '../types';

type Severity = IntakeFinding['severity'];
const RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** Worst severity and the number of findings per element name. */
export function findingMarks(findings: Array<{ zone: string; severity: Severity }>) {
  const marks = new Map<string, { count: number; severity: Severity }>();
  for (const finding of findings) {
    const current = marks.get(finding.zone);
    marks.set(finding.zone, {
      count: (current?.count ?? 0) + 1,
      severity: current && RANK[current.severity] >= RANK[finding.severity] ? current.severity : finding.severity
    });
  }
  return marks;
}

/**
 * Top view of the car with every element numbered. Interactive at intake (tap selects an element),
 * static in the intake act. Elements with findings are tinted by their worst severity.
 */
export function CarDiagram({ layout, marks, selected, onSelect, className = '' }: {
  layout: CarLayout;
  marks: Map<string, { count: number; severity: Severity }>;
  selected?: string | null;
  onSelect?: (element: LayoutElement) => void;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const drawn = layout.elements.filter((element) => element.d);
  const outside = drawn.filter((element) => element.group === 'wheel' || element.group === 'mirror');
  const panels = drawn.filter((element) => element.group === 'body' || element.group === 'glass');
  const state = (element: LayoutElement) => {
    const mark = marks.get(element.name);
    return [`part-${element.group}`, element.id === 'bed' ? 'part-bed' : '', selected === element.id ? 'selected' : '', mark ? `marked severity-${mark.severity.toLowerCase()}` : ''].join(' ');
  };
  const part = (element: LayoutElement) => (
    <path key={element.id} d={element.d} className={`car-part ${state(element)}`} data-testid={`car-part-${element.id}`}
      role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={`${element.number}. ${element.name}`}
      aria-pressed={onSelect ? selected === element.id : undefined}
      onClick={onSelect ? () => onSelect(element) : undefined}
      onKeyDown={onSelect ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(element); } } : undefined}/>
  );

  return (
    <svg className={`car-diagram ${className}`} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Схема автомобиля, вид сверху" data-interactive={onSelect ? '' : undefined}>
      <defs>
        <linearGradient id={`${id}-paint`} x1="0" x2="1"><stop offset="0" stopColor="#4b545b"/><stop offset=".35" stopColor="#8d969c"/><stop offset=".5" stopColor="#a7afb4"/><stop offset=".65" stopColor="#8d969c"/><stop offset="1" stopColor="#4b545b"/></linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2f3e49"/><stop offset="1" stopColor="#11191f"/></linearGradient>
        <clipPath id={`${id}-clip`}><path d={layout.outline}/></clipPath>
      </defs>
      <g style={{ ['--paint' as string]: `url(#${id}-paint)`, ['--glass' as string]: `url(#${id}-glass)` }}>
        {outside.map(part)}
        <path d={layout.outline} className="car-shell"/>
        <g clipPath={`url(#${id}-clip)`}>{panels.map(part)}</g>
        <path d={layout.details} className="car-details" clipPath={`url(#${id}-clip)`}/>
        <path d={layout.outline} className="car-outline"/>
        {drawn.map((element) => {
          const mark = marks.get(element.name);
          return <g key={element.id} className={`car-badge ${element.group === 'wheel' || element.group === 'mirror' ? 'outside' : ''} ${mark ? `marked severity-${mark.severity.toLowerCase()}` : ''} ${selected === element.id ? 'selected' : ''}`}
            onClick={onSelect ? () => onSelect(element) : undefined} aria-hidden="true">
            <circle cx={element.label!.x} cy={element.label!.y} r="7"/>
            <text x={element.label!.x} y={element.label!.y + 2.7}>{element.number}</text>
            {mark && mark.count > 1 && <><circle className="car-badge-count" cx={element.label!.x + 6} cy={element.label!.y - 6} r="4"/><text className="car-badge-count-text" x={element.label!.x + 6} y={element.label!.y - 4.4}>{mark.count}</text></>}
          </g>;
        })}
      </g>
    </svg>
  );
}
