import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PhotoAsset, WorkOrder } from '@df/types';
import { money, shortDate } from '@/lib/format';
import { pickPhoto } from '@/lib/photo';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Card, Field, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { DOCK_SPACE, Dock } from '@/ui/sheet';
import { Text } from '@/ui/text';

/** Handing the car back: the work and the money, photos before and after, the customer's check, closing the order. */
export default function HandoverScreen() {
  const { id, title, subtitle } = useLocalSearchParams<{ id: string; title?: string; subtitle?: string }>();
  const { api } = useSession();
  const { data: order, error, reload } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));
  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <HandoverForm key={order.id} order={order} title={title} subtitle={subtitle}/>;
}

function HandoverForm({ order, title, subtitle }: { order: WorkOrder; title?: string; subtitle?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const session = useSignedIn();
  const [photos, setPhotos] = useState<PhotoAsset[]>(order.photos);
  const [accepted, setAccepted] = useState(false);
  const [complete, setComplete] = useState(false);
  const [responsible, setResponsible] = useState(session.actor.displayName);
  const [editResponsible, setEditResponsible] = useState(false);
  const [note, setNote] = useState('Клиент осмотрел автомобиль и принял результат работ');
  const [busy, setBusy] = useState<'photo' | 'close' | null>(null);
  const [error, setError] = useState('');

  const before = photos.find((photo) => photo.phase === 'intake');
  const after = photos.filter((photo) => photo.phase === 'result').at(-1);
  const operations = order.work?.operations ?? [];
  const done = operations.filter((operation) => operation.status === 'DONE').length;
  const estimate = order.estimateVersions.find((item) => item.id === order.approval?.estimateVersionId) ?? null;
  const [vehicle, customer] = [subtitle?.split(' · ')[0] ?? '', subtitle?.split(' · ').at(-1) ?? ''];
  const missing = [!after && 'фото после работ', !accepted && 'осмотр клиентом', !complete && 'комплектность', !before && 'фото приёмки', responsible.trim().length < 2 && 'кто выдал'].filter(Boolean);

  const shoot = async (source: 'camera' | 'library') => {
    setError('');
    try {
      const dataUrl = await pickPhoto(source);
      if (!dataUrl) return;
      setBusy('photo');
      const photo = await api.addPhoto(order.id, { phase: 'result', kind: 'intake', zone: 'Результат работ', dataUrl });
      setPhotos((list) => [...list, photo]);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  };
  const close = async () => {
    setBusy('close'); setError('');
    try {
      await api.closeOrder(order.id, { responsible: responsible.trim(), note: note.trim(), customerAccepted: accepted, completenessChecked: complete });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(null);
    }
  };

  return (
    <View style={styles.root}>
      <Screen contentStyle={{ paddingTop: insets.top + 18, paddingBottom: DOCK_SPACE + 40 + insets.bottom }}>
        <FlowHeader title="Выдача" note={title}/>
        <Card style={{ gap: 6 }}>
          {title ? <Plate plate={title}/> : null}
          {vehicle ? <Text style={styles.vehicle}>{vehicle}</Text> : null}
          <Text style={styles.meta}>{[customer, order.assignment ? `мастер ${order.assignment.masterName}` : null].filter(Boolean).join(' · ')}</Text>
        </Card>
        <View style={styles.tiles}>
          <View style={[styles.tile, { backgroundColor: colors.tileSage }]}><Text style={styles.tileLabel}>Работы</Text><Text style={styles.tileValue}>{done} из {operations.length}</Text></View>
          <View style={[styles.tile, { backgroundColor: colors.tileSky }]}><Text style={styles.tileLabel}>По смете</Text><Text style={styles.tileValue}>{estimate ? money(estimate.totalAmountMinor) : '—'}</Text></View>
        </View>

        <View style={styles.sectionHead}><Heading>До и после <Text style={styles.required}>*</Text></Heading></View>
        <View style={styles.photos}>
          <View style={styles.photoBox}>
            {before ? <Image source={{ uri: before.dataUrl }} style={styles.photo} contentFit="cover" accessibilityLabel="Фото до работ"/>
              : <View style={[styles.photo, styles.empty]}><Text style={styles.emptyText}>Нет фото приёмки</Text></View>}
            <Text style={styles.caption}>До работ</Text>
            <Text style={styles.meta}>{before ? `Фото приёмки · ${shortDate(before.createdAt)}` : 'Добавляется при приёмке'}</Text>
          </View>
          <View style={styles.photoBox}>
            {after ? <Image source={{ uri: after.dataUrl }} style={styles.photo} contentFit="cover" accessibilityLabel="Фото после работ"/> : (
              <Pressable accessibilityRole="button" accessibilityLabel="Снять результат" disabled={busy !== null} onPress={() => void shoot('camera')} style={[styles.photo, styles.empty, styles.add]}>
                <Icon name="camera" size={24}/>
                <Text style={styles.addText}>{busy === 'photo' ? 'Загрузка…' : 'Снять результат'}</Text>
              </Pressable>
            )}
            <Text style={styles.caption}>После работ</Text>
            <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void shoot(after ? 'camera' : 'library')} hitSlop={6}>
              <Text style={styles.link}>{after ? 'Переснять' : 'Фото из галереи'}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.checks}>
          <Check label="Клиент осмотрел результат работ" checked={accepted} onToggle={() => setAccepted((value) => !value)}/>
          <Check label="Комплектность автомобиля проверена" checked={complete} onToggle={() => setComplete((value) => !value)} line/>
          <Check label="Фото до и после прикреплены" checked={Boolean(before && after)} note="само" line/>
        </View>

        {editResponsible || responsible.trim().length < 2
          ? <Field label="Выдал" required value={responsible} onChangeText={setResponsible}/>
          : <Pressable accessibilityRole="button" onPress={() => setEditResponsible(true)} style={styles.responsible}>
              <Text style={styles.meta}>Выдал</Text>
              <Text style={styles.responsibleName}>{responsible}</Text>
              <Icon name="chevronRight" size={16} color={colors.muted}/>
            </Pressable>}
        <Field label="Комментарий к выдаче" value={note} onChangeText={setNote} multiline style={styles.note}/>
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
      <Dock>
        <View style={{ flex: 1, gap: 8 }}>
          {missing.length ? <Text style={styles.warning}>Осталось: {missing.length > 1 ? `${missing.slice(0, -1).join(', ')} и ${missing.at(-1)}` : missing[0]}</Text> : null}
          <Button title="Выдать автомобиль и закрыть заказ" busy={busy === 'close'} disabled={busy !== null || missing.length > 0 || note.trim().length < 2} onPress={() => void close()}/>
        </View>
      </Dock>
    </View>
  );
}

