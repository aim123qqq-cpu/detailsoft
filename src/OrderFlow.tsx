import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { Booking, Customer, EstimateLineInput, IntakeFinding, OrderRecommendation, Vehicle, WorkOrder } from './types';

function money(amountMinor: number) {
  return `${Math.round(amountMinor / 100).toLocaleString('ru-RU')} ₽`;
}

export function OrderFlow({ booking, customer, vehicle }: { booking: Booking; customer: Customer; vehicle: Vehicle }) {
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [stage, setStage] = useState<'intake' | 'estimate' | 'approval'>('intake');
  const [summary, setSummary] = useState('Автомобиль принят при клиенте, комплектность проверена');
  const [zone, setZone] = useState('Передний бампер');
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

  const findings = useMemo<IntakeFinding[]>(() => [{ zone, severity, note }], [zone, severity, note]);
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
        <div className="flow-heading"><span>01 · Состояние</span><h2>Зафиксируйте приёмку</h2><p>Описание и замечания войдут в историю заказа.</p></div>
        <label className="order-field">Общее состояние<textarea data-testid="intake-summary" value={summary} onChange={(event) => setSummary(event.target.value)}/></label>
        <div className="finding-card">
          <div className="finding-top"><strong>Замечание #1</strong><span>кузов</span></div>
          <label className="order-field">Зона<input data-testid="finding-zone" value={zone} onChange={(event) => setZone(event.target.value)}/></label>
          <div className="severity-chips">{(['LOW', 'MEDIUM', 'HIGH'] as const).map((value) => <button key={value} className={severity === value ? 'selected' : ''} onClick={() => setSeverity(value)}>{value === 'LOW' ? 'Низкий' : value === 'MEDIUM' ? 'Средний' : 'Высокий'}</button>)}</div>
          <label className="order-field">Описание<input data-testid="finding-note" value={note} onChange={(event) => setNote(event.target.value)}/></label>
        </div>
        <div className="recommendation-card"><span>Рекомендация клиенту</span><input data-testid="recommendation-title" value={recommendationTitle} onChange={(event) => setRecommendationTitle(event.target.value)}/><textarea value={recommendationReason} onChange={(event) => setRecommendationReason(event.target.value)}/></div>
        {error && <div className="inline-error">{error}</div>}
        <button className="primary-button" data-testid="save-intake" disabled={loading || !summary.trim() || !zone.trim() || !note.trim()} onClick={saveIntake}>Завершить приёмку →</button>
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
