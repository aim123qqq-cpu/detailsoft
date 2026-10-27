import { randomUUID } from 'node:crypto';
import { connect } from 'node:tls';

/**
 * Letters with sign-in codes, sent through a mailbox's own SMTP server over TLS (for example
 * smtp.mail.ru:465 with a password for external apps). DetailFlow sends a few short plain-text letters,
 * so a small SMTP client is enough. Without SMTP_HOST, SMTP_USER and SMTP_PASSWORD there is no sign-in by email.
 */
export function mailerFromEnv(env = process.env) {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASSWORD: password } = env;
  if (!host || !user || !password) return null;
  return createSmtpMailer({ host, port: Number(env.SMTP_PORT || 465), user, password, from: env.SMTP_FROM || user });
}

const encodeWord = (text) => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;

// `openSocket` is replaced only in tests, with a plain connection to a fake server.
export function createSmtpMailer({ host, port = 465, user, password, from, timeoutMs = 20_000, openSocket = (options) => connect(options) }) {
  return {
    async send({ to, subject, text }) {
      if (/[\r\n<>]/.test(to)) throw new Error('SMTP: bad recipient');
      const message = [
        `From: ${encodeWord('DetailFlow')} <${from}>`,
        `To: <${to}>`,
        `Subject: ${encodeWord(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@${from.split('@')[1] ?? 'detailflow.ru'}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{1,76}/g, '$&\r\n')
      ].join('\r\n');
      // Each step: what to send, the reply code that means "go on", and a name for errors (never the secret).
      await smtpSession({ host, port, timeoutMs, openSocket }, [
        { send: null, expect: [220], name: 'greeting' },
        { send: 'EHLO detailflow', expect: [250], name: 'EHLO' },
        { send: 'AUTH LOGIN', expect: [334], name: 'AUTH' },
        { send: Buffer.from(user).toString('base64'), expect: [334], name: 'AUTH user' },
        { send: Buffer.from(password).toString('base64'), expect: [235], name: 'AUTH password' },
        { send: `MAIL FROM:<${from}>`, expect: [250], name: 'MAIL FROM' },
        { send: `RCPT TO:<${to}>`, expect: [250, 251], name: 'RCPT TO' },
        { send: 'DATA', expect: [354], name: 'DATA' },
        { send: `${message}.`, expect: [250], name: 'message' },
        { send: 'QUIT', expect: [221], name: 'QUIT' }
      ]);
    }
  };
}

function smtpSession({ host, port, timeoutMs, openSocket }, steps) {
  return new Promise((resolvePromise, reject) => {
    const socket = openSocket({ host, port, servername: host });
    let buffer = '';
    let step = 0;
    let done = false;
    const fail = (error) => { if (!done) { done = true; socket.destroy(); reject(error); } };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => fail(new Error(`SMTP ${steps[step].name}: no answer`)));
    socket.on('data', (chunk) => {
      buffer += chunk;
      // A reply ends with a line "NNN text"; "NNN-text" lines before it continue the same reply.
      let match;
      while (!done && (match = buffer.match(/^(?:\d{3}-[^\r\n]*\r\n)*(\d{3})(?:[ \t][^\r\n]*)?\r\n/))) {
        buffer = buffer.slice(match[0].length);
        if (!steps[step].expect.includes(Number(match[1]))) return fail(new Error(`SMTP ${steps[step].name}: ${match[0].trim().slice(0, 200)}`));
        step += 1;
        if (step === steps.length) { done = true; socket.end(); return resolvePromise(); }
        socket.write(`${steps[step].send}\r\n`);
      }
    });
    socket.on('error', (error) => fail(new Error(`SMTP ${steps[step]?.name ?? ''}: ${error.message}`)));
    socket.on('close', () => fail(new Error('SMTP: the server closed the connection')));
  });
}

/** The letter with a sign-in code: the code first, in the subject too, so it can be read from a notification. */
export function signInLetter({ email, code, purpose }) {
  const signup = purpose === 'signup';
  return {
    to: email,
    subject: `${signup ? 'Код для создания центра' : 'Код для входа'} в DetailFlow: ${code}`,
    text: [
      `Ваш код: ${code}`,
      '',
      `Введите его на экране ${signup ? 'создания центра' : 'входа в DetailFlow'}. Код действует 10 минут.`,
      '',
      'Если вы не запрашивали код, просто удалите это письмо: без кода войти никто не сможет.',
      '',
      'DetailFlow — https://detailflow.ru'
    ].join('\n')
  };
}
