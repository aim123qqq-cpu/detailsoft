import {Composition, Folder} from "remotion";
import {ProductReel} from "./ProductReel";

export const RemotionRoot: React.FC = () => {
  return (
    <Folder name="DetailFlow-Reels">
      <Composition
        id="DetailFlow-Intro"
        component={ProductReel}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          eyebrow: "CRM ДЛЯ ДЕТЕЙЛИНГА",
          title: "Весь детейлинг.\nВ одном потоке.",
          subtitle: "Записи, приёмка, сметы и работы — без бумажного хаоса.",
          primaryScreen: "schedule",
          secondaryScreen: "work",
          featureTitle: "Порядок виден сразу.",
          featureBody: "Администратор и мастер работают в едином процессе — от первого обращения до выдачи автомобиля.",
          chips: ["Записи", "Заказы", "Команда"],
        }}
      />

      <Composition
        id="DetailFlow-Intake"
        component={ProductReel}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          eyebrow: "ЦИФРОВАЯ ПРИЁМКА",
          title: "Приёмка,\nкоторую видно.",
          subtitle: "Отмечайте повреждения прямо на схеме автомобиля и сохраняйте фото.",
          primaryScreen: "intake",
          secondaryScreen: "approval",
          featureTitle: "Меньше споров. Больше доверия.",
          featureBody: "Осмотр, рекомендации и согласованная смета остаются в истории заказа.",
          chips: ["Осмотр", "Фото", "Смета"],
        }}
      />

      <Composition
        id="DetailFlow-Workflow"
        component={ProductReel}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          eyebrow: "ОТ ЗАПИСИ ДО ВЫДАЧИ",
          title: "Каждый этап\nпод контролем.",
          subtitle: "Понятный рабочий поток для администратора, мастера и владельца центра.",
          primaryScreen: "approval",
          secondaryScreen: "work",
          featureTitle: "Команда знает, что делать дальше.",
          featureBody: "Актуальная смета, назначенный мастер и прогресс работ всегда перед глазами.",
          chips: ["Согласование", "Работы", "Результат"],
        }}
      />
    </Folder>
  );
};
