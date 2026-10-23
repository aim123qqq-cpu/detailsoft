import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import type { CenterRequisites } from '@df/shared/orderDocuments';
import { useSession } from '@/lib/session';
import { space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Field, Label, Notice } from '@/ui';

/**
 * The center as the contractor in its acts: the rules for car service (Government Decree No. 780) and
 * consumer law want the contractor's name, registration numbers and address on the customer's papers.
 */
export function RequisitesForm() {
  const { api, reload: reloadSession } = useSession();
  const loaded = useResource(useCallback((signal: AbortSignal) => api.centerRequisites(signal), [api]));
  const [value, setValue] = useState<CenterRequisites | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (loaded.data && !value) setValue(loaded.data); }, [loaded.data, value]);

  if (!value) return loaded.error ? <Notice>{loaded.error}</Notice> : null;
  const set = (key: keyof CenterRequisites) => (text: string) => { setValue({ ...value, [key]: text }); setSaved(false); };
  const save = async () => {
    setSaving(true); setError('');
    // The session carries the requisites too: acts signed offline on this phone print the new ones.
    try { setValue(await api.updateCenterRequisites(value)); setSaved(true); await reloadSession(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <View style={{ gap: space.m }}>
      <Label>Реквизиты для документов</Label>
      <Body muted>Печатаются в актах приёмки и выдачи как данные исполнителя. Пустые поля не печатаются.</Body>
      <Field label="Наименование" value={value.legalName} onChangeText={set('legalName')} placeholder="ИП Иванов Иван Иванович"/>
      <Field label="ИНН" value={value.inn} onChangeText={set('inn')} keyboardType="number-pad" placeholder="10 или 12 цифр"/>
      <Field label="ОГРН / ОГРНИП" value={value.ogrn} onChangeText={set('ogrn')} keyboardType="number-pad" placeholder="13 или 15 цифр"/>
      <Field label="Адрес" value={value.address} onChangeText={set('address')} placeholder="Город, улица, дом"/>
      <Field label="Телефон" value={value.phone} onChangeText={set('phone')} keyboardType="phone-pad" placeholder="+7 900 000-00-00"/>
      <Field label="Гарантия на работы" value={value.warranty} onChangeText={set('warranty')} multiline placeholder="Например: 6 месяцев на покрытие"/>
      {error ? <Notice>{error}</Notice> : null}
      {saved ? <Notice tone="info">Реквизиты сохранены. Они появятся в новых актах.</Notice> : null}
      <Button title="Сохранить реквизиты" busy={saving} onPress={() => void save()}/>
    </View>
  );
}
