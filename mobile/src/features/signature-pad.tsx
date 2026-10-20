import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { colors, radius, space } from '@/lib/theme';

const HEIGHT = 180;

/**
 * The customer signs with a finger. Strokes are SVG paths; the result is a PNG data URL (what the
 * server keeps with the act). `onDrawing` lets the screen stop scrolling while the finger is down.
 */
export function SignaturePad({ onChange, onDrawing }: { onChange: (dataUrl: string | null) => void; onDrawing?: (drawing: boolean) => void }) {
  const svg = useRef<Svg>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [live, setLive] = useState('');
  const [width, setWidth] = useState(0);

  // The picture is taken once the finished strokes are on screen (a frame after they are committed).
  useEffect(() => {
    if (!paths.length) return;
    const timer = setTimeout(() => svg.current?.toDataURL((base64) => onChange(`data:image/png;base64,${base64}`)), 120);
    return () => clearTimeout(timer);
  }, [paths, onChange]);
  const at = (event: GestureResponderEvent) => `${event.nativeEvent.locationX.toFixed(1)} ${event.nativeEvent.locationY.toFixed(1)}`;
  const finish = () => {
    onDrawing?.(false);
    if (!live) return;
    const next = [...paths, live];
    setLive('');
    setPaths(next);
  };
  const clear = () => { setPaths([]); setLive(''); onChange(null); };
  // The pad keeps the finger once it is down, so the screen does not scroll while signing.
  const touch = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (event: GestureResponderEvent) => { onDrawing?.(true); const point = at(event); setLive(`M${point} l0.1 0.1`); },
    onResponderMove: (event: GestureResponderEvent) => { const point = at(event); setLive((stroke) => `${stroke} L${point}`); },
    onResponderRelease: finish,
    onResponderTerminate: finish
  };

  return (
    <View style={{ gap: space.s }}>
      <View style={styles.pad} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} {...touch}
        accessible accessibilityLabel="Поле для подписи клиента пальцем">
        {width ? <Svg ref={svg} width={width} height={HEIGHT} pointerEvents="none">
          <Rect x={0} y={0} width={width} height={HEIGHT} fill="#ffffff"/>
          {[...paths, live].filter(Boolean).map((d, index) => <Path key={index} d={d} stroke="#111518" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none"/>)}
        </Svg> : null}
        {!paths.length && !live ? <Text style={styles.hint} pointerEvents="none">Подпишите пальцем здесь</Text> : null}
      </View>
      <View style={styles.row}>
        <Text style={styles.state}>{paths.length ? 'Подпись поставлена' : 'Подпись необязательна'}</Text>
        <Pressable accessibilityRole="button" disabled={!paths.length} onPress={clear} hitSlop={8}>
          <Text style={[styles.clear, !paths.length && { opacity: 0.4 }]}>Очистить</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { height: HEIGHT, borderRadius: radius.m, overflow: 'hidden', backgroundColor: '#ffffff', justifyContent: 'center' },
  hint: { position: 'absolute', alignSelf: 'center', color: '#9aa3aa', fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  state: { color: colors.muted, fontSize: 14 },
  clear: { color: colors.primary, fontSize: 15, fontWeight: '800' }
});
