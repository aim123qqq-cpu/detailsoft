import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { OrderDocument, OrderDocumentType } from '@df/types';
import { documentHtml } from '@/features/document-html';
import { DOCUMENT_TITLES, DocumentPaper } from '@/features/document-paper';
import { SignaturePad } from '@/features/signature-pad';
import { useSession } from '@/lib/session';
import { colors, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Field, Label, Loading, Notice, Screen } from '@/ui';

/** An act: with `documentId` the issued one (view, PDF); without it, the preview to sign and issue. */
export default function DocumentScreen() {
  const params = useLocalSearchParams<{ id: string; type: OrderDocumentType; documentId?: string; signer?: string }>();
  return params.documentId
    ? <Viewer orderId={params.id} documentId={params.documentId}/>
    : <Signer orderId={params.id} type={params.type} defaultSigner={params.signer ?? ''}/>;
}

function Signer({ orderId, type, defaultSigner }: { orderId: string; type: OrderDocumentType; defaultSigner: string }) {
  const { api } = useSession();
  const preview = useResource(useCallback((signal: AbortSignal) => api.previewDocument(orderId, type, signal), [api, orderId, type]));
  const [signerName, setSignerName] = useState(defaultSigner);
  const [signature, setSignature] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState<'signed' | 'unsigned' | null>(null);
  const [error, setError] = useState('');

  const issue = async (signed: boolean) => {
    setBusy(signed ? 'signed' : 'unsigned'); setError('');
    try {
      const document = await api.issueDocument(orderId, signed && signature ? { type, signerName: signerName.trim(), signatureDataUrl: signature } : { type });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace({ pathname: '/orders/document/[id]', params: { id: orderId, type, documentId: document.id } });
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(null);
    }
  };

  if (!preview.data && !preview.error) return <Loading label="Готовим документ…"/>;
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} scrollEnabled={!drawing} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: DOCUMENT_TITLES[type] }}/>
      {preview.error ? <Notice>{preview.error}</Notice> : null}
      {preview.data ? <>
        <DocumentPaper content={preview.data.content}/>
        <Label>Подпись клиента</Label>
        <Body muted>Покажите документ клиенту. Подпись необязательна: акт можно оформить без неё и подписать на бумаге.</Body>
        <Field label="ФИО подписанта" value={signerName} onChangeText={setSignerName} maxLength={120} autoCapitalize="words"/>
        <SignaturePad onChange={setSignature} onDrawing={setDrawing}/>
        {error ? <Notice>{error}</Notice> : null}
        <Button title="Подписать и сохранить" busy={busy === 'signed'} disabled={busy !== null || !signature || signerName.trim().length < 2} onPress={() => void issue(true)}/>
        <Button title="Оформить без подписи" tone="secondary" busy={busy === 'unsigned'} disabled={busy !== null} onPress={() => void issue(false)}/>
      </> : null}
    </ScrollView>
  );
}

function Viewer({ orderId, documentId }: { orderId: string; documentId: string }) {
  const { api } = useSession();
  const { data: document, error, reload } = useResource(useCallback((signal: AbortSignal) => api.getDocument(orderId, documentId, signal), [api, orderId, documentId]));
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState('');

  if (!document && !error) return <Loading label="Загружаем документ…"/>;
  if (!document) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;

  const share = async (doc: OrderDocument) => {
    setSharing(true); setShareError('');
    try {
      const { uri } = await Print.printToFileAsync({ html: documentHtml(doc) });
      // The customer receives "Акт приёмки АП-000001.pdf", not a random file name.
      const named = new File(Paths.cache, `${DOCUMENT_TITLES[doc.type].replace(/ \(.*\)$/, '')} ${doc.number}.pdf`);
      if (named.exists) named.delete();
      new File(uri).move(named);
      await Sharing.shareAsync(named.uri, { mimeType: 'application/pdf', dialogTitle: `${DOCUMENT_TITLES[doc.type]} № ${doc.number}`, UTI: 'com.adobe.pdf' });
    } catch (failure) { setShareError((failure as Error).message); }
    finally { setSharing(false); }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: `${DOCUMENT_TITLES[document.type]} № ${document.number}` }}/>
      {document.outdated ? <Notice tone="info">Акт устарел: после подписания приёмку осмотрели повторно. Документ сохранён без изменений — оформите новый.</Notice> : null}
      <DocumentPaper content={document.content} number={document.number} signerName={document.signerName} signatureDataUrl={document.signatureDataUrl}
        signedAt={document.signedAt} actorName={document.actorName}/>
      {shareError ? <Notice>{shareError}</Notice> : null}
      <View style={{ gap: space.s }}>
        <Button title="PDF — отправить или распечатать" busy={sharing} onPress={() => void share(document)}/>
        <Button title="Готово" tone="quiet" onPress={() => router.back()}/>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  content: { padding: space.l, paddingBottom: space.xxl, gap: space.m }
});
