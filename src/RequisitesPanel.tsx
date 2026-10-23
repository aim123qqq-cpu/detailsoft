import { useEffect, useState } from 'react';
import { api } from './api';
import type { CenterRequisites } from './shared/orderDocuments';

const empty: CenterRequisites = { legalName: '', inn: '', ogrn: '', address: '', phone: '', warranty: '' };

/**
 * The center as the contractor in its acts: the rules for car service (Government Decree No. 780) and
 * consumer law want the contractor's name, registration numbers and address on the customer's papers.
 */
export function RequisitesPanel() {
  const [value, setValue] = useState<CenterRequisites | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.getCenterRequisites(controller.signal).then(setValue).catch((requestError: Error) => {
      if (requestError.name !== 'AbortError') { setValue(empty); setError(requestError.message); }
    });
    return () => controller.abort();
  }, []);

  if (!value) return null;
  const field = (key: keyof CenterRequisites, label: string, placeholder: string, inputMode?: 'numeric' | 'tel') => (
    <label key={key}>{label}<input data-testid={`requisites-${key}`} value={value[key]} placeholder={placeholder} inputMode={inputMode}
      onChange={(event) => { setValue({ ...value, [key]: event.target.value }); setSaved(false); }}/></label>
  );
  const save = async () => {
    setSaving(true); setError('');
    try { setValue(await api.updateCenterRequisites(value)); setSaved(true); }
    catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <section className="settings-panel requisites-panel" data-testid="requisites-panel">
      <div className="settings-panel-heading"><span>Реквизиты для документов</span><strong>в актах</strong></div>
      <p>Печатаются в актах приёмки и выдачи как данные исполнителя. Пустые поля не печатаются.</p>
      {field('legalName', 'Наименование', 'ИП Иванов Иван Иванович или ООО «Детейлинг»')}
      <div className="requisites-pair">
        {field('inn', 'ИНН', '10 или 12 цифр', 'numeric')}
        {field('ogrn', 'ОГРН / ОГРНИП', '13 или 15 цифр', 'numeric')}
      </div>
      {field('address', 'Адрес', 'Город, улица, дом')}
      {field('phone', 'Телефон', '+7 900 000-00-00', 'tel')}
      <label>Гарантия на работы<textarea data-testid="requisites-warranty" value={value.warranty} rows={3} placeholder="Например: 6 месяцев на керамическое покрытие при соблюдении рекомендаций по уходу"
        onChange={(event) => { setValue({ ...value, warranty: event.target.value }); setSaved(false); }}/></label>
      {error && <p className="form-error">{error}</p>}
      {saved && <div className="settings-saved" role="status">✓ Реквизиты сохранены. Они появятся в новых актах.</div>}
      <button className="primary-button" data-testid="save-requisites" disabled={saving} onClick={save}>{saving ? 'Сохраняем…' : 'Сохранить реквизиты'}</button>
    </section>
  );
}
