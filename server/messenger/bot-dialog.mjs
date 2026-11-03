// Provider-neutral bot conversation for staff sign-in and messenger linking.
// Events come from the Telegram or MAX adapter in the same normalized shape.
import { PROVIDER_TITLES, maskAccount } from '../event-log.mjs';

const HELP = 'Это бот DetailFlow для входа. Чтобы создать свой центр, откройте detailflow.ru или приложение DetailFlow, нажмите «Создать свой центр» и выберите мессенджер — бот откроется сам. Чтобы войти сотрудником, попросите владельца центра прислать приглашение из раздела «Команда».';

export function createBotDialog({ auth, adapters, events = null, logger = console }) {
  const adapterFor = (provider) => adapters.get(provider);
  // The journal in /admin: who did what in the bot, without names, codes or links.
  const note = (event, level, title, meaning) => events?.add({
    level, kind: 'bot', title: `${PROVIDER_TITLES[event.provider] ?? event.provider} ${maskAccount(event.provider, event.userId)}: ${title}`, meaning
  });

  async function reply(event, text, buttons) {
    await adapterFor(event.provider)?.sendMessage(event.userId, text, buttons);
  }

  async function startLogin(event, login) {
    if (!login) {
      note(event, 'warn', 'устаревшая ссылка или код входа',
        'Человек пришёл в бота по старой кнопке или ввёл код, который уже истёк (живёт 10 минут) или использован. Бот попросил начать вход заново.');
      return reply(event, 'Ссылка или код входа устарели. Начните вход заново на экране DetailFlow.');
    }
    // Creating a new center needs no membership: the person becomes the owner of the center they create.
    // A sign-in by an account no center knows (nor the service owner's, who signs in to /admin) is offered the same.
    const signup = auth.loginPurpose(login.id) === 'signup';
    if (signup || auth.isNewcomer(event.provider, event.userId)) {
      if (!signup) auth.turnIntoSignup(login.id);
      auth.markLoginAwaiting(login.id, event.userId, event.displayName);
      note(event, 'info', signup ? 'начал создание центра' : 'новый аккаунт нажал «Войти» — предложено создать центр',
        signup ? 'Бот показал код и ждёт кнопку «Это я, продолжить».'
          : 'Аккаунт не привязан ни к одному центру. Бот предложил создать свой центр (кнопка «Создать центр»). Если это сотрудник — владельцу его центра нужно прислать приглашение из «Команды».');
      const unlinked = signup ? '' : 'Этот аккаунт ещё не привязан к центру. Если вы сотрудник, попросите владельца прислать приглашение из раздела «Команда». Или создайте свой центр:\n\n';
      return reply(event,
        `${unlinked}Создание центра в DetailFlow\nКод на экране: ${login.short_code}\n\nПодтверждайте, только если вы сами сейчас создаёте центр и код совпадает. Вы станете его владельцем.`,
        [[{ text: signup ? 'Это я, продолжить' : 'Создать центр', payload: `login_ok:${login.id}` }, { text: 'Отклонить', payload: `login_no:${login.id}` }]]);
    }
    auth.markLoginAwaiting(login.id, event.userId);
    note(event, 'info', 'начал вход', 'Сотрудник открыл бота с экрана входа. Бот показал код и ждёт кнопку «Это я, войти».');
    return reply(event,
      `Вход в DetailFlow\nКод на экране входа: ${login.short_code}\n\nПодтверждайте, только если вы сами сейчас входите и код совпадает. Никому не пересылайте ссылку для входа.`,
      [[{ text: 'Это я, войти', payload: `login_ok:${login.id}` }, { text: 'Отклонить', payload: `login_no:${login.id}` }]]);
  }

  async function redeem(event, code) {
    const result = auth.redeemInvite(event.provider, code, event.userId, event.displayName);
    // No names of people or centers go to the messenger: it is a foreign service, and the person sees them in DetailFlow.
    if (result.kind === 'linked') {
      note(event, 'info', 'принял приглашение', 'Аккаунт привязан к сотруднику центра — теперь он может входить через этот мессенджер.');
      return reply(event, 'Готово: аккаунт привязан. Теперь можно входить в DetailFlow через этот мессенджер.');
    }
    if (result.kind === 'conflict') {
      note(event, 'warn', 'приглашение не принято — аккаунт уже у другого сотрудника', 'Этот мессенджер уже привязан к другому сотруднику того же центра. Владельцу центра нужно отвязать его в «Команде».');
      return reply(event, 'Этот аккаунт уже привязан к другому сотруднику этого центра. Обратитесь к владельцу центра.');
    }
    note(event, 'warn', 'недействительное приглашение', 'Приглашение устарело или уже использовано. Владельцу центра нужно отправить новое из «Команды».');
    return reply(event, 'Приглашение недействительно или устарело. Попросите владельца центра отправить новое.');
  }

  function help(event, what) {
    note(event, 'info', `${what} — бот показал подсказку`,
      'Человек открыл бота сам, а не по кнопке с экрана входа, поэтому бот не знает, что он хочет сделать. Бот подсказал: создать центр на detailflow.ru или в приложении («Создать свой центр»), а сотруднику — попросить приглашение.');
    return reply(event, HELP);
  }

  return async function handle(event) {
    try {
      if (event.kind === 'start') {
        const payload = event.payload ?? '';
        if (/^login_[0-9a-f]{32}$/.test(payload)) return startLogin(event, auth.findOpenLogin(event.provider, { startToken: payload.slice('login_'.length) }));
        if (/^invite_[0-9a-f]{24}$/.test(payload)) return redeem(event, payload);
        return help(event, 'написал /start без ссылки входа');
      }
      if (event.kind === 'text') {
        const text = event.text.trim();
        if (/^[A-Za-z2-9]{6}$/.test(text)) return startLogin(event, auth.findOpenLogin(event.provider, { shortCode: text }));
        if (/^invite_[0-9a-f]{24}$/.test(text)) return redeem(event, text);
        return help(event, 'написал боту сообщение');
      }
      if (event.kind === 'callback') {
        const match = /^login_(ok|no):(lr_[0-9a-f-]{36})$/.exec(event.payload);
        const adapter = adapterFor(event.provider);
        if (!match) return adapter?.answerCallback(event.callbackId, 'Неизвестное действие');
        const approve = match[1] === 'ok';
        const decided = auth.decideLogin(match[2], event.provider, event.userId, approve);
        if (!decided) note(event, 'warn', 'нажал кнопку в устаревшем запросе', 'Кнопка «Это я…» нажата после того, как запрос истёк (10 минут) или уже был использован. Нужно начать вход заново.');
        else if (approve) note(event, 'info', 'подтвердил в боте', 'Человек нажал «Это я». Экран входа сейчас откроет рабочее место или форму нового центра.');
        else note(event, 'warn', 'отклонил вход', 'Человек нажал «Отклонить». Если это был не он — кто-то пытался войти от его имени.');
        await adapter?.answerCallback(event.callbackId, decided ? (approve ? 'Вход подтверждён' : 'Вход отклонён') : 'Запрос устарел');
        if (decided) return reply(event, approve ? 'Вход подтверждён. Вернитесь в DetailFlow.' : 'Вход отклонён. Если это были не вы, сообщите владельцу центра.');
      }
    } catch (error) {
      logger.error('bot dialog failed', error);
    }
  };
}
