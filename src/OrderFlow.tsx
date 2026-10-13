import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
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

export function OrderFlow({ booking, customer, vehicle }: { booking: Booking; customer: Customer; vehicle: Vehicle }) {
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

  if (loading && !order) return <section className="screen order-loading"><span className="spinner"/> Создаём заказ из записи</section>;
  if (!order) return <section className="screen"><div className="inline-error">{error || 'Не удалось создать заказ'}</div></section>;
  const currentEstimate = order.estimateVersions.find((item) => item.id === order.currentEstimateVersionId);

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
    </section>
  );

  return (
    <section className="screen order-flow" data-testid={`order-${stage}`}>
      <div className="order-status-row"><span>Заказ открыт</span><b>{order.status === 'INTAKE' ? 'Приёмка' : 'Смета'}</b></div>
      <div className="order-hero"><small>{customer.name}</small><strong>{vehicle.make} {vehicle.model} {vehicle.generation}</strong><span>{vehicle.plate} · {vehicle.color}</span></div>

      {stage === 'intake' && <>
        <div className="inspection-tabs" role="tablist">
          <button className={inspectionTab === 'inspection' ? 'active' : ''} onClick={() => setInspectionTab('inspection')}>Осмотр</button>
          <button className={inspectionTab === 'photo' ? 'active' : ''} onClick={() => setInspectionTab('photo')}>Фото <span>3</span></button>
          <button className={inspectionTab === 'recommendations' ? 'active' : ''} onClick={() => setInspectionTab('recommendations')}>Рекомендации <span>1</span></button>
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
          <div className="sheet-total"><span>К оплате</span><strong>{money(currentEstimate.totalAmountMinor)}</strong></div>
        </div>
        <label className="order-field">Ответственный<input data-testid="approval-responsible" value={responsible} onChange={(event) => setResponsible(event.target.value)}/></label>
        <div className="approval-methods">{([['in_person', 'Лично'], ['phone', 'Телефон'], ['messenger', 'Мессенджер']] as const).map(([value, label]) => <button key={value} className={method === value ? 'selected' : ''} onClick={() => setMethod(value)}>{label}</button>)}</div>
        {error && <div className="inline-error">{error}</div>}
        <div className="decision-actions"><button data-testid="reject-estimate" disabled={loading} onClick={() => decide('REJECTED')}>Отклонено</button><button data-testid="approve-estimate" disabled={loading || !responsible.trim()} onClick={() => decide('APPROVED')}>Согласовано ✓</button></div>
      </>}
    </section>
  );
}
