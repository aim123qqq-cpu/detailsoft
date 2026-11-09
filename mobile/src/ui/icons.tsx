import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '@/lib/theme';

// The line icons of the design system: 24 × 24, stroke 1.8, round ends and corners, the colour of the text.
// An icon never sits in a coloured circle.

export type IconName = 'home' | 'calendar' | 'car' | 'person' | 'plus' | 'bell' | 'chat' | 'clock' | 'pin' | 'search' | 'phone'
  | 'chevronRight' | 'back' | 'check' | 'close' | 'more' | 'camera' | 'eye' | 'document' | 'gear' | 'team' | 'grid' | 'chart' | 'arrowUpRight';

const PATHS: Record<IconName, (props: { color: string }) => React.ReactNode> = {
  home: () => <Path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>,
  calendar: () => <><Rect x="4" y="5" width="16" height="15" rx="3"/><Path d="M4 10h16M9 3v4M15 3v4"/></>,
  car: () => <Path d="M5 15l1.5-5A2 2 0 0 1 8.4 8.5h7.2a2 2 0 0 1 1.9 1.5L19 15M4 15h16v3H4zM7 18v1.5M17 18v1.5"/>,
  person: () => <><Circle cx="12" cy="8" r="4"/><Path d="M4.5 20.5c1.5-3.6 4.4-5.5 7.5-5.5s6 1.9 7.5 5.5"/></>,
  plus: () => <Path d="M12 5v14M5 12h14"/>,
  bell: () => <Path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>,
  chat: () => <Path d="M4 12a8 8 0 1 1 3.2 6.4L4 19.5l1-3.4A8 8 0 0 1 4 12z"/>,
  clock: () => <><Circle cx="12" cy="12" r="8"/><Path d="M12 8v4l3 2"/></>,
  pin: () => <><Path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><Circle cx="12" cy="11" r="2"/></>,
  search: () => <><Circle cx="11" cy="11" r="6.5"/><Path d="M16 16l4 4"/></>,
  phone: () => <Path d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z"/>,
  chevronRight: () => <Path d="M10 6l6 6-6 6"/>,
  back: () => <Path d="M15 6l-6 6 6 6"/>,
  check: () => <Path d="M5 12.5l4.5 4.5L19 7.5"/>,
  close: () => <Path d="M6 6l12 12M18 6L6 18"/>,
  more: () => <><Circle cx="6" cy="12" r="1.2"/><Circle cx="12" cy="12" r="1.2"/><Circle cx="18" cy="12" r="1.2"/></>,
  camera: () => <><Path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><Circle cx="12" cy="13" r="3.5"/></>,
  eye: () => <><Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><Circle cx="12" cy="12" r="3"/></>,
  document: () => <><Path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><Path d="M14 3.5V8h4M9.5 12.5h5M9.5 16h5"/></>,
  gear: () => <><Circle cx="12" cy="12" r="3"/><Path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></>,
  team: () => <><Circle cx="9" cy="8.5" r="3.5"/><Path d="M3 19.5c1-3 3.3-4.5 6-4.5s5 1.5 6 4.5M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 15.3c1.6.6 2.8 2 3.5 4.2"/></>,
  grid: () => <><Rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><Rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><Rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><Rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></>,
  chart: () => <Path d="M5 20V10M10 20V4M15 20v-7M20 20v-4"/>,
  arrowUpRight: () => <Path d="M7 17L17 7M9 7h8v8"/>
};

export function Icon({ name, size = 22, color, strokeWidth = 1.8 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const { colors } = useTheme();
  const ink = color ?? colors.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]({ color: ink })}
    </Svg>
  );
}
