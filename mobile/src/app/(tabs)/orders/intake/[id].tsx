import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams, useNavigation, usePreventRemove } from 'expo-router';
import { normalizeBodyType, type BodyType } from '@df/shared/carLayouts';
import type { IntakeFinding, PhotoAsset, WorkOrder } from '@df/types';
import { pickPhoto } from '@/lib/photo';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Inspection } from '@/features/inspection';
import { Body, Button, Card, Field, Label, Loading, Notice, Screen } from '@/ui';

/** The server keeps up to 19 intake photos per order. */
const PHOTO_LIMIT = 19;

/** Intake of an order: inspection on the diagram, photos, a recommendation and the summary. */
export default function IntakeScreen() {
  const { id, bodyType, title } = useLocalSearchParams<{ id: string; bodyType?: string; title?: string }>();
  const { api } = useSession();
  const { data: order, error, reload } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));

  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <IntakeForm key={order.id} order={order} vehicleBodyType={bodyType} title={title}/>;
}

function IntakeForm({ order, vehicleBodyType, title }: { order: WorkOrder; vehicleBodyType?: string; title?: string }) {
  const { api } = useSession();
  const navigation = useNavigation();
  const intake = order.intake;
  const [bodyType, setBodyType] = useState<BodyType>(() => normalizeBodyType(intake?.bodyType ?? vehicleBodyType));
  const [findings, setFindings] = useState<IntakeFinding[]>(() => intake?.findings.map(({ zone, severity, note }) => ({ zone, severity, note })) ?? []);
  const [summary, setSummary] = useState(intake?.conditionSummary ?? 'Автомобиль принят при клиенте, комплектность проверена');
  const [recommendationTitle, setRecommendationTitle] = useState(intake?.recommendations[0]?.title ?? '');
  const [recommendationReason, setRecommendationReason] = useState(intake?.recommendations[0]?.reason ?? '');
  const [photos, setPhotos] = useState<PhotoAsset[]>(order.photos);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');

  const touch = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setDirty(true); };
  const intakePhotos = photos.filter((photo) => photo.phase === 'intake');
  const recommendationIncomplete = Boolean(recommendationTitle.trim()) !== Boolean(recommendationReason.trim());

  // Photos are saved at once; the inspection is saved with the button. Leaving with changes asks first.
  usePreventRemove(dirty && !saving, ({ data }) => {
    Alert.alert('Выйти без сохранения?', 'Замечания и комментарий не сохранятся. Фото уже сохранены.', [
      { text: 'Остаться', style: 'cancel' },
      { text: 'Выйти', style: 'destructive', onPress: () => navigation.dispatch(data.action) }
    ]);
  });

  const addPhoto = async (zone: string, source: 'camera' | 'library' = 'camera') => {
    if (intakePhotos.length >= PHOTO_LIMIT) { setError(`К заказу можно приложить до ${PHOTO_LIMIT} фото приёмки`); return; }
    setError('');
    try {
      const dataUrl = await pickPhoto(source);
      if (!dataUrl) return;
      setPhotoBusy(true);
      const photo = await api.addPhoto(order.id, { phase: 'intake', kind: zone === 'Общий вид' ? 'intake' : 'defect', zone, dataUrl });
      setPhotos((current) => [...current, photo]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.saveIntake(order.id, {
        bodyType,
        conditionSummary: summary.trim(),
        findings,
        recommendations: recommendationTitle.trim() ? [{ title: recommendationTitle.trim(), reason: recommendationReason.trim(), priority: 'RECOMMENDED' }] : []
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDirty(false);
      router.back();
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: title ? `Приёмка · ${title}` : 'Приёмка' }}/>
      <Inspection bodyType={bodyType} onBodyType={touch(setBodyType)} findings={findings} onFindings={touch(setFindings)}
        photos={photos} photoBusy={photoBusy} photoError={error} onPhoto={(zone) => void addPhoto(zone)}/>

      <Card>
        <View style={styles.titleRow}><Label>Фото приёмки</Label><Text style={styles.count}>{intakePhotos.length} из {PHOTO_LIMIT}</Text></View>
        {intakePhotos.length ? (
          <View style={styles.grid}>
            {intakePhotos.map((photo) => (
              <View key={photo.id} style={styles.tile}>
                <Image source={{ uri: photo.dataUrl }} style={styles.photo} contentFit="cover" accessibilityLabel={`Фото: ${photo.zone}`}/>
                <Text style={styles.caption} numberOfLines={1}>{photo.zone}</Text>
              </View>
            ))}
          </View>
        ) : <Body muted>Снимите общий вид автомобиля. Фото повреждения добавьте из замечания к элементу.</Body>}
        <View style={styles.actions}>
          <Button title="Снять общий вид" tone="secondary" busy={photoBusy} onPress={() => void addPhoto('Общий вид')} style={styles.action}/>
          <Pressable accessibilityRole="button" disabled={photoBusy} onPress={() => void addPhoto('Общий вид', 'library')} style={styles.library}>
            <Text style={styles.libraryText}>Из галереи</Text>
          </Pressable>
        </View>
      </Card>

      <Card>
        <Label>Рекомендация клиенту</Label>
        <Field label="Что предложить" value={recommendationTitle} onChangeText={touch(setRecommendationTitle)} placeholder="Например, локальная защита скола" maxLength={120}/>
        <Field label="Почему" value={recommendationReason} onChangeText={touch(setRecommendationReason)} placeholder="Снизит риск коррозии" maxLength={300}
          error={recommendationIncomplete ? 'Заполните оба поля или оставьте оба пустыми' : undefined}/>
      </Card>

      <Field label="Комментарий к приёмке" value={summary} onChangeText={touch(setSummary)} multiline maxLength={500} style={styles.summary}
        error={summary.trim().length < 3 ? 'Опишите состояние автомобиля' : undefined}/>

      {error ? <Notice>{error}</Notice> : null}
      <Button title="Сохранить приёмку" busy={saving} disabled={photoBusy || summary.trim().length < 3 || recommendationIncomplete} onPress={() => void save()}/>
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', justifyContent: 'space-between' },
  count: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  tile: { width: '31.5%', gap: 4 },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.s, backgroundColor: colors.surfaceRaised },
  caption: { color: colors.muted, fontSize: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  action: { flex: 1 },
  library: { minHeight: 52, justifyContent: 'center', paddingHorizontal: space.m },
  libraryText: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  summary: { minHeight: 96, paddingTop: 14, textAlignVertical: 'top' }
});
