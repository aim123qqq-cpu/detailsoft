// Provider-neutral bot conversation for staff sign-in and messenger linking.
// Events come from the Telegram or MAX adapter in the same normalized shape.

const HELP = 'Это бот DetailFlow для входа сотрудников. Чтобы войти или создать свой центр, откройте DetailFlow и выберите мессенджер на экране входа. Чтобы привязать аккаунт к центру, попросите его владельца прислать приглашение из раздела «Команда».';

export function createBotDialog({ auth, adapters, logger = console }) {
  const adapterFor = (provider) => adapters.get(provider);

  async function reply(event, text, buttons) {
    await adapterFor(event.provider)?.sendMessage(event.userId, text, buttons);
  }

  async function startLogin(event, login) {
    if (!login) return reply(event, 'Ссылка или код входа устарели. Начните вход заново на экране DetailFlow.');
    // Creating a new center needs no membership: the person becomes the owner of the center they create.
    if (auth.loginPurpose(login.id) === 'signup') {
      auth.markLoginAwaiting(login.id, event.userId, event.displayName);
      return reply(event,
        `Создание центра в DetailFlow\nКод на экране: ${login.short_code}\n\nПодтверждайте, только если вы сами сейчас создаёте центр и код совпадает. Вы станете его владельцем.`,
        [[{ text: 'Это я, продолжить', payload: `login_ok:${login.id}` }, { text: 'Отклонить', payload: `login_no:${login.id}` }]]);
    }
    // The service owner signs in to /admin with the same bot, with or without a center of their own.
    if (!auth.membershipsFor(event.provider, event.userId).length && !auth.isPlatformAdmin(event.provider, event.userId)) {
      return reply(event, 'Этот аккаунт ещё не привязан к сотруднику центра. Попросите владельца прислать приглашение в разделе «Команда» или создайте свой центр на экране входа DetailFlow.');
    }
    auth.markLoginAwaiting(login.id, event.userId);
    return reply(event,
      `Вход в DetailFlow\nКод на экране входа: ${login.short_code}\n\nПодтверждайте, только если вы сами сейчас входите и код совпадает. Никому не пересылайте ссылку для входа.`,
      [[{ text: 'Это я, войти', payload: `login_ok:${login.id}` }, { text: 'Отклонить', payload: `login_no:${login.id}` }]]);
  }

  async function redeem(event, code) {
    const result = auth.redeemInvite(event.provider, code, event.userId, event.displayName);
    // No names of people or centers go to the messenger: it is a foreign service, and the person sees them in DetailFlow.
    if (result.kind === 'linked') return reply(event, 'Готово: аккаунт привязан. Теперь можно входить в DetailFlow через этот мессенджер.');
    if (result.kind === 'conflict') return reply(event, 'Этот аккаунт уже привязан к другому сотруднику этого центра. Обратитесь к владельцу центра.');
    return reply(event, 'Приглашение недействительно или устарело. Попросите владельца центра отправить новое.');
  }

  return async function handle(event) {
    try {
      if (event.kind === 'start') {
        const payload = event.payload ?? '';
        if (/^login_[0-9a-f]{32}$/.test(payload)) return startLogin(event, auth.findOpenLogin(event.provider, { startToken: payload.slice('login_'.length) }));
        if (/^invite_[0-9a-f]{24}$/.test(payload)) return redeem(event, payload);
        return reply(event, HELP);
      }
      if (event.kind === 'text') {
        const text = event.text.trim();
        if (/^[A-Za-z2-9]{6}$/.test(text)) return startLogin(event, auth.findOpenLogin(event.provider, { shortCode: text }));
        if (/^invite_[0-9a-f]{24}$/.test(text)) return redeem(event, text);
        return reply(event, HELP);
      }
      if (event.kind === 'callback') {
        const match = /^login_(ok|no):(lr_[0-9a-f-]{36})$/.exec(event.payload);
        const adapter = adapterFor(event.provider);
        if (!match) return adapter?.answerCallback(event.callbackId, 'Неизвестное действие');
        const approve = match[1] === 'ok';
        const decided = auth.decideLogin(match[2], event.provider, event.userId, approve);
        await adapter?.answerCallback(event.callbackId, decided ? (approve ? 'Вход подтверждён' : 'Вход отклонён') : 'Запрос устарел');
        if (decided) return reply(event, approve ? 'Вход подтверждён. Вернитесь в DetailFlow.' : 'Вход отклонён. Если это были не вы, сообщите владельцу центра.');
      }
    } catch (error) {
      logger.error('bot dialog failed', error);
    }
  };
}
