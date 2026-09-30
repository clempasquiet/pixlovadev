import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../src/lib/email.js';

/** Serveur SMTP minimal : accepte tout et conserve le dernier message (boîte de capture). */
function fakeSmtp(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer((socket: Socket) => {
    let data = false;
    let buffer = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 OK\r\n');
          } else {
            messages[messages.length - 1] += `${line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-test\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') {
          data = true;
          messages.push('');
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        messages,
      });
    });
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

describe('SmtpMailer', () => {
  it('envoie le message rendu au serveur SMTP configuré', async () => {
    const smtp = await fakeSmtp();
    server = smtp.server;
    const mailer = new SmtpMailer(
      `smtp://127.0.0.1:${smtp.port}`,
      'pixlova <noreply@recette.test>',
    );
    await mailer.send({
      to: 'alice@example.test',
      subject: 'Vérifiez votre adresse',
      text: 'Lien : https://recette.test/verify#t=abc',
    });
    expect(smtp.messages).toHaveLength(1);
    const message = smtp.messages[0]!;
    expect(message).toContain('To: alice@example.test');
    expect(message).toContain('From: pixlova <noreply@recette.test>');
    expect(message).toMatch(/Subject: .+/);
  });

  it('remonte une erreur quand le serveur est injoignable (email conservé pour relance)', async () => {
    const mailer = new SmtpMailer('smtp://127.0.0.1:1', 'noreply@recette.test');
    await expect(mailer.send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toThrow();
  });
});
