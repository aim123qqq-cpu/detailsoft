import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { CatalogVariant, Customer, Vehicle } from '../types';
import { Icon } from './AppChrome';

export const bodyLabels: Record<string, string> = { sedan: 'седан', hatchback: 'хэтчбек', suv: 'кроссовер', wagon: 'универсал', coupe: 'купе', van: 'фургон', pickup: 'пикап', other: 'другой' };

export function AddVehicle({ customer, onCancel, onCreated }: { customer: Customer; onCancel: () => void; onCreated: (vehicle: Vehicle) => void }) {
  const [entryMode, setEntryMode] = useState<'catalog' | 'manual'>('catalog');
  const [modelQuery, setModelQuery] = useState('Mazda 3 BL');
  const [variants, setVariants] = useState<CatalogVariant[]>([]);
  const [variant, setVariant] = useState<CatalogVariant | null>(null);
  const [plate, setPlate] = useState('');
  const [color, setColor] = useState('');
  const [manualMake, setManualMake] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [manualGeneration, setManualGeneration] = useState('');
  const [manualBodyType, setManualBodyType] = useState('sedan');
  const [vehicleClasses, setVehicleClasses] = useState<string[]>([]);
  const [tenantClass, setTenantClass] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (modelQuery.trim().length < 2) return setVariants([]);
      try {
        const result = await api.searchCatalog(modelQuery, controller.signal);
        setVariants(result.items);
        if (result.items.length === 1) setVariant(result.items[0]);
      } catch (requestError) {
        if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [modelQuery]);

  useEffect(() => {
    const controller = new AbortController();
    api.listVehicleClasses(controller.signal).then((result) => {
      setVehicleClasses(result.items);
      setTenantClass((current) => current || result.items[0] || '');
    }).catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, []);

  const chosenSummary = useMemo(() => variant ? `${variant.make} ${variant.model} ${variant.generation} · ${bodyLabels[variant.bodyType] ?? variant.bodyType}` : '', [variant]);
  const submit = async () => {
    if (entryMode === 'catalog' && !variant) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.createVehicle({
        customerId: customer.id,
        ...(entryMode === 'catalog'
          ? { catalogVariantId: variant!.id }
          : { manual: { make: manualMake, model: manualModel, generation: manualGeneration, bodyType: manualBodyType }, tenantClass }),
        plateDisplay: plate,
        color
      }, entryMode === 'catalog' ? variant : null);
      onCreated(result.vehicle);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="screen add-vehicle-screen" data-testid="add-vehicle-screen">
      <div className="customer-strip"><span className="avatar small">АМ</span><span><small>Владелец</small><strong>{customer.name}</strong></span><button onClick={onCancel}>Сменить</button></div>
      <div className="vehicle-entry-tabs" role="tablist" aria-label="Источник модели">
        <button role="tab" aria-selected={entryMode === 'catalog'} className={entryMode === 'catalog' ? 'selected' : ''} onClick={() => setEntryMode('catalog')}>Из справочника</button>
        <button role="tab" aria-selected={entryMode === 'manual'} className={entryMode === 'manual' ? 'selected' : ''} onClick={() => setEntryMode('manual')}>Ввести вручную</button>
      </div>
      {entryMode === 'catalog' ? <div className="form-group">
        <label htmlFor="model-search">Марка, модель или поколение</label>
        <div className="search-input filled"><Icon name="search"/><input id="model-search" value={modelQuery} onChange={(event) => { setModelQuery(event.target.value); setVariant(null); }}/></div>
        {variants.length > 1 && <p className="choice-note"><Icon name="spark" size={16}/> Найдено несколько кузовов — выберите подходящий</p>}
        <div className="variant-grid">
          {variants.map((item) => <button key={item.id} aria-pressed={variant?.id === item.id} className={variant?.id === item.id ? 'selected' : ''} onClick={() => setVariant(item)}>
            <span className="variant-icon"><Icon name="car" size={26}/></span>
            <strong>{bodyLabels[item.bodyType] ?? item.bodyType}</strong>
            <small>{item.yearFrom}–{item.yearTo}</small>
            {variant?.id === item.id && <span className="variant-check"><Icon name="check" size={14}/></span>}
          </button>)}
        </div>
      </div> : <div className="manual-vehicle-form" data-testid="manual-vehicle-form">
        <div className="form-row"><div className="form-group"><label>Марка</label><input data-testid="manual-make" value={manualMake} onChange={(event) => setManualMake(event.target.value)} placeholder="Zeekr"/></div><div className="form-group"><label>Модель</label><input data-testid="manual-model" value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder="001"/></div></div>
        <div className="form-group"><label>Поколение <small>необязательно</small></label><input value={manualGeneration} onChange={(event) => setManualGeneration(event.target.value)} placeholder="Например, 1 поколение"/></div>
        <div className="form-row"><div className="form-group"><label>Тип кузова</label><select data-testid="manual-body" value={manualBodyType} onChange={(event) => setManualBodyType(event.target.value)}>{Object.entries(bodyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="form-group"><label>Класс цены</label><select data-testid="manual-class" value={tenantClass} onChange={(event) => setTenantClass(event.target.value)}>{vehicleClasses.map((value) => <option key={value}>{value}</option>)}</select></div></div>
        <p className="manual-vehicle-note"><Icon name="spark" size={16}/> Модель сохранится без дубля глобального справочника. Класс действует только в этом центре.</p>
      </div>}
      <div className="form-row">
        <div className="form-group"><label htmlFor="plate">Госномер</label><input id="plate" data-testid="plate-input" value={plate} onChange={(event) => setPlate(event.target.value.toLocaleUpperCase('ru-RU'))} placeholder="А123АА 55"/></div>
        <div className="form-group"><label htmlFor="color">Цвет</label><input id="color" data-testid="color-input" value={color} onChange={(event) => setColor(event.target.value)} placeholder="Например, графит"/></div>
      </div>
      {entryMode === 'catalog' && chosenSummary && <div className="auto-summary"><Icon name="check"/><span><small>Определено по справочнику</small><strong>{chosenSummary}</strong></span></div>}
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button sticky-cta" data-testid="save-vehicle" onClick={submit} disabled={(entryMode === 'catalog' ? !variant : manualMake.trim().length < 2 || !manualModel.trim() || !tenantClass) || plate.trim().length < 3 || color.trim().length < 2 || loading}>
        {loading ? <span className="spinner light"/> : <>Сохранить и выбрать <span>→</span></>}
      </button>
    </section>
  );
}
