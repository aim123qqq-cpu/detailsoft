import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { cardShadow, makeStyles, useTheme } from '@/lib/theme';

/**
 * The launch on the sign-in screen: the car drives in side-on, turns to face you, its glass fills orange,
 * and it settles into the white tile; then the name and the ways in come up one after another.
 * Once per app start; with «reduce motion» everything is simply there.
 */
const TOTAL = 2000;
const at = (ms: number) => ms / TOTAL;
const OUT = Easing.bezier(0.2, 0.8, 0.2, 1);
let played = false;

/** The clock of the launch: 0 → 1 over two seconds the first time, 1 straight away after that. */
export function useLaunch() {
  const [progress] = useState(() => new Animated.Value(played ? 1 : 0));
  useEffect(() => {
    if (played) return;
    let cancelled = false;
    const run = (reduce: boolean) => {
      if (cancelled) return;
      played = true;
      if (reduce) { progress.setValue(1); return; }
      Animated.timing(progress, { toValue: 1, duration: TOTAL, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }).start();
    };
    AccessibilityInfo.isReduceMotionEnabled().then(run, () => run(true));
    return () => { cancelled = true; };
  }, [progress]);
  return progress;
}

const between = (progress: Animated.Value, from: number, to: number, values: [number, number], easing = OUT) =>
  progress.interpolate({ inputRange: [at(from), at(to)], outputRange: values, extrapolate: 'clamp', easing });

/** A part of the screen that comes up from a little below once the mark has settled. */
export function Reveal({ progress, delay, style, children }: { progress: Animated.Value; delay: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const start = 1400 + delay;
  return (
    <Animated.View style={[style, { opacity: between(progress, start, start + 300, [0, 1]), transform: [{ translateY: between(progress, start, start + 300, [28, 0]) }] }]}>
      {children}
    </Animated.View>
  );
}

/** The mark of the launch, in its 112 px tile. */
export function LaunchMark({ progress }: { progress: Animated.Value }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const linear = Easing.linear;
  // Side-on: drives in, settles with a small bob, then turns away.
  const drive = between(progress, 0, 550, [-230, 0], Easing.bezier(0.15, 0.75, 0.25, 1));
  const bob = progress.interpolate({ inputRange: [at(520), at(580), at(640), at(700)], outputRange: [0, 5, -2, 0], extrapolate: 'clamp' });
  const sideTurn = between(progress, 700, 860, [0, 88], Easing.bezier(0.5, 0, 0.9, 0.5));
  const sideShown = progress.interpolate({ inputRange: [at(859), at(860)], outputRange: [1, 0], extrapolate: 'clamp' });
  const speed = progress.interpolate({ inputRange: [0, at(40), at(440), at(560)], outputRange: [0, 0.7, 0.7, 0], extrapolate: 'clamp' });
  const speedShift = between(progress, 0, 560, [0, -40], linear);
  // Facing you: turns in, then the glass fills from the bottom.
  const frontTurn = between(progress, 860, 1020, [-88, 0], Easing.bezier(0.1, 0.5, 0.4, 1));
  const frontShown = progress.interpolate({ inputRange: [at(859), at(860)], outputRange: [0, 1], extrapolate: 'clamp' });
  const glass = between(progress, 1020, 1200, [0.001, 1]);
  // Big in the middle of the screen at first, then up into its place; the tile grows under it.
  const lift = between(progress, 1250, 1600, [300, 0]);
  const grow = between(progress, 1250, 1600, [1.8, 1]);
  const tile = between(progress, 1300, 1600, [0, 1]);
  const tileScale = between(progress, 1300, 1600, [0.7, 1]);
  const deg = (value: Animated.AnimatedInterpolation<number>) => value.interpolate({ inputRange: [-90, 90], outputRange: ['-90deg', '90deg'] });

  return (
    <Animated.View style={[styles.box, { transform: [{ translateY: lift }, { scale: grow }] }]} accessible accessibilityLabel="DetailFlow">
      <Animated.View style={[StyleSheet.absoluteFill, styles.tile, { opacity: tile, transform: [{ scale: tileScale }] }]}/>
      <View style={styles.stage}>
        <Animated.View style={[styles.layer, { opacity: sideShown, transform: [{ translateX: drive }, { translateY: bob }, { perspective: 500 }, { rotateY: deg(sideTurn) }] }]}>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: speed, transform: [{ translateX: speedShift }] }]}>
            <Svg width={84} height={84} viewBox="276 316 472 472" style={styles.visible}>
              <Path d="M210 470H150M230 540H120M200 610H160" fill="none" stroke={colors.muted} strokeWidth={26} strokeLinecap="round"/>
            </Svg>
          </Animated.View>
          <Svg width={84} height={84} viewBox="276 316 472 472" style={styles.visible}>
            <Path d="M424 506L458 466H576L614 506Z" fill={colors.accent}/>
            <Path d="M300 590V532H384L444 448H588L658 524L724 536V590M300 590H724M356 650H404M624 650H672" fill="none" stroke={colors.ink} strokeWidth={40} strokeLinecap="round" strokeLinejoin="round"/>
          </Svg>
        </Animated.View>
        <Animated.View style={[styles.layer, { opacity: frontShown, transform: [{ perspective: 500 }, { rotateY: deg(frontTurn) }] }]}>
          {/* The glass on its own layer, filling upwards from its lower edge (at 43 % of the drawing). */}
          <Animated.View style={[StyleSheet.absoluteFill, styles.center, { transformOrigin: '50% 43.3%', transform: [{ scaleY: glass }] }]}>
            <Svg width={76} height={76} viewBox="272 272 480 480"><Path d="M370 400L340 480H684L654 400Z" fill={colors.accent}/></Svg>
          </Animated.View>
          <Svg width={76} height={76} viewBox="272 272 480 480">
            <Path d="M322 582V488L366 368H658L702 488V582M322 536H702M393 536V582M632 536V582M370 655H393M632 655H655" fill="none" stroke={colors.ink} strokeWidth={46} strokeLinecap="round" strokeLinejoin="round"/>
          </Svg>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  box: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  tile: { borderRadius: 30, backgroundColor: colors.surface, ...cardShadow(scheme) },
  stage: { width: 84, height: 84 },
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  visible: { overflow: 'visible' }
}));
