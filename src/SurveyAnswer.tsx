import { useState } from 'react';
import { api } from './api';
import type { AppNotification } from './types';

/** A survey from DetailFlow answered right in the feed: one choice, a rating, a comment — once. */
export function SurveyAnswer({ item, onAnswered }: { item: AppNotification & { survey: NonNullable<AppNotification['survey']> }; onAnswered: () => void }) {
  const [option, setOption] = useState<number | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { survey } = item;
  const ready = option !== null || rating !== null || comment.trim().length > 0;

  if (item.answered) return <p className="survey-done" data-testid="survey-done">✓ Спасибо, ответ отправлен</p>;
  const send = async () => {
    setBusy(true); setError('');
    try { await api.answerSurvey(item.broadcastId!, { option, rating, comment: comment.trim() }); onAnswered(); }
    catch (requestError) { setError((requestError as Error).message); setBusy(false); }
  };

  return (
    <div className="survey-answer" data-testid="survey-answer">
      {survey.options.length > 0 && <div className="survey-options" role="radiogroup" aria-label="Варианты ответа">
        {survey.options.map((label, index) => (
          <label key={index}><input type="radio" name={`survey-${item.id}`} checked={option === index} onChange={() => setOption(index)}/><span>{label}</span></label>
        ))}
      </div>}
      {survey.rating && <div className="survey-rating" role="radiogroup" aria-label="Оценка от 1 до 5">
        {[1, 2, 3, 4, 5].map((value) => (
          <button key={value} type="button" aria-pressed={rating === value} className={rating === value ? 'selected' : ''} onClick={() => setRating(value)}>{value}</button>
        ))}
      </div>}
      {survey.comment && <textarea value={comment} maxLength={1000} rows={2} placeholder="Комментарий — по желанию" aria-label="Комментарий" onChange={(event) => setComment(event.target.value)}/>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="primary-button" data-testid="send-survey" disabled={!ready || busy} onClick={send}>{busy ? 'Отправляем…' : 'Ответить'}</button>
    </div>
  );
}
