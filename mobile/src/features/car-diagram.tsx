import { useId } from 'react';
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import type { CarLayout, LayoutElement } from '@df/shared/carLayouts';
import type { IntakeFinding } from '@df/types';

type Severity = IntakeFinding['severity'];
export type Marks = Map<string, { count: number; severity: Severity }>;
const RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** The same tints as the web app: the part, and the darker number badge. */
export const SEVERITY = {
  LOW: { label: 'Лёгкое', part: '#c9a33a', badge: '#8f7220' },
  MEDIUM: { label: 'Среднее', part: '#e07a3a', badge: '#b9561d' },
  HIGH: { label: 'Сильное', part: '#d9443d', badge: '#b8302a' }
} as const;

/** Worst severity and the number of findings per element name. */
export function findingMarks(findings: { zone: string; severity: Severity }[]): Marks {
  const marks: Marks = new Map();
  for (const finding of findings) {
    const current = marks.get(finding.zone);
    marks.set(finding.zone, {
      count: (current?.count ?? 0) + 1,
      severity: current && RANK[current.severity] >= RANK[finding.severity] ? current.severity : finding.severity
    });
  }
  return marks;
}

const SELECTED = 'rgba(255,121,57,.9)';

/** The car in the app (dark, metallic) and on a printed act (light, as in the web act). */
export const PALETTES = {
  dark: { shell: '#6f787e', wheel: '#262d32', mirror: '#5a6369', bed: '#2c3439', stroke: '#252d33', glassStroke: '#6f7a82', wheelStroke: '#7a848b',
    details: 'rgba(20,26,30,.55)', outline: '#cdd2d5', marks: { LOW: SEVERITY.LOW.part, MEDIUM: SEVERITY.MEDIUM.part, HIGH: SEVERITY.HIGH.part } },
  paper: { shell: '#e7e5df', wheel: '#3a3f43', mirror: '#bfc3c4', bed: '#d5d2cb', stroke: '#6a7075', glassStroke: '#6a7075', wheelStroke: '#6a7075',
    details: 'rgba(22,25,28,.35)', outline: '#16191c', marks: { LOW: '#f0d27a', MEDIUM: '#f4a26f', HIGH: '#ec7b74' } }
} as const;

/**
 * Top view of the car with every element numbered (the web diagram drawn with native SVG).
 * With `onSelect` a tap on a panel or its number selects it; without, it is a static picture.
 */
export function CarDiagram({ layout, marks, selected, onSelect, width = 290, palette = 'dark' }: {
  layout: CarLayout;
  marks: Marks;
  selected?: string | null;
  onSelect?: (element: LayoutElement) => void;
  width?: number;
  palette?: keyof typeof PALETTES;
}) {
  const tone = PALETTES[palette];
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const drawn = layout.elements.filter((element) => element.d);
  const outside = drawn.filter((element) => element.group === 'wheel' || element.group === 'mirror');
  const panels = drawn.filter((element) => element.group === 'body' || element.group === 'glass');
  const press = (element: LayoutElement) => onSelect ? () => onSelect(element) : undefined;

  const fill = (element: LayoutElement) => {
    if (selected === element.id) return SELECTED;
    const mark = marks.get(element.name);
    if (mark) return tone.marks[mark.severity];
    if (element.group === 'glass') return palette === 'paper' ? '#c9d3da' : `url(#${id}glass)`;
    if (element.group === 'wheel') return tone.wheel;
    if (element.group === 'mirror') return tone.mirror;
    return element.id === 'bed' ? tone.bed : palette === 'paper' ? '#f1efea' : `url(#${id}paint)`;
  };
  const part = (element: LayoutElement) => {
    const glass = element.group === 'glass' || element.group === 'wheel';
    return <Path key={element.id} d={element.d!} fill={fill(element)} onPress={press(element)}
      stroke={selected === element.id ? '#ffd2bb' : glass ? (element.group === 'wheel' ? tone.wheelStroke : tone.glassStroke) : tone.stroke}
      strokeWidth={selected === element.id ? 1.4 : 0.8} strokeLinejoin="round"/>;
  };

  return (
    <Svg width={width} height={width * layout.height / layout.width} viewBox={`0 0 ${layout.width} ${layout.height}`}
      accessibilityLabel="Схема автомобиля, вид сверху">
      <Defs>
        <LinearGradient id={`${id}paint`} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#4b545b"/><Stop offset=".35" stopColor="#8d969c"/><Stop offset=".5" stopColor="#a7afb4"/><Stop offset=".65" stopColor="#8d969c"/><Stop offset="1" stopColor="#4b545b"/>
        </LinearGradient>
        <LinearGradient id={`${id}glass`} x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#2f3e49"/><Stop offset="1" stopColor="#11191f"/></LinearGradient>
        <ClipPath id={`${id}clip`}><Path d={layout.outline}/></ClipPath>
      </Defs>
      {outside.map(part)}
      <Path d={layout.outline} fill={tone.shell}/>
      <G clipPath={`url(#${id}clip)`}>{panels.map(part)}</G>
      <Path d={layout.details} fill="none" stroke={tone.details} strokeWidth={0.7} strokeLinecap="round" clipPath={`url(#${id}clip)`}/>
      <Path d={layout.outline} fill="none" stroke={tone.outline} strokeWidth={1.1}/>
      {drawn.map((element) => {
        const mark = marks.get(element.name);
        const { x, y } = element.label!;
        const isSelected = selected === element.id;
        return (
          <G key={element.id} onPress={press(element)}>
            <Circle cx={x} cy={y} r={7} fill={isSelected ? '#ff7939' : mark ? SEVERITY[mark.severity].badge : 'rgba(14,19,24,.88)'}
              stroke={isSelected || mark ? '#fff' : 'rgba(255,255,255,.55)'} strokeWidth={0.7}/>
            <SvgText x={x} y={y + 2.7} fill={isSelected ? '#17100c' : '#fff'} fontSize={7.5} fontWeight="800" textAnchor="middle">{element.number}</SvgText>
            {mark && mark.count > 1 ? <>
              <Circle cx={x + 6} cy={y - 6} r={4} fill="#fff"/>
              <SvgText x={x + 6} y={y - 4.4} fill="#17100c" fontSize={5.5} fontWeight="800" textAnchor="middle">{mark.count}</SvgText>
            </> : null}
          </G>
        );
      })}
    </Svg>
  );
}
