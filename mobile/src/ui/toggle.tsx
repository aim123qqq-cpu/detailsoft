import { Pressable, StyleSheet, View } from 'react-native';
import { makeStyles } from '@/lib/theme';

/** The design's switch: a dark pill with a light knob when on, a grey track when off. */
export function Toggle({ value, onValueChange, disabled, label, testID }: { value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean; label?: string; testID?: string }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} disabled={disabled} hitSlop={8}
      onPress={() => onValueChange(!value)} style={[styles.track, value && styles.on, disabled && styles.disabled]} testID={testID}>
      <View style={[styles.knob, value && styles.knobOn]}/>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  track: { width: 48, height: 28, borderRadius: 14, padding: 3, backgroundColor: colors.line, justifyContent: 'center', alignItems: 'flex-start' },
  on: { backgroundColor: colors.pill, alignItems: 'flex-end' },
  disabled: { opacity: 0.5 },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surface },
  knobOn: { backgroundColor: colors.pillInk }
}));
