import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams, useNavigation, usePreventRemove } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BODY_TYPES, carLayout, normalizeBodyType, type BodyType, type LayoutElement } from '@df/shared/carLayouts';
import type { IntakeFinding, PhotoAsset, WorkOrder } from '@df/types';
import { CarDiagram, findingMarks } from '@/features/car-diagram';
import { BodySheet, DotGround, ElementSheet, MarkCards, ZoneGrid, fitDiagram, onBody, type Entry } from '@/features/inspection';
import { pickPhoto } from '@/lib/photo';
import { useSession } from '@/lib/session';
import { cardShadow, floatShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Card, Field, Heading, Loading, Notice, Screen } from '@/ui';
import { RoundButton } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { ButtonPair } from '@/ui/sheet';
import { Text } from '@/ui/text';

/** The server keeps up to 19 intake photos per order. */
const PHOTO_LIMIT = 19;
type Step = 'body' | 'salon' | 'sum';
const STEPS: Step[] = ['body', 'salon', 'sum'];

/** Intake of an order in three steps: the body on the drawing, the interior, then the summary to show the customer. */
export default function IntakeScreen() {
  const { id, bodyType, title } = useLocalSearchParams<{ id: string; bodyType?: string; title?: string }>();
  const { api } = useSession();
  const { data: order, error, reload } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));

  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <IntakeForm key={order.id} order={order} vehicleBodyType={bodyType} title={title}/>;
}