function Check({ label, checked, onToggle, note, line }: { label: string; checked: boolean; onToggle?: () => void; note?: string; line?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled: !onToggle }} disabled={!onToggle} onPress={onToggle} style={[styles.check, line && styles.checkLine]}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Icon name="check" size={16} color={colors.pillInk} strokeWidth={2.2}/> : null}</View>
      <Text style={styles.checkText}>{label}</Text>
      {note ? <Text style={styles.meta}>{note}</Text> : null}
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  vehicle: { fontSize: 20, fontWeight: '600', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  tiles: { flexDirection: 'row', gap: space.s },
  tile: { flex: 1, borderRadius: radius.m, padding: 14, gap: 2 },
  tileLabel: { color: colors.tileInk, fontSize: 12, fontWeight: '600', opacity: 0.75 },
  tileValue: { color: colors.tileInk, fontSize: 22, fontWeight: '500', letterSpacing: -0.4, fontVariant: ['tabular-nums'] },
  sectionHead: { marginTop: 4 },
  required: { color: colors.accent },
  photos: { flexDirection: 'row', gap: space.m },
  photoBox: { flex: 1, gap: 4 },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.m, backgroundColor: colors.soft },
  empty: { alignItems: 'center', justifyContent: 'center', padding: space.m, gap: 6 },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  add: { backgroundColor: colors.surface, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.carDraw },
  addText: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  caption: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  link: { fontSize: 13, fontWeight: '700' },
  checks: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  check: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 54, paddingVertical: 8 },
  checkLine: { borderTopWidth: 1, borderTopColor: colors.line },
  box: { width: 26, height: 26, borderRadius: 9, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  checkText: { fontSize: 15, flex: 1 },
  responsible: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 52, paddingHorizontal: space.l, borderRadius: radius.m, backgroundColor: colors.surface, ...cardShadow(scheme) },
  responsibleName: { flex: 1, fontSize: 15, fontWeight: '600', textAlign: 'right' },
  note: { minHeight: 80, paddingTop: 14, textAlignVertical: 'top' },
  warning: { color: colors.warnText, fontSize: 12, fontWeight: '600' }
}));
