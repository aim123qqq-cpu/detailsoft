import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BODY_TYPES, QUICK_NOTES, carLayout, type BodyType, type LayoutElement } from '@df/shared/carLayouts';
import type { IntakeFinding, PhotoAsset } from '@df/types';
import { colors, radius, space } from '@/lib/theme';
import { Body, Button, Card, Chip, Field, Label, Notice } from '@/ui';
import { CarDiagram, SEVERITY, findingMarks } from './car-diagram';

const GROUP_LABELS: Record<LayoutElement['group'], string> = {
  body: 'Кузов', glass: 'Остекление', wheel: 'Колесо и диск', mirror: 'Зеркало', interior: 'Салон', other: 'Прочее'
};
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;

/**
 * The inspection part of intake: body type, the numbered diagram, interior and other items, and the
 * findings. A finding's zone is the element name, so the act shows it with the same number.
 */
export function Inspection({ bodyType, onBodyType, findings, onFindings, photos, photoBusy, photoError, onPhoto }: {
  bodyType: BodyType;
  onBodyType: (value: BodyType) => void;
  findings: IntakeFinding[];
  onFindings: (findings: IntakeFinding[]) => void;
  photos: PhotoAsset[];
  photoBusy: boolean;
  photoError: string;
  onPhoto: (zone: string) => void;
}) {
  const { width } = useWindowDimensions();
  const layout = useMemo(() => carLayout(bodyType), [bodyType]);
  const ordered = useMemo(() => [...layout.elements].sort((a, b) => a.number - b.number), [layout]);
  const marks = useMemo(() => findingMarks(findings), [findings]);
  const [selected, setSelected] = useState<LayoutElement | null>(null);
  const numberOf = (zone: string) => ordered.find((element) => element.name === zone)?.number ?? null;
  const sorted = findings.map((finding, index) => ({ finding, index }))
    .sort((left, right) => (numberOf(left.finding.zone) ?? 999) - (numberOf(right.finding.zone) ?? 999));

  const select = (element: LayoutElement) => { void Haptics.selectionAsync(); setSelected(element); };

  return (
    <>
      <View>
        <Label>Тип кузова</Label>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
          {BODY_TYPES.map((item) => <Chip key={item.code} label={item.label} selected={bodyType === item.code} onPress={() => onBodyType(item.code)}/>)}
        </ScrollView>
      </View>

      <Card style={styles.stage}>
        <CarDiagram layout={layout} marks={marks} selected={selected?.id} onSelect={select} width={Math.min(width - 64, 320)}/>
        <Text style={styles.hint}>Нажмите на элемент или его номер, чтобы добавить замечание</Text>
        <View style={styles.legend}>
          {SEVERITIES.map((value) => <View key={value} style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: SEVERITY[value].part }]}/><Text style={styles.legendText}>{SEVERITY[value].label.toLowerCase()}</Text></View>)}
        </View>
      </Card>

      {(['interior', 'other'] as const).map((group) => (
        <View key={group}>
          <Label>{GROUP_LABELS[group]}</Label>
          <View style={styles.extras}>
            {ordered.filter((element) => element.group === group).map((element) => {
              const mark = marks.get(element.name);
              return (
                <Pressable key={element.id} accessibilityRole="button" accessibilityLabel={`${element.number}. ${element.name}`} onPress={() => select(element)}
                  android_ripple={{ color: 'rgba(255,255,255,.08)' }} style={styles.extra}>
                  <View style={[styles.number, mark && { backgroundColor: SEVERITY[mark.severity].badge }]}><Text style={styles.numberText}>{element.number}</Text></View>
                  <Text style={styles.extraText}>{element.name}</Text>
                  {mark && mark.count > 1 ? <Text style={styles.count}>{mark.count}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      <Card>
        <View style={styles.titleRow}><Label>Обнаружено при осмотре</Label><Text style={styles.total}>{findings.length}</Text></View>
        {!findings.length && <Body muted>Замечаний нет. Если на автомобиле есть повреждения, отметьте их на схеме.</Body>}
        {sorted.map(({ finding, index }) => (
          <View key={`${finding.zone}-${index}`} style={styles.finding}>
            <View style={[styles.number, { backgroundColor: SEVERITY[finding.severity].badge }]}><Text style={styles.numberText}>{numberOf(finding.zone) ?? '•'}</Text></View>
            <Pressable style={styles.findingText} onPress={() => { const element = ordered.find((item) => item.name === finding.zone); if (element) select(element); }}>
              <Text style={styles.findingZone}>{finding.zone}</Text>
              <Text style={styles.meta}>{SEVERITY[finding.severity].label} · {finding.note}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Удалить замечание: ${finding.zone}`} hitSlop={8} style={styles.remove}
              onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onFindings(findings.filter((_, position) => position !== index)); }}>
              <Text style={styles.removeText}>×</Text>
            </Pressable>
          </View>
        ))}
      </Card>

      <ElementSheet element={selected} onClose={() => setSelected(null)} photos={photos} photoBusy={photoBusy} photoError={photoError} onPhoto={onPhoto}
        onAdd={(finding) => { onFindings([...findings, finding]); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setSelected(null); }}/>
    </>
  );
}

/** Bottom sheet for one element: a quick note or a comment, severity, a photo of the spot. */
function ElementSheet({ element, onClose, onAdd, photos, photoBusy, photoError, onPhoto }: {
  element: LayoutElement | null;
  onClose: () => void;
  onAdd: (finding: IntakeFinding) => void;
  photos: PhotoAsset[];
  photoBusy: boolean;
  photoError: string;
  onPhoto: (zone: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<IntakeFinding['severity']>('MEDIUM');
  const [shownFor, setShownFor] = useState<string | null>(null);
  // A new element starts with an empty note and medium severity.
  if (element && element.id !== shownFor) { setShownFor(element.id); setNote(''); setSeverity('MEDIUM'); }
  const elementPhotos = element ? photos.filter((photo) => photo.phase === 'intake' && photo.zone === element.name) : [];

  return (
    <Modal visible={Boolean(element)} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheetRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Закрыть"/>
        {element && <View style={[styles.sheet, { paddingBottom: insets.bottom + space.l }]}>
          <View style={styles.sheetHead}>
            <View style={[styles.number, styles.bigNumber]}><Text style={styles.numberText}>{element.number}</Text></View>
            <View style={{ flex: 1 }}><Text style={styles.sheetTitle}>{element.name}</Text><Text style={styles.meta}>{GROUP_LABELS[element.group]}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" hitSlop={10} onPress={onClose}><Text style={styles.close}>×</Text></Pressable>
          </View>
          <View style={styles.wrap}>{QUICK_NOTES[element.group].map((value) => <Chip key={value} label={value} selected={note === value} onPress={() => setNote(value)}/>)}</View>
          <View style={styles.severities}>
            {SEVERITIES.map((value) => (
              <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: severity === value }} onPress={() => setSeverity(value)}
                style={[styles.severity, severity === value && { borderColor: SEVERITY[value].part, backgroundColor: `${SEVERITY[value].part}26` }]}>
                <Text style={[styles.severityText, severity === value && { color: colors.text }]}>{SEVERITY[value].label}</Text>
              </Pressable>
            ))}
          </View>
          <Field label="Комментарий" value={note} onChangeText={setNote} maxLength={300} placeholder="Например, скол 3 мм у кромки"/>
          <View style={styles.photoRow}>
            <Button title={photoBusy ? 'Загрузка…' : 'Фото'} tone="secondary" busy={photoBusy} onPress={() => onPhoto(element.name)} style={styles.photoButton}/>
            {elementPhotos.slice(-3).map((photo) => <Image key={photo.id} source={{ uri: photo.dataUrl }} style={styles.thumb} contentFit="cover" accessibilityLabel={`Фото: ${photo.zone}`}/>)}
          </View>
          {photoError ? <Notice>{photoError}</Notice> : null}
          <Button title="Добавить замечание" disabled={!note.trim()} onPress={() => onAdd({ zone: element.name, severity, note: note.trim() })}/>
        </View>}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bleed: { marginHorizontal: -space.l },
  chips: { gap: space.s, paddingHorizontal: space.l },
  stage: { alignItems: 'center', paddingVertical: space.xl },
  hint: { color: colors.muted, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: space.m },
  legend: { flexDirection: 'row', gap: space.l, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendText: { color: colors.muted, fontSize: 12 },
  extras: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  extra: { flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44, paddingLeft: 6, paddingRight: 14, borderRadius: radius.pill, backgroundColor: colors.surface, overflow: 'hidden' },
  extraText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  count: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  number: { minWidth: 28, height: 28, borderRadius: 14, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceRaised },
  bigNumber: { minWidth: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary },
  numberText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between' },
  total: { color: colors.text, fontSize: 15, fontWeight: '800' },
  finding: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 6 },
  findingText: { flex: 1 },
  findingZone: { color: colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  remove: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: colors.muted, fontSize: 24, lineHeight: 26 },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,.55)' },
  sheet: { backgroundColor: colors.surfaceRaised, borderTopLeftRadius: radius.l + 4, borderTopRightRadius: radius.l + 4, padding: space.l, gap: space.m },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: '800' },
  close: { color: colors.muted, fontSize: 30, lineHeight: 32, paddingHorizontal: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  severities: { flexDirection: 'row', gap: space.s },
  severity: { flex: 1, minHeight: 44, borderRadius: radius.m, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  severityText: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  photoButton: { minWidth: 112, backgroundColor: colors.surface },
  thumb: { width: 52, height: 52, borderRadius: radius.s }
});
