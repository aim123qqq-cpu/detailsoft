import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, Defs, Pattern, Rect } from 'react-native-svg';
import { QUICK_NOTES, type CarLayout, type LayoutElement } from '@df/shared/carLayouts';
import type { IntakeFinding, PhotoAsset } from '@df/types';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { Button, Chip, Field, Notice } from '@/ui';
import { Icon } from '@/ui/icons';
import { ButtonPair, Sheet } from '@/ui/sheet';
import { Text } from '@/ui/text';
import { SEVERITY, severityColor, severityTint, type Marks } from './car-diagram';

export const GROUP_LABELS: Record<LayoutElement['group'], string> = {
  body: 'Кузов', glass: 'Остекление', wheel: 'Колесо и диск', mirror: 'Зеркало', interior: 'Салон', other: 'Прочее'
};
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
/** Parts on the drawing; the interior and the rest are a list of zones. */
export const onBody = (element: LayoutElement) => element.group !== 'interior' && element.group !== 'other';

/** The scene under the car: the ground with a fine grid of dots. */
export function DotGround() {
  const { colors } = useTheme();
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" aria-hidden>
      <Defs><Pattern id="dots" width={16} height={16} patternUnits="userSpaceOnUse"><Circle cx={2} cy={2} r={1} fill={colors.sceneDot}/></Pattern></Defs>
      <Rect width="100%" height="100%" fill={colors.ground}/>
      <Rect width="100%" height="100%" fill="url(#dots)"/>
    </Svg>
  );
}

export type Entry = { finding: IntakeFinding; index: number; element: LayoutElement | null };

/** The marks of one side of the car as cards in a row: number and severity, the part, what is wrong. */
export function MarkCards({ entries, onOpen, hint }: { entries: Entry[]; onOpen: (element: LayoutElement) => void; hint: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cards}>
      {entries.map(({ finding, index, element }) => (
        <Pressable key={`${finding.zone}-${index}`} accessibilityRole="button" accessibilityLabel={`${finding.zone}, ${SEVERITY[finding.severity].label.toLowerCase()}, ${finding.note}`}
          disabled={!element} onPress={() => element && onOpen(element)} style={styles.markCard}>
          <View style={styles.markHead}>
            <View style={[styles.pin, { backgroundColor: severityColor(colors, finding.severity) }]}><Text style={styles.pinText}>{element?.number ?? '•'}</Text></View>
            <Text style={styles.small}>{SEVERITY[finding.severity].label}</Text>
          </View>
          <Text style={styles.markPart} numberOfLines={1}>{finding.zone}</Text>
          <Text style={styles.small} numberOfLines={2}>{finding.note}</Text>
        </Pressable>
      ))}
      <View style={styles.hintCard}><Text style={styles.small}>{hint}</Text></View>
    </ScrollView>
  );
}

