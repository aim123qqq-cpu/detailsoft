import { createContext, useContext, type ComponentRef, type Ref } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { floatShadow, makeStyles, radius, useTheme } from '@/lib/theme';
import { Icon, type IconName } from '@/ui/icons';
import { Text } from '@/ui/text';

// The floating navigation of the phone: a pill above the bottom edge with the four sections, the chosen one
// a black pill with its name; beside it the round orange «+», a new booking.

const BAR = 58;
/** How much room the floating bar takes at the bottom of a screen (0 where it is hidden). */
export const TabBarSpace = createContext(0);
export const useTabBarSpace = () => useContext(TabBarSpace);
export const tabBarHeight = (bottomInset: number) => BAR + Math.max(bottomInset, 12) + 24;

const SECTIONS: { name: string; label: string; icon: IconName }[] = [
  { name: 'home', label: 'Главная', icon: 'home' },
  { name: 'bookings', label: 'Записи', icon: 'calendar' },
  { name: 'orders', label: 'Заказы', icon: 'car' },
  { name: 'profile', label: 'Профиль', icon: 'person' }
];

export function TabBar({ badges }: { badges?: Partial<Record<string, number>> }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.place, { bottom: Math.max(insets.bottom, 12) + 12 }]}>
      <View style={styles.bar} accessibilityRole="tablist">
        {SECTIONS.map((section) => (
          <TabTrigger key={section.name} name={section.name} asChild>
            <SectionButton label={section.label} icon={section.icon} badge={badges?.[section.name]}/>
          </TabTrigger>
        ))}
        <TabTrigger name="new" asChild>
          <NewButton/>
        </TabTrigger>
      </View>
    </View>
  );
}

function SectionButton({ label, icon, badge, isFocused, ref, ...props }: TabTriggerSlotProps & { label: string; icon: IconName; badge?: number; ref?: Ref<ComponentRef<typeof Pressable>> }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable ref={ref} {...props} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: Boolean(isFocused) }}
      style={[styles.section, isFocused ? styles.sectionOn : styles.sectionOff]}>
      <Icon name={icon} size={19} color={isFocused ? colors.pillInk : colors.ink} strokeWidth={isFocused ? 1.9 : 1.7}/>
      {isFocused ? <Text style={styles.label}>{label}</Text> : null}
      {badge ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text></View> : null}
    </Pressable>
  );
}

function NewButton({ isFocused, ref, ...props }: TabTriggerSlotProps & { ref?: Ref<ComponentRef<typeof Pressable>> }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable ref={ref} {...props} accessibilityRole="button" accessibilityLabel="Новая запись" accessibilityState={{ selected: Boolean(isFocused) }} style={styles.plus}>
      <Icon name="plus" size={20} color={colors.accentInk} strokeWidth={2.2}/>
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  place: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, borderRadius: radius.l + 4,
    backgroundColor: scheme === 'dark' ? 'rgba(30,31,33,0.96)' : 'rgba(255,255,255,0.96)', ...floatShadow(scheme)
  },
  section: { height: 46, minWidth: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  sectionOff: { width: 46, backgroundColor: colors.soft },
  sectionOn: { paddingLeft: 14, paddingRight: 18, backgroundColor: colors.pill },
  label: { color: colors.pillInk, fontSize: 14, fontWeight: '600' },
  badge: { position: 'absolute', top: 2, right: 2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: colors.accentInk, fontSize: 10, fontWeight: '700' },
  plus: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }
}));
