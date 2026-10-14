import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { productFeatures } from './features';
import type { Booking, Customer, EstimateLineInput, IntakeFinding, OrderRecommendation, Vehicle, WorkOrder } from './types';

function money(amountMinor: number) {
  return `${Math.round(amountMinor / 100).toLocaleString('ru-RU')} ₽`;
}

const inspectionZones = [
  { id: 'Кузов', icon: '▱' },
  { id: 'Диски', icon: '◉' },
  { id: 'Стёкла', icon: '▰' },
  { id: 'Салон', icon: '◇' },
  { id: 'Прочее', icon: '•••' }
] as const;

const zoneDefaults: Record<string, { area: string; note: string }> = {
  Кузов: { area: 'Переднее крыло', note: 'Скол лакокрасочного покрытия справа' },
  Диски: { area: 'Передний левый диск', note: 'Бордюрная царапина на ободе' },
  Стёкла: { area: 'Лобовое стекло', note: 'Мелкий скол в нижней части' },
  Салон: { area: 'Водительское сиденье', note: 'Локальное загрязнение обивки' },
  Прочее: { area: 'Комплектность', note: 'Требуется уточнение при передаче' }
};

const quickFindings = [
  { zone: 'Кузов', severity: 'LOW' as const, note: 'Битумные загрязнения на дисках и крыльях' },
  { zone: 'Кузов', severity: 'MEDIUM' as const, note: 'Сильные загрязнения кузова' },
  { zone: 'Стёкла', severity: 'LOW' as const, note: 'Шерсть в салоне' }
];

function InspectionCar({ activeZone }: { activeZone: string }) {
  return (
    <svg className="inspection-car" viewBox="0 0 150 260" role="img" aria-label={`Схема автомобиля, зона ${activeZone}`}>
      <defs>
        <linearGradient id="carBody" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#aab0b4"/><stop offset=".46" stopColor="#4f575d"/><stop offset="1" stopColor="#20272c"/></linearGradient>
        <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#253039"/><stop offset="1" stopColor="#0b1116"/></linearGradient>
      </defs>
      <path className="car-shadow" d="M38 18C48 5 102 5 112 18l14 39 8 132-12 49c-4 14-90 14-94 0l-12-49L24 57Z"/>
      <path className="car-body" d="M42 14C52 5 98 5 108 14l15 41 7 132-14 51c-8 12-74 12-82 0l-14-51 7-132Z"/>
      <path className="car-glass" d="M45 48c7-17 53-17 60 0l9 41H36Z"/>
      <path className="car-glass rear" d="M37 170h76l-9 44c-9 14-49 14-58 0Z"/>
      <path className="car-roof" d="M37 94h77l-2 70H38Z"/>
      <path className="car-line" d="M75 94v70M27 130h11m74 0h11M37 94l-10-39m87 39 9-39"/>
      <path className="wheel" d="M15 62h11v38H15zm109 0h11v38h-11zM15 172h11v38H15zm109 0h11v38h-11z"/>
      <circle className="damage-pin" cx="31" cy="72" r="8"/><text x="31" y="75">1</text>
      <circle className="damage-pin secondary" cx="104" cy="33" r="8"/><text x="104" y="36">2</text>
      <circle className="damage-pin secondary" cx="51" cy="215" r="8"/><text x="51" y="218">3</text>
    </svg>
  );
}

