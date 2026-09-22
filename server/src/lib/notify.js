import crypto from 'node:crypto';

// Sends texts and automated calls. 'console' records messages in memory and prints them (for trying things out).
// 'twilio' sends real ones using Twilio's REST API. NOTE: the Twilio branch is written to Twilio's documented API but
// has not been run against a live account. Test it with your own account before relying on it.
export function createNotifier(config) {
  const outbox = [];
  const record = (m) => { outbox.unshift({ at: new Date().toISOString(), ...m }); outbox.length = Math.min(outbox.length, 300); };

  async function twilio(path, form) {
    const { sid, token, from } = config.twilio;
    if (!sid || !token || !from) throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, ...form })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || 'Twilio error');
    return json.sid;
  }

  return {
    outbox,
    async sendSms(to, body, meta = {}) {
      if (config.notifyProvider === 'twilio') {
        const id = await twilio('Messages', { To: to, Body: body });
        record({ kind: 'sms', to, body, provider: 'twilio', id, ...meta });
        return { provider: 'twilio', id };
      }
      const id = 'console-' + crypto.randomUUID();
      record({ kind: 'sms', to, body, provider: 'console', id, ...meta });
      if (process.env.NODE_ENV !== 'test') console.log(`[SMS to ${to}] ${body}`);
      return { provider: 'console', id };
    },
    async sendCall(to, script, meta = {}) {
      if (config.notifyProvider === 'twilio') {
        const twiml = `<Response><Say>${script.replace(/[<>&]/g, ' ')}</Say></Response>`;
        const id = await twilio('Calls', { To: to, Twiml: twiml });
        record({ kind: 'call', to, body: script, provider: 'twilio', id, ...meta });
        return { provider: 'twilio', id };
      }
      const id = 'console-' + crypto.randomUUID();
      record({ kind: 'call', to, body: script, provider: 'console', id, ...meta });
      if (process.env.NODE_ENV !== 'test') console.log(`[CALL to ${to}] ${script}`);
      return { provider: 'console', id };
    }
  };
}
