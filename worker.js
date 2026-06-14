/**
 * 真照寺 Cloudflare Worker
 * - Anthropic API CORSプロキシ
 * - チャットログ保存 (POST /log)
 * - チャットログ取得 (GET /logs?secret=xxx)
 *
 * 必要な環境変数（Cloudflare Dashboard > Workers > Settings > Variables）:
 *   ANTHROPIC_API_KEY : Anthropic APIキー
 *   ADMIN_SECRET      : 管理画面パスワード（任意の文字列）
 *
 * 必要なKVバインディング（Cloudflare Dashboard > Workers > Settings > KV Namespace Bindings）:
 *   変数名: CHAT_LOGS  → 新規KV Namespaceを作成して紐付け
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── POST /log : チャットログ保存 ────────────────────────────────
    if (url.pathname === '/log' && request.method === 'POST') {
      try {
        const body = await request.json();
        const ts = Date.now();
        const rand = Math.random().toString(36).slice(2, 9);
        const key = `chat:${ts}:${rand}`;
        const entry = {
          userMsg:   String(body.userMsg   || ''),
          aiMsg:     String(body.aiMsg     || ''),
          sessionId: String(body.sessionId || ''),
          pageUrl:   String(body.pageUrl   || ''),
          timestamp: new Date(ts).toISOString(),
        };
        await env.CHAT_LOGS.put(key, JSON.stringify(entry), {
          expirationTtl: 60 * 60 * 24 * 365, // 1年保存
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── GET /logs : チャットログ取得（管理者のみ） ──────────────────
    if (url.pathname === '/logs' && request.method === 'GET') {
      const secret = url.searchParams.get('secret');
      if (!secret || secret !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      const cursor    = url.searchParams.get('cursor') || undefined;
      const limitParam = parseInt(url.searchParams.get('limit') || '500');
      const limit     = Math.min(Math.max(limitParam, 1), 1000);

      const listed = await env.CHAT_LOGS.list({ prefix: 'chat:', limit, cursor });
      const entries = (
        await Promise.all(
          listed.keys.map(async (k) => {
            const v = await env.CHAT_LOGS.get(k.name);
            return v ? JSON.parse(v) : null;
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return new Response(
        JSON.stringify({ entries, cursor: listed.cursor, complete: listed.list_complete }),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    // ── POST / : Anthropic CORSプロキシ（既存機能） ─────────────────
    if (request.method === 'POST') {
      try {
        const body = await request.text();
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
        const data = await resp.text();
        return new Response(data, {
          status: resp.status,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