export function OrderFlow({ booking, customer, vehicle, onPhaseChange }: { booking: Booking; customer: Customer; vehicle: Vehicle; onPhaseChange: (title: string) => void }) {
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [stage, setStage] = useState<'intake' | 'estimate' | 'approval'>('intake');
  const [summary, setSummary] = useState('Автомобиль принят при клиенте, комплектность проверена');
  const [zone, setZone] = useState('Кузов');
  const [inspectionTab, setInspectionTab] = useState<'inspection' | 'photo' | 'recommendations'>('inspection');
  const [selectedArea, setSelectedArea] = useState('Переднее крыло');
  const [checkedFindings, setCheckedFindings] = useState(() => new Set([0, 1, 2]));
  const [severity, setSeverity] = useState<IntakeFinding['severity']>('MEDIUM');
  const [note, setNote] = useState('Скол лакокрасочного покрытия справа');
  const [recommendationTitle, setRecommendationTitle] = useState('Локальная защита скола');
  const [recommendationReason, setRecommendationReason] = useState('Снизит риск коррозии повреждённого участка');
  const [extraAmount, setExtraAmount] = useState('900');
  const [responsible, setResponsible] = useState('Анна, администратор');
  const [method, setMethod] = useState<'in_person' | 'phone' | 'messenger'>('in_person');
  const [masterName, setMasterName] = useState('Дмитрий Соколов');
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.createOrder(booking.id)
      .then((created) => {
        setOrder(created);
        if (created.status === 'APPROVED') setStage('approval');
        else if (created.estimateVersions.length) setStage('approval');
        else if (created.intake) setStage('estimate');
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [booking.id]);

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

  const findings = useMemo<IntakeFinding[]>(() => [
    { zone: selectedArea, severity, note },
    ...quickFindings.filter((_, index) => checkedFindings.has(index))
  ], [selectedArea, severity, note, checkedFindings]);

  const selectZone = (nextZone: string) => {
    setZone(nextZone);
    setSelectedArea(zoneDefaults[nextZone].area);
    setNote(zoneDefaults[nextZone].note);
  };
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
      const updated = await api.saveIntake(order.id, { conditionSummary: summary, findings, recommendations });
      setOrder(updated); setStage('estimate');
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setLoading(false); }
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

  const assignMaster = () => order && runOrderAction(() => api.assignMaster(order.id, masterName));
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
    responsible: handoverResponsible, note: handoverNote
  }));

  if (loading && !order) return <section className="screen order-loading"><span className="spinner"/> Создаём заказ из записи</section>;
  if (!order) return <section className="screen"><div className="inline-error">{error || 'Не удалось создать заказ'}</div></section>;
  const currentEstimate = order.estimateVersions.find((item) => item.id === order.currentEstimateVersionId);

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
      <div className="audit-note">Заказ и выдача зафиксированы в журнале · {order.auditTrail.length} событий</div>
    </section>
  );

  if (order.status === 'READY' && deliveryOpen) return (
    <section className="screen delivery-screen" data-testid="order-delivery">
      <div className="production-top"><span>Выдача автомобиля</span><b>READY</b></div>
      <div className="order-hero"><small>{customer.name}</small><strong>{vehicle.make} {vehicle.model}</strong><span>{vehicle.plate} · {vehicle.color}</span></div>
      <div className="delivery-photos"><div><span className="mock-photo two"/><small>Фото до</small></div><div><span className="mock-photo three"/><small>Фото после</small></div></div>
      <div className="handover-checklist">
        <span className="delivery-label">Перед выдачей</span>
        <div><i>✓</i><span>Клиент осмотрел результат работ</span></div>
        <div><i>✓</i><span>Фото до и после прикреплены</span></div>
        <div><i>✓</i><span>Комплектность автомобиля проверена</span></div>
      </div>
      <label className="order-field">Ответственный<input value={handoverResponsible} onChange={(event) => setHandoverResponsible(event.target.value)}/></label>
      <label className="order-field">Комментарий к выдаче<textarea value={handoverNote} onChange={(event) => setHandoverNote(event.target.value)}/></label>
      {error && <div className="inline-error">{error}</div>}
      <button className="primary-button close-order-button" data-testid="close-order" disabled={loading || handoverResponsible.trim().length < 2 || handoverNote.trim().length < 2} onClick={closeOrder}>Выдать автомобиль и закрыть заказ →</button>
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
          <div className="master-options">{['Дмитрий Соколов', 'Алексей Волков'].map((name) => <button key={name} className={masterName === name ? 'selected' : ''} onClick={() => setMasterName(name)}><i>{name.split(' ').map((part) => part[0]).join('')}</i><span>{name}<small>{name.startsWith('Дмитрий') ? 'Свободен сейчас' : 'Через 35 мин'}</small></span></button>)}</div>
          <button className="primary-button" data-testid="assign-master" disabled={loading} onClick={assignMaster}>Назначить мастера →</button>
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
          <button aria-pressed={inspectionTab === 'photo'} className={inspectionTab === 'photo' ? 'active' : ''} onClick={() => setInspectionTab('photo')}>Фото <span>3</span></button>
          <button aria-pressed={inspectionTab === 'recommendations'} className={inspectionTab === 'recommendations' ? 'active' : ''} onClick={() => setInspectionTab('recommendations')}>Рекомендации <span>1</span></button>
        </div>

        {inspectionTab === 'inspection' && <>
          <div className="inspection-board">
            <div className="zone-rail" aria-label="Зоны осмотра">{inspectionZones.map((item) => <button key={item.id} className={zone === item.id ? 'selected' : ''} onClick={() => selectZone(item.id)}><i>{item.icon}</i><span>{item.id}</span></button>)}</div>
            <div className="car-stage"><InspectionCar activeZone={zone}/><span className="stage-caption">Нажмите на маркер дефекта</span></div>
            <div className="defect-preview">
              <span className="preview-photo"><b>1</b><i>⌁</i></span>
              <strong>{selectedArea}</strong>
              <small>{note}</small>
              <div className="defect-tags"><em>{severity === 'HIGH' ? 'Сильное' : severity === 'MEDIUM' ? 'Среднее' : 'Лёгкое'}</em><button onClick={() => setSelectedArea(selectedArea === 'Переднее крыло' ? 'Капот' : 'Переднее крыло')}>Изменить</button></div>
            </div>
          </div>

          <div className="severity-line"><span>Статус повреждения</span><div className="severity-chips">{(['LOW', 'MEDIUM', 'HIGH'] as const).map((value) => <button key={value} className={severity === value ? 'selected' : ''} onClick={() => setSeverity(value)}>{value === 'LOW' ? 'Лёгкое' : value === 'MEDIUM' ? 'Среднее' : 'Сильное'}</button>)}</div></div>
          <label className="compact-note">Комментарий к дефекту<input data-testid="finding-note" value={note} onChange={(event) => setNote(event.target.value)}/></label>

          <div className="inspection-photo-row"><span>Фото дефекта</span><div><button aria-label="Добавить фотографию">＋</button><i className="mock-photo one"/><i className="mock-photo two"/><i className="mock-photo three"/></div></div>

          <div className="detected-card">
            <div className="detected-title"><span>Обнаружено при осмотре</span><b>{checkedFindings.size + 1}</b></div>
            {quickFindings.map((finding, index) => <label key={finding.note}><input type="checkbox" checked={checkedFindings.has(index)} onChange={() => setCheckedFindings((current) => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next; })}/><span>{finding.note}</span>{index === 0 && <em>＋ Добавить</em>}</label>)}
          </div>

          <label className="intake-summary-line">Комментарий к приёмке<textarea data-testid="intake-summary" value={summary} onChange={(event) => setSummary(event.target.value)}/></label>
        </>}

        {inspectionTab === 'photo' && <div className="photo-tab-panel"><div className="photo-tab-head"><span>Фото приёмки</span><button>＋ Добавить</button></div><div className="photo-grid"><i className="mock-photo one"/><i className="mock-photo two"/><i className="mock-photo three"/></div><p>Фото привязываются к выбранной зоне осмотра.</p></div>}

        {inspectionTab === 'recommendations' && <div className="recommendation-card"><span>Рекомендация клиенту</span><input data-testid="recommendation-title" value={recommendationTitle} onChange={(event) => setRecommendationTitle(event.target.value)}/><textarea value={recommendationReason} onChange={(event) => setRecommendationReason(event.target.value)}/></div>}
        {error && <div className="inline-error">{error}</div>}
        <div className="intake-actions"><button>Сохранить черновик</button><button data-testid="save-intake" disabled={loading || !summary.trim() || !selectedArea.trim() || !note.trim()} onClick={saveIntake}>Перейти к смете →</button></div>
      </>}

      {stage === 'estimate' && <>
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
