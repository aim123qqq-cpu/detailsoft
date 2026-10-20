# DetailFlow Reels

Вертикальные продуктовые ролики 1080×1920 для Instagram Reels и YouTube Shorts.

## Композиции

- `DetailFlow-Intro` — общая визитка продукта;
- `DetailFlow-Intake` — цифровая приёмка и согласование сметы;
- `DetailFlow-Workflow` — путь от записи до выполнения работ.

Все тексты и параметры композиций меняются в `src/Root.tsx`, а общая
анимационная система находится в `src/ProductReel.tsx`.

## Запуск и проверка

```bash
npm run dev
npm run lint
npm run build
```

Studio работает на `http://localhost:3000`. Экспорт MP4 выполняется через
интерфейс Studio или командой:

```bash
npx remotion render DetailFlow-Intro out/detailflow-intro.mp4
```
