import { useState } from 'react';
import { api } from './api';
import type { CatalogSection, ManagedCatalogItem } from './types';

type ClassRow = { tenantClass: string; amount: string; duration: string };

const rubles = (amountMinor: number) => String(amountMinor / 100);
const toMinor = (value: string) => Math.round(Number(value) * 100);
const validAmount = (value: string) => value !== '' && Number(value) >= 0;
const validDuration = (value: string) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 1440;

/**
 * A service as people think of it: section, name, time and price. Optionally a different price and
 * time per vehicle class; classes left equal to the base follow it when the base changes.
 */
export function SimpleServiceForm({ item, sections, vehicleClasses, defaultSectionId, onCancel, onSaved, onComposite }: {
  item: ManagedCatalogItem | null;
  sections: CatalogSection[];
  vehicleClasses: string[];
  defaultSectionId?: string;
  onCancel: () => void;
  onSaved: (item: ManagedCatalogItem) => void;
  onComposite?: () => void;
}) {
  const classes = vehicleClasses.filter((value) => value !== '*');
  // Seeded services may have class prices only: the first class then serves as the base.
  const seededBase = item?.basePrice ?? (item?.classPrices?.[0] ? { amountMinor: item.classPrices[0].amountMinor, durationMinutes: item.classPrices[0].durationMinutes } : null);
  const [sectionId, setSectionId] = useState(sections.find((section) => section.name === item?.category)?.id ?? defaultSectionId ?? sections[0]?.id ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [pricingMode, setPricingMode] = useState<ManagedCatalogItem['pricingMode']>(item?.pricingMode ?? 'fixed');
  const [active, setActive] = useState(item?.active ?? true);
  const [amount, setAmount] = useState(seededBase ? rubles(seededBase.amountMinor) : '');
  const [duration, setDuration] = useState(seededBase ? String(seededBase.durationMinutes) : '30');
  const differs = (item?.classPrices ?? []).some((price) => price.amountMinor !== seededBase?.amountMinor || price.durationMinutes !== seededBase?.durationMinutes);
  const [byClass, setByClass] = useState(differs);
  const [rows, setRows] = useState<ClassRow[]>(() => classes.map((tenantClass) => {
    const price = item?.classPrices?.find((value) => value.tenantClass === tenantClass);
    return { tenantClass, amount: price ? rubles(price.amountMinor) : '', duration: price ? String(price.durationMinutes) : '' };
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // An empty class row means "same as the base".
  const classPrices = byClass ? rows.filter((row) => row.amount !== '' || row.duration !== '').map((row) => ({
    tenantClass: row.tenantClass,
    amountMinor: toMinor(row.amount !== '' ? row.amount : amount),
    durationMinutes: Number(row.duration !== '' ? row.duration : duration)
  })) : [];
  const rowsValid = !byClass || rows.every((row) => (row.amount === '' || validAmount(row.amount)) && (row.duration === '' || validDuration(row.duration)));
  const valid = Boolean(sectionId) && name.trim().length >= 2 && validAmount(amount) && validDuration(duration) && rowsValid;

  const save = async () => {
    setSaving(true); setError('');
    const input = { sectionId, name: name.trim(), description: description.trim(), pricingMode, basePrice: { amountMinor: toMinor(amount), durationMinutes: Number(duration) }, classPrices };
    try { onSaved(item ? await api.updateSimpleService(item.id, { ...input, active }) : await api.createSimpleService(input)); }
    catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };

  return <section className="screen catalog-editor simple-service-form" data-testid="simple-service-form">
    <button className="details-back" onClick={onCancel}>← Каталог</button>
    <div className="catalog-editor-title">
      <span>{item ? 'Услуга' : 'Новая услуга'}</span>
      <h2>{item ? item.name : 'Название, время и цена'}</h2>
      <p>{item ? 'Меняются только будущие расчёты: записи и сметы хранят свои суммы.' : 'Услуга сразу появится в записи. Цену можно сделать разной для классов авто.'}</p>
    </div>
    <div className="catalog-editor-form">
      <label>Раздел
        {sections.length
          ? <select data-testid="service-section" value={sectionId} onChange={(event) => setSectionId(event.target.value)}>{sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select>
          : <span className="catalog-hint">Сначала создайте раздел в каталоге</span>}
      </label>
      <label>Название<input data-testid="service-name" value={name} maxLength={120} placeholder="Например, озонирование салона" onChange={(event) => setName(event.target.value)}/></label>
      <div className="simple-service-price">
        <label>Время, мин<input data-testid="service-duration" type="number" inputMode="numeric" min="1" max="1440" value={duration} onChange={(event) => setDuration(event.target.value)}/></label>
        <label>Цена, ₽<input data-testid="service-amount" type="number" inputMode="decimal" min="0" step="50" value={amount} onChange={(event) => setAmount(event.target.value)}/></label>
      </div>
      <label>Как показывать цену<select value={pricingMode} onChange={(event) => setPricingMode(event.target.value as ManagedCatalogItem['pricingMode'])}><option value="fixed">Точная цена</option><option value="from">Цена «от»</option><option value="inspection">После осмотра</option></select></label>
      <label>Описание<textarea value={description} maxLength={500} placeholder="Необязательно: что входит в услугу" onChange={(event) => setDescription(event.target.value)}/></label>
      {classes.length > 0 && <label className="catalog-active-toggle"><input type="checkbox" data-testid="service-by-class" checked={byClass} onChange={(event) => setByClass(event.target.checked)}/><span><strong>Разная цена по классам авто</strong><small>{byClass ? 'Пустые поля — как основная цена' : 'Одна цена и время для любого автомобиля'}</small></span></label>}
      {item && <label className="catalog-active-toggle"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)}/><span><strong>Доступно для записи</strong><small>{active ? 'Услугу можно выбрать при записи' : 'Услуга останется только в истории'}</small></span></label>}
    </div>
    {byClass && <div className="catalog-price-editor" data-testid="service-class-prices"><div><span>Цены по классам</span><strong>Остальные — {amount || '—'} ₽ · {duration || '—'} мин</strong></div>
      {rows.map((row, index) => <div className="catalog-price-row" key={row.tenantClass}><strong>{row.tenantClass}</strong>
        <label>Цена, ₽<input aria-label={`${row.tenantClass} цена`} type="number" min="0" step="50" placeholder={amount} value={row.amount} onChange={(event) => setRows(rows.map((value, rowIndex) => rowIndex === index ? { ...value, amount: event.target.value } : value))}/></label>
        <label>Минуты<input aria-label={`${row.tenantClass} длительность`} type="number" min="1" max="1440" placeholder={duration} value={row.duration} onChange={(event) => setRows(rows.map((value, rowIndex) => rowIndex === index ? { ...value, duration: event.target.value } : value))}/></label>
      </div>)}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary-button catalog-save" data-testid="save-simple-service" disabled={!valid || saving} onClick={save}>{saving ? 'Сохраняем…' : item ? 'Сохранить услугу' : 'Добавить услугу'}</button>
    {!item && onComposite && <button className="catalog-composite-link" data-testid="switch-to-composite" onClick={onComposite}>Собрать услугу из нескольких операций →</button>}
  </section>;
}