function IntakeForm({ order, vehicleBodyType, title }: { order: WorkOrder; vehicleBodyType?: string; title?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const navigation = useNavigation();
  const intake = order.intake;
  const [step, setStep] = useState<Step>('body');
  const [bodyType, setBodyType] = useState<BodyType>(() => normalizeBodyType(intake?.bodyType ?? vehicleBodyType));
  const [findings, setFindings] = useState<IntakeFinding[]>(() => intake?.findings.map(({ zone, severity, note }) => ({ zone, severity, note })) ?? []);
  const [summary, setSummary] = useState(intake?.conditionSummary ?? 'Автомобиль принят при клиенте, комплектность проверена');
  const [summaryOpen, setSummaryOpen] = useState(Boolean(intake));
  const [recommendationTitle, setRecommendationTitle] = useState(intake?.recommendations[0]?.title ?? '');
  const [recommendationReason, setRecommendationReason] = useState(intake?.recommendations[0]?.reason ?? '');
  const [photos, setPhotos] = useState<PhotoAsset[]>(order.photos);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LayoutElement | null>(null);
  const [bodySheet, setBodySheet] = useState(false);
  const [room, setRoom] = useState({ width: 0, height: 0 });

  const layout = useMemo(() => carLayout(bodyType), [bodyType]);
  const marks = useMemo(() => findingMarks(findings), [findings]);
  const byName = useMemo(() => new Map(layout.elements.map((element) => [element.name, element])), [layout]);
  const entries: Entry[] = findings.map((finding, index) => ({ finding, index, element: byName.get(finding.zone) ?? null }))
    .sort((a, b) => (a.element?.number ?? 999) - (b.element?.number ?? 999));
  const bodyEntries = entries.filter((entry) => !entry.element || onBody(entry.element));
  const salonEntries = entries.filter((entry) => entry.element && !onBody(entry.element));
  const drawnCount = layout.elements.filter(onBody).length;
  const cleanParts = drawnCount - new Set(bodyEntries.map((entry) => entry.finding.zone)).size;
  const intakePhotos = photos.filter((photo) => photo.phase === 'intake');
  const recommendationIncomplete = Boolean(recommendationTitle.trim()) !== Boolean(recommendationReason.trim());
  const bodyLabel = BODY_TYPES.find((item) => item.code === bodyType)?.label ?? bodyType;

  const changeFindings = (next: IntakeFinding[]) => { setFindings(next); setDirty(true); };
  const touch = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setDirty(true); };

  // Photos are saved at once; the inspection is saved at the end. Leaving with changes asks first.
  usePreventRemove(dirty && !saving, ({ data }) => {
    Alert.alert('Выйти без сохранения?', 'Отметки и комментарий не сохранятся. Фото уже сохранены.', [
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

  const open = (element: LayoutElement) => { void Haptics.selectionAsync(); setSelected(element); };
  const position = STEPS.indexOf(step) + 1;
  const stepNote = step === 'body' ? `Кузов · ${bodyLabel.toLowerCase()}` : step === 'salon' ? 'Салон · нажмите на зону' : 'Итог · покажите клиенту';

  const head = (
    <View style={[styles.head, { paddingTop: insets.top + space.l }]}>
      <RoundButton icon="back" label="Назад к заказу" onPress={() => router.back()}/>
      <Pressable style={styles.headText} accessibilityRole={step === 'body' ? 'button' : undefined} accessibilityHint={step === 'body' ? 'Сменить тип кузова' : undefined}
        disabled={step !== 'body'} onPress={() => setBodySheet(true)}>
        <Text style={styles.headTitle} numberOfLines={1}>Приёмка{title ? ` · ${title}` : ''}</Text>
        <Text style={styles.headNote} numberOfLines={1}>{stepNote}{step === 'body' ? ' ▾' : ''}</Text>
      </Pressable>
      <View style={styles.counter}><Text style={styles.counterText}>{position}/3</Text></View>
    </View>
  );
  const tabs = step !== 'sum' ? (
    <View style={styles.tabsPlace} pointerEvents="box-none">
      <View style={styles.tabs} accessibilityRole="tablist" accessibilityLabel="Что осматриваем">
        {(['body', 'salon'] as const).map((value) => {
          const on = step === value;
          const count = value === 'body' ? bodyEntries.length : salonEntries.length;
          return (
            <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setStep(value)} style={[styles.tab, on && styles.tabOn]}>
              <Text style={[styles.tabText, on && styles.tabTextOn]}>{value === 'body' ? 'Кузов' : 'Салон'}{count ? ` · ${count}` : ''}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  ) : null;
  const sheets = <>
    <ElementSheet element={selected} findings={entries} onClose={() => setSelected(null)} photos={photos} photoBusy={photoBusy} photoError={error}
      onPhoto={(zone) => void addPhoto(zone)}
      onAdd={(finding) => { changeFindings([...findings, finding]); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }}
      onRemove={(index) => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); changeFindings(findings.filter((_, at) => at !== index)); }}/>
    <BodySheet visible={bodySheet} value={bodyType} options={BODY_TYPES} onChange={(code) => { setBodyType(normalizeBodyType(code)); setDirty(true); }} onClose={() => setBodySheet(false)}/>
  </>;

  if (step === 'body') return (
    <View style={styles.page}>
      <DotGround/>
      {head}
      {tabs}
      <View style={styles.stage} onLayout={(event) => setRoom({ width: event.nativeEvent.layout.width - 120, height: event.nativeEvent.layout.height - 24 })}>
        {room.height > 0 ? <CarDiagram layout={layout} marks={marks} selected={selected?.id} onSelect={open} width={fitDiagram(layout, room)}/> : null}
        <View style={styles.side}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Фото общего вида, снято ${intakePhotos.length}`} disabled={photoBusy} onPress={() => void addPhoto('Общий вид')} style={styles.sideButton}>
            <Icon name="camera" size={20}/>
            <View style={styles.sideBadge}><Text style={styles.sideBadgeText}>{intakePhotos.length}</Text></View>
          </Pressable>
        </View>
      </View>
      <View style={[styles.panel, { paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.handle}/>
        <View style={styles.panelHead}>
          <Text style={styles.panelTitle}>Отметки на кузове</Text>
          <Text style={styles.meta}>{bodyEntries.length ? `${cleanParts} деталей без замечаний` : 'замечаний нет'}</Text>
        </View>
        <MarkCards entries={bodyEntries} onOpen={open} hint="Нажмите на деталь, чтобы добавить"/>
        {error ? <View style={{ paddingHorizontal: space.l }}><Notice>{error}</Notice></View> : null}
        <View style={styles.panelButtons}>
          <ButtonPair>
            {bodyEntries.length ? null : <Button title="Без замечаний" tone="secondary" style={{ flex: 1 }} onPress={() => setStep('salon')}/>}
            <Button title="Дальше: салон" style={{ flex: 1.6 }} onPress={() => setStep('salon')}/>
          </ButtonPair>
        </View>
      </View>
      {sheets}
    </View>
  );

  if (step === 'salon') return (
    <View style={styles.page}>
      <DotGround/>
      {head}
      {tabs}
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <Heading>Салон и комплектность</Heading>
        <ZoneGrid elements={layout.elements.filter((element) => element.group === 'interior')} marks={marks} onOpen={open}/>
        {layout.elements.some((element) => element.group === 'other') ? <>
          <View style={styles.sectionHead}><Heading>Не видно на схеме</Heading><Text style={styles.meta}>отметьте при осмотре</Text></View>
          <ZoneGrid elements={layout.elements.filter((element) => element.group === 'other')} marks={marks} onOpen={open}/>
        </> : null}
        {salonEntries.length ? <>
          <Heading style={{ marginTop: 4 }}>Отметки в салоне</Heading>
          <View style={{ marginHorizontal: -space.l }}><MarkCards entries={salonEntries} onOpen={open} hint="Нажмите на зону, чтобы добавить"/></View>
        </> : null}
        <ButtonPair>
          <Button title="Назад к кузову" tone="secondary" style={{ flex: 1 }} onPress={() => setStep('body')}/>
          <Button title="Дальше: итог" style={{ flex: 1.4 }} onPress={() => setStep('sum')}/>
        </ButtonPair>
      </ScrollView>
      {sheets}
    </View>
  );

  return (
    <View style={styles.page}>
      {head}
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.tiles} accessibilityLabel="Итог приёмки">
          <Tile value={bodyEntries.length} label="замечания на кузове" color={colors.tilePeach}/>
          <Tile value={salonEntries.length} label="в салоне" color={colors.tileSky}/>
          <Tile value={intakePhotos.length} label="фото в акте" color={colors.tileSage}/>
        </View>

        {entries.length ? <Card style={{ gap: 10 }}>
          {entries.map(({ finding, index, element }) => (
            <Pressable key={index} accessibilityRole="button" disabled={!element} onPress={() => element && open(element)} style={styles.sumRow}>
              <Text style={styles.sumNumber}>{element?.number ?? '•'}</Text>
              <View style={{ flex: 1 }}><Text style={styles.sumPart}>{finding.zone}</Text><Text style={styles.meta}>{finding.note}</Text></View>
              <Icon name="chevronRight" size={16} color={colors.muted}/>
            </Pressable>
          ))}
        </Card> : <Card><Text style={styles.meta}>Замечаний нет: автомобиль принят без повреждений.</Text></Card>}

        <Heading style={{ marginTop: 4 }}>Предложить по итогам осмотра</Heading>
        <Card>
          <Field label="Что предложить" value={recommendationTitle} onChangeText={touch(setRecommendationTitle)} placeholder="Например, защита кузова" maxLength={120}/>
          <Field label="Почему" value={recommendationReason} onChangeText={touch(setRecommendationReason)} placeholder="Скол на капоте — снизит риск коррозии" maxLength={300}
            error={recommendationIncomplete ? 'Заполните оба поля или оставьте оба пустыми' : undefined}/>
        </Card>

        <View style={styles.sectionHead}><Heading>Фото приёмки</Heading><Text style={styles.meta}>{intakePhotos.length} из {PHOTO_LIMIT}</Text></View>
        {intakePhotos.length ? (
          <View style={styles.grid}>
            {intakePhotos.map((photo) => (
              <View key={photo.id} style={styles.tile}>
                <Image source={{ uri: photo.dataUrl }} style={styles.photo} contentFit="cover" accessibilityLabel={`Фото: ${photo.zone}`}/>
                <Text style={styles.meta} numberOfLines={1}>{photo.zone}</Text>
              </View>
            ))}
          </View>
        ) : <Text style={styles.meta}>Снимите общий вид автомобиля. Фото повреждения добавьте из отметки на детали.</Text>}
        <ButtonPair>
          <Button title="Снять общий вид" tone="secondary" busy={photoBusy} style={{ flex: 1.3 }} onPress={() => void addPhoto('Общий вид')}/>
          <Button title="Из галереи" tone="secondary" disabled={photoBusy} style={{ flex: 1 }} onPress={() => void addPhoto('Общий вид', 'library')}/>
        </ButtonPair>

        {summaryOpen
          ? <Field label="Комментарий к приёмке" value={summary} onChangeText={touch(setSummary)} multiline maxLength={500} style={styles.summary}
              error={summary.trim().length < 3 ? 'Опишите состояние автомобиля' : undefined}/>
          : <Button title="+ Комментарий к приёмке" tone="quiet" onPress={() => setSummaryOpen(true)}/>}

        {error ? <Notice>{error}</Notice> : null}
        <ButtonPair>
          <Button title="Назад" tone="secondary" style={{ flex: 1 }} onPress={() => setStep('salon')}/>
          <Button title="Завершить приёмку" busy={saving} style={{ flex: 1.6 }} disabled={photoBusy || summary.trim().length < 3 || recommendationIncomplete} onPress={() => void save()}/>
        </ButtonPair>
      </ScrollView>
      {sheets}
    </View>
  );
}

function Tile({ value, label, color }: { value: number; label: string; color: string }) {
  const styles = useStyles();
  return (
    <View style={[styles.sumTile, { backgroundColor: color }]}>
      <Text style={styles.sumValue}>{value}</Text>
      <Text style={styles.sumLabel}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.l },
  headText: { flex: 1, alignItems: 'center' },
  headTitle: { fontSize: 15, fontWeight: '500' },
  headNote: { fontSize: 12, color: colors.muted },
  counter: { minWidth: 44, height: 44, paddingHorizontal: 10, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  counterText: { fontSize: 13, fontWeight: '500', fontVariant: ['tabular-nums'] },
  tabsPlace: { alignItems: 'center', marginTop: 12 },
  tabs: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 22, backgroundColor: colors.surface, ...cardShadow(scheme) },
  tab: { height: 34, paddingHorizontal: 18, borderRadius: 17, justifyContent: 'center' },
  tabOn: { backgroundColor: colors.pill },
  tabText: { fontSize: 13, fontWeight: '500' },
  tabTextOn: { color: colors.pillInk },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  side: { position: 'absolute', left: space.l, top: '40%', gap: space.s },
  sideButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  sideBadge: { position: 'absolute', right: -6, top: -4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  sideBadgeText: { color: colors.accentInk, fontSize: 10, fontWeight: '600' },
  panel: { backgroundColor: colors.surface, borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingTop: 10, gap: 14, ...floatShadow(scheme) },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 20 },
  panelTitle: { fontSize: 17, fontWeight: '500' },
  panelButtons: { paddingHorizontal: space.l },
  meta: { color: colors.muted, fontSize: 13 },
  scroll: { padding: space.l, gap: 14 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  tiles: { flexDirection: 'row', gap: space.s },
  sumTile: { flex: 1, borderRadius: radius.m, padding: 14, gap: 2 },
  sumValue: { color: colors.tileInk, fontSize: 30, fontWeight: '500', fontVariant: ['tabular-nums'] },
  sumLabel: { color: colors.tileInk, fontSize: 12, opacity: 0.75 },
  sumRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  sumNumber: { width: 24, fontSize: 13, fontWeight: '700', color: colors.muted, textAlign: 'center' },
  sumPart: { fontSize: 15, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  tile: { width: '31.5%', gap: 4 },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.s, backgroundColor: colors.soft },
  summary: { minHeight: 96, paddingTop: 14, textAlignVertical: 'top' }
}));
