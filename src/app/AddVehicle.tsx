import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { carVariants } from '../shared/carCatalog.ts';
import { normalizePlate } from '../shared/normalize.ts';
import type { CatalogVariant, Customer, Vehicle } from '../types';
import { Icon } from './AppChrome';
import { CarPicker } from './CarPicker';

export const bodyLabels: Record<string, string> = { sedan: 'седан', hatchback: 'хэтчбек', suv: 'кроссовер', wagon: 'универсал', coupe: 'купе', van: 'фургон', pickup: 'пикап', other: 'другой' };

export function AddVehicle({ customer, onCancel, onCreated }: { customer: Customer; onCancel: () => void; onCreated: (vehicle: Vehicle) => void }) {
  const [entryMode, setEntryMode] = useState<'catalog' | 'manual'>('catalog');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const variants = useMemo(() => make && model ? carVariants(make, model) : [], [make, model]);
  const [chosenId, setChosenId] = useState('');
  const variant: CatalogVariant | null = variants.length === 1 ? variants[0] : variants.find((item) => item.id === chosenId) ?? null;
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
    api.listVehicleClasses(controller.signal).then((result) => {
      setVehicleClasses(result.items);
      setTenantClass((current) => current || result.items[0] || '');
    }).catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, []);

  const plateValid = !plate.trim() || normalizePlate(plate).length >= 3;
  // A button that stays grey must say why.
  const missing = [
    ...(entryMode === 'catalog'
      ? [!make && 'марку', !model && 'модель', model && !variant && 'кузов']
      : [manualMake.trim().length < 2 && 'марку', !manualModel.trim() && 'модель']),
    vehicleClasses.length > 0 && !tenantClass && 'класс цены',
    !plateValid && 'госномер полностью или оставьте пустым'
  ].filter(Boolean).join(', ');
  const openManual = (typedMake: string, typedModel: string) => { setManualMake(typedMake); setManualModel(typedModel); setEntryMode('manual'); };
  const submit = async () => {
    if (entryMode === 'catalog' && !variant) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.createVehicle({
        customerId: customer.id,
        ...(entryMode === 'catalog'
          ? { catalogVariantId: variant!.id }
          : { manual: { make: manualMake, model: manualModel, generation: manualGeneration, bodyType: manualBodyType } }),
        ...(tenantClass ? { tenantClass } : {}),
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
      <div className="customer-strip"><span className="avatar small">{customer.name.slice(0, 2).toUpperCase()}</span><span><small>Владелец</small><strong>{customer.name}</strong></span><button onClick={onCancel}>Сменить</button></div>
      <div className="vehicle-entry-tabs" role="tablist" aria-label="Источник модели">
        <button role="tab" aria-selected={entryMode === 'catalog'} className={entryMode === 'catalog' ? 'selected' : ''} onClick={() => setEntryMode('catalog')}>Из справочника</button>
        <button role="tab" aria-selected={entryMode === 'manual'} className={entryMode === 'manual' ? 'selected' : ''} onClick={() => setEntryMode('manual')}>Ввести вручную</button>
      </div>
      {entryMode === 'catalog' ? <div className="form-group">
        <CarPicker make={make} model={model} onChange={(nextMake, nextModel) => { setMake(nextMake); setModel(nextModel); setChosenId(''); }} onNotListed={openManual}/>
        {variants.length > 1 && <>
          <p className="choice-note"><Icon name="spark" size={16}/> Выберите кузов</p>
          <div className="variant-grid">
            {variants.map((item) => <button key={item.id} aria-pressed={variant?.id === item.id} className={variant?.id === item.id ? 'selected' : ''} onClick={() => setChosenId(item.id)}>
              <span className="variant-icon"><Icon name="car" size={26}/></span>
              <strong>{bodyLabels[item.bodyType] ?? item.bodyType}</strong>
              {variant?.id === item.id && <span className="variant-check"><Icon name="check" size={14}/></span>}
            </button>)}
          </div>
        </>}
        {vehicleClasses.length > 0 && <div className="form-group car-class"><label>Класс цены</label><select data-testid="catalog-class" value={tenantClass} onChange={(event) => setTenantClass(event.target.value)}>{vehicleClasses.map((value) => <option key={value}>{value}</option>)}</select></div>}
      </div> : <div className="manual-vehicle-form" data-testid="manual-vehicle-form">
        <div className="form-row"><div className="form-group"><label>Марка</label><input data-testid="manual-make" value={manualMake} onChange={(event) => setManualMake(event.target.value)} placeholder="Zeekr"/></div><div className="form-group"><label>Модель</label><input data-testid="manual-model" value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder="001"/></div></div>
        <div className="form-group"><label>Поколение <small>необязательно</small></label><input value={manualGeneration} onChange={(event) => setManualGeneration(event.target.value)} placeholder="Например, 1 поколение"/></div>
        <div className="form-row"><div className="form-group"><label>Тип кузова</label><select data-testid="manual-body" value={manualBodyType} onChange={(event) => setManualBodyType(event.target.value)}>{Object.entries(bodyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>{vehicleClasses.length > 0 && <div className="form-group"><label>Класс цены</label><select data-testid="manual-class" value={tenantClass} onChange={(event) => setTenantClass(event.target.value)}>{vehicleClasses.map((value) => <option key={value}>{value}</option>)}</select></div>}</div>
        <p className="manual-vehicle-note"><Icon name="spark" size={16}/> Модель сохранится без дубля глобального справочника. Класс действует только в этом центре.</p>
      </div>}
      <div className="form-row">
        <div className="form-group"><label htmlFor="plate">Госномер <small>если известен</small></label><input id="plate" data-testid="plate-input" autoComplete="off" value={plate} onChange={(event) => setPlate(event.target.value.toLocaleUpperCase('ru-RU'))} placeholder="А123АА 55"/></div>
        <div className="form-group"><label htmlFor="color">Цвет <small>если известен</small></label><input id="color" data-testid="color-input" autoComplete="off" value={color} onChange={(event) => setColor(event.target.value)} placeholder="Например, графит"/></div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {missing && <p className="catalog-missing" data-testid="vehicle-missing">Осталось указать: {missing}</p>}
      <button className="primary-button sticky-cta" data-testid="save-vehicle" onClick={submit} disabled={Boolean(missing) || loading}>
        {loading ? <span className="spinner light"/> : <>Сохранить и выбрать <span>→</span></>}
      </button>
    </section>
  );
}