/** The interior and what is not on the drawing: a zone per tile, marked ones tinted. */
export function ZoneGrid({ elements, marks, onOpen }: { elements: LayoutElement[]; marks: Marks; onOpen: (element: LayoutElement) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.zones}>
      {elements.map((element) => {
        const mark = marks.get(element.name);
        return (
          <Pressable key={element.id} accessibilityRole="button" accessibilityLabel={`${element.number}. ${element.name}${mark ? ', есть замечание' : ''}`}
            onPress={() => onOpen(element)} style={[styles.zone, mark && { backgroundColor: severityTint(colors, mark.severity) }]}>
            <View style={[styles.pin, { backgroundColor: mark ? severityColor(colors, mark.severity) : colors.soft }]}>
              <Text style={[styles.pinText, !mark && { color: colors.muted }]}>{element.number}</Text>
            </View>
            <Text style={styles.zoneName} numberOfLines={2}>{element.name}</Text>
            {mark ? <Text style={styles.small}>{mark.count > 1 ? `${mark.count} замечания` : SEVERITY[mark.severity].label.toLowerCase()}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** One element: its marks (removable), then a new one: a quick note or a comment, severity, a photo of the spot. */
export function ElementSheet({ element, findings, onClose, onAdd, onRemove, photos, photoBusy, photoError, onPhoto }: {
  element: LayoutElement | null;
  findings: Entry[];
  onClose: () => void;
  onAdd: (finding: IntakeFinding) => void;
  onRemove: (index: number) => void;
  photos: PhotoAsset[];
  photoBusy: boolean;
  photoError: string;
  onPhoto: (zone: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<IntakeFinding['severity']>('MEDIUM');
  const [shownFor, setShownFor] = useState<string | null>(null);
  // A new element starts with an empty note and medium severity.
  if (element && element.id !== shownFor) { setShownFor(element.id); setNote(''); setSeverity('MEDIUM'); }
  const elementPhotos = element ? photos.filter((photo) => photo.phase === 'intake' && photo.zone === element.name) : [];
  const own = element ? findings.filter((entry) => entry.finding.zone === element.name) : [];

  return (
    <Sheet visible={Boolean(element)} title={element ? `${element.number}. ${element.name}` : ''} note={element ? GROUP_LABELS[element.group] : undefined} onClose={onClose}>
      {element ? <>
        {own.map(({ finding, index }) => (
          <View key={index} style={styles.own}>
            <View style={[styles.pin, { backgroundColor: severityColor(colors, finding.severity) }]}><Text style={styles.pinText}>{element.number}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.ownTitle}>{finding.note}</Text>
              <Text style={styles.small}>{SEVERITY[finding.severity].label}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Удалить отметку: ${finding.note}`} hitSlop={8} onPress={() => onRemove(index)} style={styles.remove}>
              <Icon name="close" size={16} color={colors.muted}/>
            </Pressable>
          </View>
        ))}
        <View style={styles.wrap}>{QUICK_NOTES[element.group].map((value) => <Chip key={value} label={value} selected={note === value} onPress={() => setNote(value)}/>)}</View>
        <View style={styles.severities} accessibilityRole="radiogroup" accessibilityLabel="Тяжесть">
          {SEVERITIES.map((value) => {
            const on = severity === value;
            return (
              <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => setSeverity(value)}
                style={[styles.severity, on && { backgroundColor: severityTint(colors, value), borderColor: severityColor(colors, value) }]}>
                <View style={[styles.dot, { backgroundColor: severityColor(colors, value) }]}/>
                <Text style={[styles.severityText, on && { color: colors.ink }]}>{SEVERITY[value].label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Field label="Что с деталью" value={note} onChangeText={setNote} maxLength={300} placeholder="Например, скол 3 мм у кромки"/>
        <View style={styles.photoRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Снять фото повреждения" disabled={photoBusy} onPress={() => onPhoto(element.name)} style={styles.photoButton}>
            <Icon name="camera" size={20}/>
            <Text style={styles.photoText}>{photoBusy ? 'Загрузка…' : 'Фото'}</Text>
          </Pressable>
          {elementPhotos.slice(-3).map((photo) => <Image key={photo.id} source={{ uri: photo.dataUrl }} style={styles.thumb} contentFit="cover" accessibilityLabel={`Фото: ${photo.zone}`}/>)}
        </View>
        {photoError ? <Notice>{photoError}</Notice> : null}
        <ButtonPair>
          <Button title="Готово" tone="secondary" style={{ flex: 1 }} onPress={onClose}/>
          <Button title="Добавить отметку" style={{ flex: 1.4 }} disabled={!note.trim()} onPress={() => { onAdd({ zone: element.name, severity, note: note.trim() }); setNote(''); }}/>
        </ButtonPair>
      </> : null}
    </Sheet>
  );
}

/** The body type: the drawing changes with it. */
export function BodySheet({ visible, value, options, onChange, onClose }: { visible: boolean; value: string; options: { code: string; label: string }[]; onChange: (code: string) => void; onClose: () => void }) {
  const styles = useStyles();
  return (
    <Sheet visible={visible} title="Тип кузова" note="Схема и номера деталей в акте зависят от кузова." onClose={onClose}>
      <View style={styles.wrap}>{options.map((item) => <Chip key={item.code} label={item.label} selected={value === item.code} onPress={() => { onChange(item.code); onClose(); }}/>)}</View>
    </Sheet>
  );
}

/** The drawing's own room: it fits the space between the head and the panel, as large as it can. */
export function fitDiagram(layout: CarLayout, room: { width: number; height: number }) {
  return Math.max(120, Math.min(room.width, room.height * layout.width / layout.height));
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  cards: { gap: space.s, paddingHorizontal: space.l },
  markCard: { width: 150, padding: space.m, borderRadius: radius.m, backgroundColor: colors.soft, gap: 6 },
  markHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pin: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  pinText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  markPart: { fontSize: 15, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 12 },
  hintCard: { width: 124, padding: space.m, borderRadius: radius.m, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.carDraw, justifyContent: 'center' },
  zones: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  zone: { width: '48.5%', minHeight: 92, borderRadius: radius.m, backgroundColor: colors.surface, padding: space.m, gap: 6, ...cardShadow(scheme) },
  zoneName: { fontSize: 14, fontWeight: '600' },
  own: { flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.m, borderRadius: radius.m, backgroundColor: colors.soft },
  ownTitle: { fontSize: 14, fontWeight: '600' },
  remove: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  severities: { flexDirection: 'row', gap: space.s },
  severity: { flex: 1, minHeight: 44, borderRadius: 22, borderWidth: 1.5, borderColor: 'transparent', backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  severityText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  photoButton: { height: 52, paddingHorizontal: 18, borderRadius: 26, backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', gap: 8 },
  photoText: { fontSize: 14, fontWeight: '700' },
  thumb: { width: 52, height: 52, borderRadius: radius.s }
}));
