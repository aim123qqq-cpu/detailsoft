import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { productFeatures } from './features';
import { OrderDocumentsPanel } from './OrderDocuments';
import { ShareOrderButton } from './ShareOrderButton';
import { pluralRu } from './format';
import { InspectionPanel } from './intake/InspectionPanel';
import { normalizeBodyType, type BodyType } from './shared/carLayouts';

type MasterOption = { id: string; displayName: string; activeOrders: number };
import type { Booking, Customer, EstimateLineInput, IntakeFinding, OrderRecommendation, Vehicle, WorkOrder } from './types';

function money(amountMinor: number) {
  return `${Math.round(amountMinor / 100).toLocaleString('ru-RU')} ₽`;
}

const supportedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function readFileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать фотографию'));
    reader.readAsDataURL(file);
  });
}

async function preparePhoto(file: File) {
  if (!supportedPhotoTypes.has(file.type)) throw new Error('Выберите фотографию JPG, PNG или WebP');
  const original = await readFileDataUrl(file);
  if (file.size <= 600 * 1024) return original;

  const image = new Image();
  image.src = original;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Не удалось обработать фотографию'));
  });
  const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const optimized = canvas.toDataURL('image/jpeg', 0.76);
  if (optimized.length > 950_000) throw new Error('Фото слишком большое — выберите снимок меньшего размера');
  return optimized;
}

