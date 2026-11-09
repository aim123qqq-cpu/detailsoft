import { useId } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Path, Text as SvgText } from 'react-native-svg';
import type { CarLayout, LayoutElement } from '@df/shared/carLayouts';
import type { IntakeFinding } from '@df/types';
import { useTheme, type Palette } from '@/lib/theme';

type Severity = IntakeFinding['severity'];
export type Marks = Map<string, { count: number; severity: Severity }>;
const RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** Damage: the colour is the severity, so the word always goes with it. */
export const SEVERITY = {
  LOW: { label: 'Лёгкое' },
  MEDIUM: { label: 'Среднее' },
  HIGH: { label: 'Серьёзное' }
} as const;

/** The pin colour of a severity, and the tint of a damaged panel, in the current theme. */
export const severityColor = (colors: Palette, severity: Severity) => ({ LOW: colors.sevLo, MEDIUM: colors.sevMid, HIGH: colors.sevHi })[severity];
export const severityTint = (colors: Palette, severity: Severity) => ({ LOW: colors.carTintLo, MEDIUM: colors.carTintMid, HIGH: colors.carTintHi })[severity];

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

/** A printed act: light, every element numbered, as in the web act. */
export const PALETTES = {
  paper: { shell: '#e7e5df', wheel: '#3a3f43', mirror: '#bfc3c4', bed: '#d5d2cb', stroke: '#6a7075', glassStroke: '#6a7075', wheelStroke: '#6a7075',
    details: 'rgba(22,25,28,.35)', outline: '#16191c', marks: { LOW: '#f0d27a', MEDIUM: '#f4a26f', HIGH: '#ec7b74' } }
} as const;

/**
 * Top view of the car, drawn in separate panels. On a screen it follows the theme: white panels with a grey
 * line, a damaged panel tinted by severity and a round pin with its number; the chosen one orange.
 * `palette="paper"` is the printed act, every element numbered. With `onSelect` a tap selects a panel.
 */
export function CarDiagram({ layout, marks, selected, onSelect, width = 290, palette = 'theme' }: {
  layout: CarLayout;
  marks: Marks;
  selected?: string | null;
  onSelect?: (element: LayoutElement) => void;
  width?: number;
  palette?: 'theme' | 'paper';
}) {
  const { colors } = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const drawn = layout.elements.filter((element) => element.d);
  const outside = drawn.filter((element) => element.group === 'wheel' || element.group === 'mirror');
  const panels = drawn.filter((element) => element.group === 'body' || element.group === 'glass');
  const press = (element: LayoutElement) => onSelect ? () => onSelect(element) : undefined;
  const paper = palette === 'paper';
  const tone = PALETTES.paper;

  const fill = (element: LayoutElement) => {
    const mark = marks.get(element.name);
    if (paper) {
      if (mark) return tone.marks[mark.severity];
      if (element.group === 'glass') return '#c9d3da';
      if (element.group === 'wheel') return tone.wheel;
      if (element.group === 'mirror') return tone.mirror;
      return element.id === 'bed' ? tone.bed : '#f1efea';
    }
    if (selected === element.id) return colors.carSelected;
    if (mark) return severityTint(colors, mark.severity);
    if (element.group === 'glass') return colors.carGlass;
    if (element.group === 'wheel') return colors.carWheel;
    return colors.carPanel;
  };
  const part = (element: LayoutElement) => {
    const chosen = !paper && selected === element.id;
    return <Path key={element.id} d={element.d!} fill={fill(element)} onPress={press(element)}
      stroke={paper ? (element.group === 'wheel' ? tone.wheelStroke : tone.stroke) : chosen ? colors.accent : colors.carDraw}
      strokeWidth={chosen ? 2 : paper ? 0.8 : 0.9} strokeLinejoin="round"/>;
  };

  return (
    <Svg width={width} height={width * layout.height / layout.width} viewBox={`0 0 ${layout.width} ${layout.height}`}
      accessibilityLabel="Схема автомобиля, вид сверху">
      <Defs><ClipPath id={`${id}clip`}><Path d={layout.outline}/></ClipPath></Defs>
      {outside.map(part)}
      <Path d={layout.outline} fill={paper ? tone.shell : colors.carPanel} pointerEvents="none"/>
      <G clipPath={`url(#${id}clip)`}>{panels.map(part)}</G>
      <Path d={layout.details} fill="none" stroke={paper ? tone.details : colors.carDraw} strokeOpacity={paper ? 1 : 0.6} strokeWidth={0.7} strokeLinecap="round" clipPath={`url(#${id}clip)`} pointerEvents="none"/>
      <Path d={layout.outline} fill="none" stroke={paper ? tone.outline : colors.carDraw} strokeWidth={paper ? 1.1 : 1.3} pointerEvents="none"/>
      {/* Touch targets over each part's middle: on Android a tap does not reach paths inside the clipped group. */}
      {onSelect && !paper ? drawn.filter((element) => element.label).map((element) => (
        <Circle key={`hit-${element.id}`} cx={element.label!.x} cy={element.label!.y} r={13} fill={colors.ink} fillOpacity={0.001} onPress={press(element)}/>
      )) : null}
      {drawn.map((element) => {
        const mark = marks.get(element.name);
        const isSelected = selected === element.id;
        // On a screen only the marked and the chosen parts carry their number, as pins.
        if (!paper && !mark && !isSelected) return null;
        const { x, y } = element.label!;
        const pin = paper ? (mark ? '#16191c' : 'rgba(14,19,24,.88)') : isSelected ? colors.accent : severityColor(colors, mark!.severity);
        return (
          <G key={element.id} onPress={press(element)}>
            <Circle cx={x} cy={y} r={paper ? 7 : 8} fill={pin} stroke={paper ? '#fff' : colors.ground} strokeWidth={paper ? 0.7 : 2}/>
            <SvgText x={x} y={y + 2.8} fill="#FFFFFF" fontSize={paper ? 7.5 : 8} fontWeight="700" textAnchor="middle">{element.number}</SvgText>
            {mark && mark.count > 1 ? <>
              <Circle cx={x + 7} cy={y - 7} r={4.5} fill={paper ? '#fff' : colors.surface} stroke={pin} strokeWidth={1}/>
              <SvgText x={x + 7} y={y - 5.2} fill={paper ? '#17100c' : colors.ink} fontSize={6} fontWeight="700" textAnchor="middle">{mark.count}</SvgText>
            </> : null}
          </G>
        );
      })}
    </Svg>
  );
}
