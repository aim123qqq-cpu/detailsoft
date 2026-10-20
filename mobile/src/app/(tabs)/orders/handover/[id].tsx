import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { PhotoAsset, WorkOrder } from '@df/types';
import { pickPhoto } from '@/lib/photo';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Field, Label, Loading, Notice, Screen } from '@/ui';

/** Handing the car back: photos before and after, the customer's check, and closing the order. */
export default function HandoverScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { api } = useSession();
  const { data: order, error, reload } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));
  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <HandoverForm key={order.id} order={order} title={title}/>;
}

function HandoverForm({ order, title }: { order: WorkOrder; title?: string }) {
  const { api } = useSession();
  const session = useSignedIn();
  const [photos, setPhotos] = useState<PhotoAsset[]>(order.photos);
  const [accepted, setAccepted] = useState(false);
  const [complete, setComplete] = useState(false);
  const [responsible, setResponsible] = useState(session.actor.displayName);
  const [note, setNote] = useState('Клиент осмотрел автомобиль и принял результат работ');
  const [busy, setBusy] = useState<'photo' | 'close' | null>(null);
  const [error, setError] = useState('');

  const before = photos.find((photo) => photo.phase === 'intake');
  const after = photos.find((photo) => photo.phase === 'result');

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
    <Screen>
      <Stack.Screen options={{ title: title ? `Выдача · ${title}` : 'Выдача' }}/>
      <View style={styles.photos}>
        <View style={styles.photoBox}>
          {before ? <Image source={{ uri: before.dataUrl }} style={styles.photo} contentFit="cover" accessibilityLabel="Фото до работ"/> : <View style={[styles.photo, styles.empty]}><Text style={styles.emptyText}>Нет фото приёмки</Text></View>}
          <Text style={styles.caption}>До работ</Text>
        </View>
        <View style={styles.photoBox}>
          {after ? <Image source={{ uri: after.dataUrl }} style={styles.photo} contentFit="cover" accessibilityLabel="Фото после работ"/> : (
            <Pressable accessibilityRole="button" accessibilityLabel="Снять результат" disabled={busy !== null} onPress={() => void shoot('camera')} style={[styles.photo, styles.empty, styles.add]}>
              <Text style={styles.addText}>{busy === 'photo' ? 'Загрузка…' : '＋ Снять результат'}</Text>
            </Pressable>
          )}
          <Text style={styles.caption}>После работ</Text>
        </View>
      </View>
      {!after ? <Button title="Фото из галереи" tone="quiet" disabled={busy !== null} onPress={() => void shoot('library')}/> : null}
      {!before ? <Body muted>Фото до работ добавляется при приёмке. Без него заказ закрыть нельзя — его можно приложить в веб-версии.</Body> : null}

      <View style={{ gap: space.s }}>
        <Label>Перед выдачей</Label>
        <Check label="Клиент осмотрел результат работ" checked={accepted} onToggle={() => setAccepted((value) => !value)}/>
        <Check label="Комплектность автомобиля проверена" checked={complete} onToggle={() => setComplete((value) => !value)}/>
        <Check label={before && after ? 'Фото до и после прикреплены' : 'Нужны фото до и после работ'} checked={Boolean(before && after)}/>
      </View>
      <Field label="Выдал" value={responsible} onChangeText={setResponsible}/>
      <Field label="Комментарий к выдаче" value={note} onChangeText={setNote} multiline style={styles.note}/>
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Выдать автомобиль и закрыть заказ" busy={busy === 'close'}
        disabled={busy !== null || !before || !after || !accepted || !complete || responsible.trim().length < 2 || note.trim().length < 2} onPress={() => void close()}/>
    </Screen>
  );
}

function Check({ label, checked, onToggle }: { label: string; checked: boolean; onToggle?: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled: !onToggle }} disabled={!onToggle} onPress={onToggle} style={styles.check}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Text style={styles.mark}>✓</Text> : null}</View>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  photos: { flexDirection: 'row', gap: space.m },
  photoBox: { flex: 1, gap: 6 },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.m, backgroundColor: colors.surface },
  empty: { alignItems: 'center', justifyContent: 'center', padding: space.m },
  emptyText: { color: colors.soft, fontSize: 14, textAlign: 'center' },
  add: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.primary },
  addText: { color: colors.primary, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  caption: { color: colors.muted, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  check: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 52, backgroundColor: colors.surface, borderRadius: radius.m, paddingHorizontal: space.m },
  box: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.ok, borderColor: colors.ok },
  mark: { color: colors.okInk, fontSize: 14, fontWeight: '900' },
  checkText: { color: colors.text, fontSize: 16, flex: 1 },
  note: { minHeight: 80, paddingTop: 14, textAlignVertical: 'top' }
});