export function OrderFlow({ booking, customer, vehicle, onPhaseChange, orderId = null }: {
  booking: Booking;
  customer: Customer;
  vehicle: Vehicle;
  onPhaseChange: (title: string) => void;
  orderId?: string | null;
}) {
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [stage, setStage] = useState<'intake' | 'estimate' | 'approval'>('intake');
  const [summary, setSummary] = useState('Автомобиль принят при клиенте, комплектность проверена');
  const [inspectionTab, setInspectionTab] = useState<'inspection' | 'photo' | 'recommendations'>('inspection');
  const [bodyType, setBodyType] = useState<BodyType>(() => normalizeBodyType(vehicle.bodyType));
  const [findings, setFindings] = useState<IntakeFinding[]>([]);
  const [recommendationTitle, setRecommendationTitle] = useState('Локальная защита скола');
  const [recommendationReason, setRecommendationReason] = useState('Снизит риск коррозии повреждённого участка');
  const [extraAmount, setExtraAmount] = useState('900');
  const [responsible, setResponsible] = useState('Анна, администратор');
  const [method, setMethod] = useState<'in_person' | 'phone' | 'messenger'>('in_person');
  const [masters, setMasters] = useState<MasterOption[] | null>(null);
  const [masterId, setMasterId] = useState('');
  const [pauseNote, setPauseNote] = useState('Ожидаем освобождения зоны сушки');
  const [qcResponsible, setQcResponsible] = useState('Мария, QC');
  const [qcNote, setQcNote] = useState('Все поверхности проверены при рабочем освещении');
  const [qcChecks, setQcChecks] = useState([
    { code: 'body', label: 'Кузов без разводов и остатков состава', passed: true },
    { code: 'interior', label: 'Салон и стёкла чистые', passed: true },
    { code: 'handover', label: 'Комплектность и фото проверены', passed: true }
  ]);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [handoverResponsible, setHandoverResponsible] = useState('Анна, администратор');
  const [handoverNote, setHandoverNote] = useState('Клиент осмотрел автомобиль и принял результат работ');
  const [customerAccepted, setCustomerAccepted] = useState(false);
  const [completenessChecked, setCompletenessChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // An existing order is only read (masters may not create orders); a new intake creates it idempotently.
    (orderId ? api.getOrder(orderId) : api.createOrder(booking.id))
      .then((created) => {
        setOrder(created);
        if (created.intake) {
          setFindings(created.intake.findings.map(({ zone, severity, note }) => ({ zone, severity, note })));
          if (created.intake.bodyType) setBodyType(normalizeBodyType(created.intake.bodyType));
        }
        if (created.status === 'APPROVED') setStage('approval');
        else if (created.estimateVersions.length) setStage('approval');
        else if (created.intake) setStage('estimate');
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [booking.id, orderId]);

  // Changes made offline were just accepted: show the server's version (real photo ids, times).
  const loadedOrderId = order?.id;
  useEffect(() => {
    if (!loadedOrderId) return;
    const reload = () => { api.getOrder(loadedOrderId).then(setOrder).catch(() => {}); };
    window.addEventListener('detailflow:synced', reload);
    return () => window.removeEventListener('detailflow:synced', reload);
  }, [loadedOrderId]);

  // Masters come from the team (active members with the master role), least loaded first.
  const needsMaster = order?.status === 'APPROVED' && !order.assignment;
  useEffect(() => {
    if (!needsMaster) return;
    const controller = new AbortController();
    api.listMasters(controller.signal)
      .then((result) => { setMasters(result.items); setMasterId((current) => current || result.items[0]?.id || ''); })
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setMasters([]); });
    return () => controller.abort();
  }, [needsMaster]);

  useEffect(() => {
    if (!order) return;
    if (order.status === 'IN_PROGRESS') onPhaseChange('Работы мастера');
    else if (order.status === 'QC') onPhaseChange('Контроль качества (архив)');
    else if (order.status === 'CLOSED') onPhaseChange('Заказ закрыт');
    else if (order.status === 'READY') onPhaseChange(deliveryOpen ? 'Выдача автомобиля' : 'Готов к выдаче');
    else if (order.status === 'APPROVED') onPhaseChange('Назначение мастера');
    else if (stage === 'estimate') onPhaseChange('Смета заказа');
    else if (stage === 'approval') onPhaseChange('Согласование сметы');
    else onPhaseChange('Приёмка автомобиля');
  }, [deliveryOpen, onPhaseChange, order, stage]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [order?.status, stage]);

  const recommendations = useMemo<OrderRecommendation[]>(() => recommendationTitle.trim() ? [{
    title: recommendationTitle,
    reason: recommendationReason,
    priority: 'RECOMMENDED'
  }] : [], [recommendationTitle, recommendationReason]);

  const estimateLines = useMemo<EstimateLineInput[]>(() => {
    const base = booking.lines.filter((line) => line.amountMinor > 0).map((line) => ({
      sourceType: line.type,
      sourceId: line.id,
      name: line.name,
      amountMinor: line.amountMinor,
      durationMinutes: line.durationMinutes
    } satisfies EstimateLineInput));
    const amountMinor = Math.round(Number(extraAmount.replace(/\D/g, '')) * 100);
    return amountMinor > 0 && recommendationTitle.trim() ? [...base, {
      sourceType: 'recommendation',
      name: recommendationTitle.trim(),
      amountMinor,
      durationMinutes: 25,
      reason: recommendationReason.trim()
    }] : base;
  }, [booking.lines, extraAmount, recommendationReason, recommendationTitle]);

  const saveIntake = async () => {
    if (!order) return;
    setLoading(true); setError('');
    try {
      const updated = await api.saveIntake(order.id, { conditionSummary: summary, findings, recommendations, bodyType });
      setOrder(updated); setStage('estimate');
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setLoading(false); }
  };

  const uploadPhoto = async (file: File | undefined, kind: 'intake' | 'defect', phase: 'intake' | 'result' = 'intake', zone = 'Общий вид') => {
    if (!order || !file) return;
    setPhotoUploading(true); setError('');
    try {
      const photo = await api.uploadOrderPhoto(order.id, {
        phase,
        kind,
        zone: phase === 'result' ? 'Результат работ' : zone,
        dataUrl: await preparePhoto(file)
      });
      setOrder((current) => current ? { ...current, photos: [...current.photos, photo] } : current);
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setPhotoUploading(false); }
  };

  const createEstimate = async () => {
    if (!order) return;
    setLoading(true); setError('');
    try {
      const estimate = await api.createEstimate(order.id, estimateLines);
      setOrder({ ...order, currentEstimateVersionId: estimate.id, estimateVersions: [...order.estimateVersions, estimate] });
      setStage('approval');
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setLoading(false); }
  };

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    if (!order?.currentEstimateVersionId) return;
    setLoading(true); setError('');
    try {
      setOrder(await api.decideEstimate(order.id, {
        estimateVersionId: order.currentEstimateVersionId,
        decision,
        method,
        source: 'manager_mobile',
        responsible
      }));
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setLoading(false); }
  };

  const runOrderAction = async (action: () => Promise<WorkOrder>) => {
    setLoading(true); setError('');
    try { setOrder(await action()); }
    catch (requestError) { setError((requestError as Error).message); }
    finally { setLoading(false); }
  };

  const assignMaster = () => order && masterId && runOrderAction(() => api.assignMaster(order.id, masterId));
  const startWork = () => order && runOrderAction(() => api.startWork(order.id));
  const toggleOperation = (operationId: string, done: boolean) => order &&
    runOrderAction(() => api.updateWorkOperation(order.id, operationId, done ? 'PENDING' : 'DONE'));
  const togglePause = () => order?.work && runOrderAction(() => order.work?.status === 'PAUSED'
    ? api.resumeWork(order.id)
    : api.pauseWork(order.id, pauseNote));
  const completeWork = () => order && runOrderAction(() => api.completeWork(order.id));
  const submitQc = (decision: 'PASSED' | 'REWORK') => order && runOrderAction(() => api.submitQualityControl(order.id, {
    decision, responsible: qcResponsible, note: qcNote, checks: qcChecks
  }));
  const openDelivery = () => setDeliveryOpen(true);
  const closeOrder = () => order && runOrderAction(() => api.closeOrder(order.id, {
    responsible: handoverResponsible, note: handoverNote, customerAccepted, completenessChecked
  }));

  if (loading && !order) return <section className="screen order-loading"><span className="spinner"/> Создаём заказ из записи</section>;
  if (!order) return <section className="screen"><div className="inline-error">{error || 'Не удалось создать заказ'}</div></section>;
  const refreshOrder = () => {
    api.getOrder(order.id).then(setOrder).catch((requestError: Error) => setError(requestError.message));
  };
  const currentEstimate = order.estimateVersions.find((item) => item.id === order.currentEstimateVersionId);
  const intakePhoto = order.photos.find((photo) => photo.phase === 'intake');
  const resultPhoto = order.photos.find((photo) => photo.phase === 'result');

  if (order.status === 'CLOSED') return (
    <section className="screen closed-screen" data-testid="order-closed">
      <span className="ready-orbit"><i>✓</i></span>
      <span className="confirmation-kicker">Автомобиль передан клиенту</span>
      <h2>Заказ закрыт</h2>
      <p>{vehicle.make} {vehicle.model} · {vehicle.plate}</p>
      <div className="closed-receipt">
        <div><span>Статус</span><strong>Выдан</strong></div>
        <div><span>{order.qualityControl.length ? 'Контроль качества' : 'Работы'}</span><strong>{order.qualityControl.length ? 'Пройден' : 'Выполнены'}</strong></div>
        <div><span>Выдал</span><strong>{order.handover?.responsible}</strong></div>
      </div>
      <div className="handover-proof">✓ {order.handover?.note}</div>
      <div className="audit-note">{order.auditTrail.length
        ? `Заказ и выдача зафиксированы в журнале · ${order.auditTrail.length} ${pluralRu(order.auditTrail.length, 'событие', 'события', 'событий')}`
        : 'Журнал заполнится, когда изменения дойдут до сервера'}</div>
      <ShareOrderButton order={order} vehicle={vehicle}/>
      <OrderDocumentsPanel order={order} defaultSigner={customer.name} onChanged={refreshOrder}/>
    </section>
  );

  if (order.status === 'READY' && deliveryOpen) return (
    <section className="screen delivery-screen" data-testid="order-delivery">
      <div className="production-top"><span>Выдача автомобиля</span><b>READY</b></div>
      <div className="order-hero"><small>{customer.name}</small><strong>{vehicle.make} {vehicle.model}</strong><span>{vehicle.plate} · {vehicle.color}</span></div>
      <div className="delivery-photos">
        <div className={!intakePhoto ? 'missing' : ''}>{intakePhoto ? <img src={intakePhoto.dataUrl} alt={`Автомобиль до работ, ${intakePhoto.zone}`}/> : <span className="delivery-photo-empty">Нет фото приёмки</span>}<small>До работ</small></div>
        <label className={!resultPhoto ? 'missing' : ''}>{resultPhoto ? <img src={resultPhoto.dataUrl} alt="Автомобиль после работ"/> : <span className="delivery-photo-empty">{photoUploading ? 'Загрузка…' : '＋ Добавить фото'}</span>}<small>После работ</small><input data-testid="result-photo-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={photoUploading || Boolean(resultPhoto)} onChange={(event) => { void uploadPhoto(event.target.files?.[0], 'intake', 'result'); event.target.value = ''; }}/></label>
      </div>
      <div className="handover-checklist">
        <span className="delivery-label">Перед выдачей</span>
        <button type="button" aria-pressed={customerAccepted} className={customerAccepted ? 'checked' : 'pending'} onClick={() => setCustomerAccepted((value) => !value)}><i>{customerAccepted ? '✓' : '!'}</i><span>Клиент осмотрел результат работ</span></button>
        <div className={intakePhoto && resultPhoto ? '' : 'pending'}><i>{intakePhoto && resultPhoto ? '✓' : '!'}</i><span>{intakePhoto && resultPhoto ? 'Фото до и после прикреплены' : 'Добавьте фото до и после работ'}</span></div>
        <button type="button" aria-pressed={completenessChecked} className={completenessChecked ? 'checked' : 'pending'} onClick={() => setCompletenessChecked((value) => !value)}><i>{completenessChecked ? '✓' : '!'}</i><span>Комплектность автомобиля проверена</span></button>
      </div>
      <label className="order-field">Ответственный<input value={handoverResponsible} onChange={(event) => setHandoverResponsible(event.target.value)}/></label>
      <label className="order-field">Комментарий к выдаче<textarea value={handoverNote} onChange={(event) => setHandoverNote(event.target.value)}/></label>
      {error && <div className="inline-error">{error}</div>}
      <button className="primary-button close-order-button" data-testid="close-order" disabled={loading || !intakePhoto || !resultPhoto || !customerAccepted || !completenessChecked || handoverResponsible.trim().length < 2 || handoverNote.trim().length < 2} onClick={closeOrder}>Выдать автомобиль и закрыть заказ →</button>
    </section>
  );

  if (order.status === 'READY') return (
    <section className="screen ready-screen" data-testid="order-ready">
      <span className="ready-orbit"><i>✓</i></span>
      <span className="confirmation-kicker">{order.qualityControl.length ? 'Контроль качества пройден' : 'Все работы выполнены'}</span>
      <h2>Автомобиль готов к выдаче</h2>
      <p>{vehicle.make} {vehicle.model} · {vehicle.plate}</p>
      <div className="ready-summary">
        <div><span>Мастер</span><strong>{order.assignment?.masterName}</strong></div>
        <div><span>Операции</span><strong>{order.work?.operations.length} выполнено</strong></div>
        <div><span>{order.qualityControl.length ? 'QC' : 'Статус работ'}</span><strong>{order.qualityControl.at(-1)?.responsible ?? 'Завершены'}</strong></div>
        <div><span>Статус</span><strong>Готов к выдаче</strong></div>
      </div>
      <div className="ready-timeline"><span className="done">Приёмка</span><span className="done">Смета</span><span className="done">Работы</span><span className="active">Выдача</span></div>
      <button className="primary-button" data-testid="open-delivery" onClick={openDelivery}>Перейти к выдаче →</button>
    </section>
  );

  if (productFeatures.qualityControl && order.status === 'QC') return (
    <section className="screen qc-screen" data-testid="order-qc">
      <div className="production-top"><span>Контроль качества</span><b>QC</b></div>
      <div className="order-hero"><small>{order.assignment?.masterName} завершил работы</small><strong>{vehicle.make} {vehicle.model}</strong><span>{vehicle.plate} · {order.work?.operations.length} операций</span></div>
      <div className="qc-heading"><span>Финальная проверка</span><h2>Проверьте результат</h2><p>Непройденный пункт вернёт заказ мастеру как обязательную доработку.</p></div>
      <div className="qc-checklist">{qcChecks.map((check, index) => <button key={check.code} className={check.passed ? 'passed' : ''} onClick={() => setQcChecks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, passed: !item.passed } : item))}><i>{check.passed ? '✓' : '!'}</i><span>{check.label}</span><em>{check.passed ? 'Пройдено' : 'Замечание'}</em></button>)}</div>
      <label className="order-field">Ответственный QC<input data-testid="qc-responsible" value={qcResponsible} onChange={(event) => setQcResponsible(event.target.value)}/></label>
      <label className="order-field">Комментарий<textarea value={qcNote} onChange={(event) => setQcNote(event.target.value)}/></label>
      {error && <div className="inline-error">{error}</div>}
      <div className="qc-actions"><button data-testid="qc-rework" disabled={loading || qcChecks.every((item) => item.passed)} onClick={() => submitQc('REWORK')}>Вернуть мастеру</button><button data-testid="qc-pass" disabled={loading || qcChecks.some((item) => !item.passed)} onClick={() => submitQc('PASSED')}>Допустить к выдаче ✓</button></div>
    </section>
  );

  if (order.status === 'IN_PROGRESS' && order.work) {
    const completedCount = order.work.operations.filter((operation) => operation.status === 'DONE').length;
    const completion = Math.round(completedCount / order.work.operations.length * 100);
    return (
      <section className="screen work-screen" data-testid="master-work">
        <div className="production-top"><span>Работы мастера</span><b className={order.work.status === 'PAUSED' ? 'paused' : ''}>{order.work.status === 'PAUSED' ? 'Пауза' : 'В работе'}</b></div>
        <div className="work-vehicle"><span className="work-car-icon">⌁</span><span><small>{vehicle.plate}</small><strong>{vehicle.make} {vehicle.model}</strong><em>{vehicle.color}</em></span><i>{completion}%</i></div>
        <div className="work-progress"><span style={{ width: `${completion}%` }}/></div>
        <div className="master-line"><span className="master-avatar">ДС</span><span><small>Исполнитель</small><strong>{order.assignment?.masterName}</strong></span><em>{completedCount}/{order.work.operations.length}</em></div>
        <div className="operation-heading"><span>Чек-лист работ</span><b>{completedCount} выполнено</b></div>
        <div className="work-operations">{order.work.operations.map((operation, index) => <button key={operation.id} data-testid={`work-operation-${index}`} className={`${operation.status === 'DONE' ? 'done' : ''} ${operation.source === 'qc_rework' ? 'rework' : ''}`} disabled={loading || order.work?.status === 'PAUSED'} onClick={() => toggleOperation(operation.id, operation.status === 'DONE')}><i>{operation.status === 'DONE' ? '✓' : index + 1}</i><span><strong>{operation.name}</strong><small>{operation.source === 'qc_rework' ? 'Возврат с контроля качества' : money(operation.amountMinor)}</small></span><em>{operation.status === 'DONE' ? 'Готово' : 'Выполнить'}</em></button>)}</div>
        {order.work.status === 'ACTIVE' && <label className="pause-note">Причина паузы<input value={pauseNote} onChange={(event) => setPauseNote(event.target.value)}/></label>}
        {error && <div className="inline-error">{error}</div>}
        <div className="work-actions"><button data-testid="toggle-work-pause" disabled={loading} onClick={togglePause}>{order.work.status === 'PAUSED' ? '▶ Продолжить' : 'Ⅱ Пауза'}</button><button data-testid="complete-work" disabled={loading || completedCount !== order.work.operations.length || order.work.status === 'PAUSED'} onClick={completeWork}>{productFeatures.qualityControl ? 'Передать в QC →' : 'Завершить работы →'}</button></div>
      </section>
    );
  }

  if (order.status === 'APPROVED') return (
    <section className="screen order-approved" data-testid="order-approved">
      <span className="confirmation-mark">✓</span>
      <span className="confirmation-kicker">Смета согласована</span>
      <h2>Заказ готов к передаче мастеру</h2>
      <p>Зафиксированы версия, способ согласования и ответственный сотрудник.</p>
      <div className="order-hero"><small>Заказ</small><strong>№ {order.id.replace('order_', '').slice(0, 8).toUpperCase()}</strong><span>{vehicle.make} {vehicle.model} · {vehicle.plate}</span></div>
      <div className="approval-proof">
        <div><span>Версия сметы</span><strong>v{currentEstimate?.version}</strong></div>
        <div><span>Сумма</span><strong>{money(currentEstimate?.totalAmountMinor ?? 0)}</strong></div>
        <div><span>Способ</span><strong>{order.approval?.method === 'in_person' ? 'Лично' : order.approval?.method}</strong></div>
        <div><span>Ответственный</span><strong>{order.approval?.responsible}</strong></div>
      </div>
      <div className="audit-note">Событие сохранено в журнале заказа · {order.auditTrail.length} записи</div>
      <div className="assignment-panel">
        <span>Следующий этап</span><h3>{order.assignment ? 'Мастер назначен' : 'Назначьте мастера'}</h3>
        {!order.assignment ? <>
          {masters === null && <div className="workspace-state"><span className="spinner"/> Загружаем мастеров</div>}
          {masters?.length === 0 && <p className="master-empty" role="note">В команде нет активных мастеров. Добавьте сотрудника с ролью «Мастер» в разделе «Профиль → Команда».</p>}
          {masters && masters.length > 0 && <div className="master-options">{masters.map((master) => <button key={master.id} data-testid={`master-option-${master.id}`} aria-pressed={masterId === master.id} className={masterId === master.id ? 'selected' : ''} onClick={() => setMasterId(master.id)}><i>{master.displayName.split(' ').slice(0, 2).map((part) => part[0]).join('')}</i><span>{master.displayName}<small>{master.activeOrders ? `${master.activeOrders} ${pluralRu(master.activeOrders, 'заказ', 'заказа', 'заказов')} в работе` : 'Свободен'}</small></span></button>)}</div>}
          <button className="primary-button" data-testid="assign-master" disabled={loading || !masterId} onClick={assignMaster}>Назначить мастера →</button>
        </> : <>
          <div className="assigned-master"><span className="master-avatar">ДС</span><span><strong>{order.assignment.masterName}</strong><small>Получит {order.work?.operations.length ?? currentEstimate?.lines.length} операции</small></span><b>Назначен</b></div>
          <button className="primary-button" data-testid="start-work" disabled={loading} onClick={startWork}>Начать работы →</button>
        </>}
      </div>
      {error && <div className="inline-error">{error}</div>}
    </section>
  );

  return (
    <section className="screen order-flow" data-testid={`order-${stage}`}>
      <div className="order-status-row"><span>Заказ открыт</span><b>{order.status === 'INTAKE' ? 'Приёмка' : 'Смета'}</b></div>
      <div className="order-hero"><small>{customer.name}</small><strong>{vehicle.make} {vehicle.model} {vehicle.generation}</strong><span>{vehicle.plate} · {vehicle.color}</span></div>

      {stage === 'intake' && <>
        <div className="inspection-tabs" role="group" aria-label="Раздел приёмки">
          <button aria-pressed={inspectionTab === 'inspection'} className={inspectionTab === 'inspection' ? 'active' : ''} onClick={() => setInspectionTab('inspection')}>Осмотр</button>
          <button aria-pressed={inspectionTab === 'photo'} className={inspectionTab === 'photo' ? 'active' : ''} onClick={() => setInspectionTab('photo')}>Фото <span>{order.photos.length}</span></button>
          <button aria-pressed={inspectionTab === 'recommendations'} className={inspectionTab === 'recommendations' ? 'active' : ''} onClick={() => setInspectionTab('recommendations')}>Рекомендации <span>1</span></button>
        </div>

        {inspectionTab === 'inspection' && <>
          <InspectionPanel bodyType={bodyType} onBodyType={setBodyType} findings={findings} onFindings={setFindings}
            photos={order.photos} photoUploading={photoUploading} onPhoto={(file, elementName) => void uploadPhoto(file, 'defect', 'intake', elementName)}/>

          <label className="intake-summary-line">Комментарий к приёмке<textarea data-testid="intake-summary" value={summary} onChange={(event) => setSummary(event.target.value)}/></label>
        </>}

        {inspectionTab === 'photo' && <div className="photo-tab-panel"><div className="photo-tab-head"><span>Фото приёмки · {order.photos.length}</span><label className="photo-add-text">{photoUploading ? 'Загрузка…' : '＋ Добавить'}<input data-testid="intake-photo-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={photoUploading} onChange={(event) => { void uploadPhoto(event.target.files?.[0], 'intake'); event.target.value = ''; }}/></label></div>
          {order.photos.some((photo) => photo.phase === 'intake') ? <div className="photo-grid">{order.photos.filter((photo) => photo.phase === 'intake').map((photo) => <figure key={photo.id}><img src={photo.dataUrl} alt={`Фото зоны ${photo.zone}`}/><figcaption>{photo.zone}</figcaption></figure>)}</div> : <div className="photo-empty"><span>▧</span><strong>Снимков пока нет</strong><small>Добавьте общий вид автомобиля или фото выбранной зоны</small></div>}
          <p>Общие снимки сохраняются как «Общий вид». Фото конкретного элемента добавьте на вкладке «Осмотр».</p></div>}

        {inspectionTab === 'recommendations' && <div className="recommendation-card"><span>Рекомендация клиенту</span><input data-testid="recommendation-title" value={recommendationTitle} onChange={(event) => setRecommendationTitle(event.target.value)}/><textarea value={recommendationReason} onChange={(event) => setRecommendationReason(event.target.value)}/></div>}
        {error && <div className="inline-error">{error}</div>}
        <div className="intake-actions"><button>Сохранить черновик</button><button data-testid="save-intake" disabled={loading || !summary.trim()} onClick={saveIntake}>Перейти к смете →</button></div>
      </>}

      {stage === 'estimate' && <>
        <OrderDocumentsPanel order={order} types={['intake_act']} defaultSigner={customer.name} onChanged={refreshOrder}/>
        <div className="flow-heading"><span>02 · Версия сметы</span><h2>Проверьте состав работ</h2><p>После выпуска строки версии нельзя изменить.</p></div>
        <div className="estimate-list">
          {booking.lines.filter((line) => line.amountMinor > 0).map((line) => <div key={line.id}><span><strong>{line.name}</strong><small>из записи</small></span><b>{money(line.amountMinor)}</b></div>)}
          <div className="estimate-extra"><span><strong>{recommendationTitle}</strong><small>по результатам осмотра</small></span><label><input data-testid="extra-amount" inputMode="numeric" value={extraAmount} onChange={(event) => setExtraAmount(event.target.value)}/><em>₽</em></label></div>
        </div>
        <div className="estimate-total"><span>Итого, версия {order.estimateVersions.length + 1}</span><strong>{money(estimateLines.reduce((sum, line) => sum + line.amountMinor, 0))}</strong></div>
        {error && <div className="inline-error">{error}</div>}
        <button className="primary-button" data-testid="create-estimate" disabled={loading || !estimateLines.length} onClick={createEstimate}>Выпустить смету →</button>
      </>}

      {stage === 'approval' && currentEstimate && <>
        <div className="flow-heading"><span>03 · Согласование</span><h2>Решение клиента</h2><p>Согласуется только актуальная версия v{currentEstimate.version}.</p></div>
        <div className="estimate-sheet">
          <div className="sheet-number">Смета v{currentEstimate.version}<span>{currentEstimate.lines.length} позиции</span></div>
          {currentEstimate.lines.map((line) => <div className="sheet-line" key={line.id}><span>{line.name}</span><strong>{money(line.amountMinor)}</strong></div>)}
          <div className="sheet-total"><span>Итого по смете</span><strong>{money(currentEstimate.totalAmountMinor)}</strong></div>
        </div>
        <label className="order-field">Ответственный<input data-testid="approval-responsible" value={responsible} onChange={(event) => setResponsible(event.target.value)}/></label>
        <div className="approval-methods">{([['in_person', 'Лично'], ['phone', 'Телефон'], ['messenger', 'Мессенджер']] as const).map(([value, label]) => <button key={value} className={method === value ? 'selected' : ''} onClick={() => setMethod(value)}>{label}</button>)}</div>
        {error && <div className="inline-error">{error}</div>}
        <div className="decision-actions"><button data-testid="reject-estimate" disabled={loading} onClick={() => decide('REJECTED')}>Отклонено</button><button data-testid="approve-estimate" disabled={loading || !responsible.trim()} onClick={() => decide('APPROVED')}>Согласовано ✓</button></div>
      </>}
    </section>
  );
}
