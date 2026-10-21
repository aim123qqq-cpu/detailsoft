import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '@/lib/theme';

/** A list of options to tick (roles of a member, permissions of a role): title, a line of detail, a check. */
export function PickList({ options, selected, onToggle }: {
  options: { key: string; title: string; note?: string }[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <View style={styles.list}>
      {options.map((option) => {
        const on = selected.includes(option.key);
        return (
          <Pressable key={option.key} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={option.title}
            onPress={() => onToggle(option.key)} android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.row, on && styles.rowOn]}>
            <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.mark}>✓</Text> : null}</View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{option.title}</Text>
              {option.note ? <Text style={styles.note}>{option.note}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.s },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, borderWidth: 1, borderColor: 'transparent', overflow: 'hidden' },
  rowOn: { borderColor: colors.primary },
  box: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  mark: { color: colors.primaryInk, fontSize: 14, fontWeight: '900' },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 13, lineHeight: 18 }
});
