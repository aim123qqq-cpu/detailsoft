import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { floatShadow, makeStyles, radius, space } from '@/lib/theme';
import { Text } from '@/ui/text';

/**
 * The bottom sheet of the phone: white, rounded on top, a handle, the ground dimmed under it.
 * A title, one line on what happens, the content and the actions, usually a pair of buttons.
 */
export function Sheet({ visible, title, note, onClose, children }: { visible: boolean; title: string; note?: string; onClose: () => void; children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.place} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть">
          <View style={styles.scrim}/>
        </Pressable>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 20 }]} accessibilityViewIsModal>
          <View style={styles.handle}/>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" bounces={false}>
            <View style={styles.head}>
              <Text style={styles.title} accessibilityRole="header">{title}</Text>
              {note ? <Text style={styles.note}>{note}</Text> : null}
            </View>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Two buttons side by side at the bottom of a sheet or a screen: the way back on the left, the action on the right. */
export function ButtonPair({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: space.s }}>{children}</View>;
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  place: { flex: 1, justifyContent: 'flex-end' },
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: { maxHeight: '88%', backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: 10, ...floatShadow(scheme) },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 6 },
  content: { paddingHorizontal: space.l, gap: 14 },
  head: { gap: 6, paddingHorizontal: 4, paddingTop: 4 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '600', letterSpacing: -0.5 },
  note: { fontSize: 14, lineHeight: 20, color: colors.muted }
}));
