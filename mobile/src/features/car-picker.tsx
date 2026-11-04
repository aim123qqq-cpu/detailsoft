import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { carMakes, carModels } from '@df/shared/carCatalog';
import { colors, radius, space } from '@/lib/theme';
import { Label } from '@/ui';

/** A list to choose from with a search on top, over the whole screen. */
function ChoiceSheet({ title, items, query, setQuery, onChoose, onClose, onNotListed }: {
  title: string; items: string[]; query: string; setQuery: (value: string) => void;
  onChoose: (value: string) => void; onClose: () => void; onNotListed: () => void;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.headTitle}>{title}</Text>
          <Pressable accessibilityRole="button" hitSlop={12} onPress={onClose}><Text style={styles.action}>Закрыть</Text></Pressable>
        </View>
        <TextInput value={query} onChangeText={setQuery} autoCorrect={false} placeholder="Поиск" placeholderTextColor={colors.soft} style={styles.search}/>
        <FlatList data={items} keyExtractor={(item) => item} keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={styles.empty}>В справочнике такого нет</Text>}
          ListFooterComponent={<Pressable accessibilityRole="button" onPress={onNotListed} style={styles.row}><Text style={styles.action}>Нет в списке — ввести вручную</Text></Pressable>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => onChoose(item)} android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.row}><Text style={styles.rowText}>{item}</Text></Pressable>}/>
      </View>
    </Modal>
  );
}

function Select({ label, value, disabled, onPress }: { label: string; value: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View style={styles.half}>
      <Label>{label}</Label>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value || 'выбрать'}`} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
        style={[styles.select, disabled && styles.selectOff]}>
        <Text style={value ? styles.selectValue : styles.selectEmpty} numberOfLines={1}>{value || 'Выбрать'}</Text>
      </Pressable>
    </View>
  );
}

/** Make, then model, as on car sites. A car that is not listed goes to the manual form with what was typed. */
export function CarPicker({ make, model, onChange, onNotListed }: {
  make: string; model: string;
  onChange: (make: string, model: string) => void;
  onNotListed: (make: string, model: string) => void;
}) {
  const [open, setOpen] = useState<'make' | 'model' | null>(null);
  const [query, setQuery] = useState('');
  const show = (sheet: 'make' | 'model') => { setQuery(''); setOpen(sheet); };
  const close = () => setOpen(null);
  return (
    <View style={styles.pair}>
      <Select label="Марка" value={make} onPress={() => show('make')}/>
      <Select label="Модель" value={model} disabled={!make} onPress={() => show('model')}/>
      {open === 'make' ? <ChoiceSheet title="Марка" items={carMakes(query)} query={query} setQuery={setQuery}
        onChoose={(value) => { onChange(value, ''); show('model'); }} onClose={close}
        onNotListed={() => { close(); onNotListed(query.trim(), ''); }}/> : null}
      {open === 'model' ? <ChoiceSheet title={make} items={carModels(make, query)} query={query} setQuery={setQuery}
        onChoose={(value) => { onChange(make, value); close(); }} onClose={close}
        onNotListed={() => { close(); onNotListed(make, query.trim()); }}/> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: space.m },
  half: { flex: 1 },
  select: { justifyContent: 'center', minHeight: 52, paddingHorizontal: space.m, borderRadius: radius.m, backgroundColor: colors.surface },
  selectOff: { opacity: 0.5 },
  selectValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  selectEmpty: { color: colors.muted, fontSize: 16 },
  sheet: { flex: 1, gap: space.s, padding: space.l, backgroundColor: colors.ground },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  action: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  search: { minHeight: 48, paddingHorizontal: space.m, borderRadius: radius.m, backgroundColor: colors.surface, color: colors.text, fontSize: 16 },
  row: { minHeight: 50, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowText: { color: colors.text, fontSize: 16 },
  empty: { color: colors.muted, fontSize: 15, paddingVertical: space.m }
});
