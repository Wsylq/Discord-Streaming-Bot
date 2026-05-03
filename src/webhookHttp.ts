import * as https from 'https';
import * as http from 'http';

/** POST or PATCH a Discord webhook message. Returns the message ID. */
export async function webhookRequest(
  webhookUrl: string,
  method: 'POST' | 'PATCH',
  messageId: string | null,
  body: object,
): Promise<string | null> {
  const url = messageId
    ? `${webhookUrl}/messages/${messageId}?wait=true`
    : `${webhookUrl}?wait=true`;

  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await new Promise<{ id: string | null; retryAfter: number | null }>((resolve) => {
      const req = lib.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (res.statusCode === 429) {
                const retryAfter = (json.retry_after ?? 1) * 1000 + 100;
                resolve({ id: null, retryAfter });
              } else {
                if (res.statusCode && res.statusCode >= 400) {
                  console.warn(`[webhook] HTTP ${res.statusCode}:`, data.slice(0, 200));
                }
                resolve({ id: json.id ?? null, retryAfter: null });
              }
            } catch {
              resolve({ id: null, retryAfter: null });
            }
          });
        },
      );
      req.on('error', () => resolve({ id: null, retryAfter: null }));
      req.write(payload);
      req.end();
    });

    if (result.retryAfter !== null) {
      await new Promise(r => setTimeout(r, result.retryAfter!));
      continue; // retry
    }

    return result.id;
  }

  return null;
}
