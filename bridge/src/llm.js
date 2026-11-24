// Универсальный клиент LLM: OpenAI-совместимые API (OpenAI, DeepSeek, OpenRouter,
// Ollama, LM Studio, Groq…) и Anthropic (Claude).

export function createLLM(cfg) {
  const provider = (cfg.provider || 'openai').toLowerCase();
  const apiKey = cfg.api_key || process.env.LLM_API_KEY || '';
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, errors: 0 };

  async function chat({ system, user, model, maxTokens, temperature, json = true }) {
    model = model || cfg.model;
    maxTokens = maxTokens || cfg.max_tokens || 700;
    temperature = temperature ?? cfg.temperature;
    stats.calls++;
    try {
      const res = provider === 'anthropic'
        ? await callAnthropic({ apiKey, cfg, system, user, model, maxTokens, temperature })
        : await callOpenAI({ apiKey, cfg, system, user, model, maxTokens, temperature, json });
      stats.inputTokens += res.usage.input;
      stats.outputTokens += res.usage.output;
      return res.text;
    } catch (e) {
      stats.errors++;
      throw e;
    }
  }

  async function chatJSON(args) {
    let text = await chat(args);
    try {
      return parseJSON(text);
    } catch {
      // одна повторная попытка с напоминанием о формате
      text = await chat({ ...args, user: args.user + '\n\nВНИМАНИЕ: ответь ТОЛЬКО валидным JSON-объектом, без пояснений.' });
      return parseJSON(text);
    }
  }

  return { chat, chatJSON, stats, provider };
}

async function callOpenAI({ apiKey, cfg, system, user, model, maxTokens, temperature, json }) {
  const base = (cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const tokenParam = cfg.token_param || 'max_tokens';
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    [tokenParam]: maxTokens,
  };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (json && cfg.json_mode !== false) body.response_format = { type: 'json_object' };
  // Дополнительные параметры провайдера (например, отключение «размышлений» у DeepSeek)
  const extraKeys = cfg.extra_body && !cfg._extraRejected ? Object.keys(cfg.extra_body) : [];
  for (const k of extraKeys) body[k] = cfg.extra_body[k];

  let data;
  try {
    data = await postJSON(`${base}/chat/completions`, body, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
  } catch (e) {
    const extraHit = extraKeys.filter((k) => new RegExp(k, 'i').test(e.message));
    // Новые модели OpenAI не принимают max_tokens/temperature — пробуем совместимый вариант
    if (e.status === 400 && (extraHit.length || /max_tokens|temperature|response_format/i.test(e.message))) {
      const retry = { ...body };
      if (/max_tokens/i.test(e.message)) { delete retry.max_tokens; retry.max_completion_tokens = maxTokens; }
      if (/temperature/i.test(e.message)) delete retry.temperature;
      if (/response_format/i.test(e.message)) delete retry.response_format;
      if (extraHit.length) {
        // провайдер не понимает extra_body — больше не отправляем
        cfg._extraRejected = true;
        for (const k of extraKeys) delete retry[k];
        console.warn(`[llm] провайдер отклонил extra_body (${extraHit.join(', ')}), отправляю без него`);
      }
      data = await postJSON(`${base}/chat/completions`, retry, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    } else throw e;
  }
  const text = data?.choices?.[0]?.message?.content ?? '';
  return {
    text,
    usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
  };
}

async function callAnthropic({ apiKey, cfg, system, user, model, maxTokens, temperature }) {
  const base = (cfg.base_url || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  let data;
  try {
    data = await postJSON(`${base}/v1/messages`, body, headers);
  } catch (e) {
    if (e.status === 400 && /temperature/i.test(e.message)) {
      delete body.temperature;
      data = await postJSON(`${base}/v1/messages`, body, headers);
    } else throw e;
  }
  const text = (data?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return {
    text,
    usage: { input: data?.usage?.input_tokens ?? 0, output: data?.usage?.output_tokens ?? 0 },
  };
}

async function postJSON(url, body, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

export function parseJSON(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('в ответе нет JSON: ' + s.slice(0, 200));
  return JSON.parse(s.slice(a, b + 1));
}
