import { StyleSheet, View } from 'react-native';
import { radius } from '@/lib/theme';
import { Text } from '@/ui/text';

// A Russian number plate: white, a black frame, the region behind a bar. The same in both themes:
// it is a thing, not a part of the interface. As wide as its text.

/** "В476РЕ 155" or "В476РЕ155" → ["В476РЕ", "155"]. */
export function splitPlate(plate: string): [string, string] {
  const value = plate.trim().toUpperCase();
  const spaced = value.match(/^(.*\S)\s+(\d{2,3})$/);
  if (spaced) return [spaced[1], spaced[2]];
  const joined = value.match(/^([А-ЯA-Z]\d{3}[А-ЯA-Z]{2})(\d{2,3})$/);
  return joined ? [joined[1], joined[2]] : [value, ''];
}

export function Plate({ plate, size = 'm' }: { plate: string; size?: 'm' | 'l' }) {
  const [number, region] = splitPlate(plate);
  const large = size === 'l';
  return (
    <View style={[styles.plate, large && styles.large]} accessibilityLabel={`Госномер ${plate}`}>
      <Text style={[styles.text, styles.number, large && styles.largeText]}>{number}</Text>
      {region ? <Text style={[styles.text, styles.region, large && styles.largeText]}>{region}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  plate: { flexDirection: 'row', alignSelf: 'flex-start', height: 22, borderWidth: 1.5, borderColor: '#121212', borderRadius: radius.xs, backgroundColor: '#FFFFFF', overflow: 'hidden', alignItems: 'center' },
  large: { height: 30 },
  text: { color: '#121212', fontSize: 12, lineHeight: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  largeText: { fontSize: 16, lineHeight: 22 },
  number: { paddingHorizontal: 6, letterSpacing: 0.4 },
  region: { paddingHorizontal: 4, borderLeftWidth: 1.5, borderLeftColor: '#121212', alignSelf: 'stretch', textAlignVertical: 'center', lineHeight: 19 }
});
