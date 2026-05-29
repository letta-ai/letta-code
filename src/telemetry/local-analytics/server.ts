import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_LOCAL_ANALYTICS_PORT,
  type LocalAnalyticsEvent,
} from "./types";

export interface LocalAnalyticsServerOptions {
  port?: number;
  host?: string;
  maxEvents?: number;
  persist?: boolean;
  persistPath?: string;
}

export interface LocalAnalyticsServerHandle {
  url: string;
  stop: () => Promise<void>;
}

const encoder = new TextEncoder();

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeEvent(value: unknown): LocalAnalyticsEvent | null {
  if (!isRecord(value) || value.type !== "anthropic_usage") return null;
  const usage = isRecord(value.usage) ? value.usage : {};
  const agentId = stringValue(value.agentId);
  const conversationId = stringValue(value.conversationId);
  const model = stringValue(value.model);
  const latencyMs = numberValue(value.latencyMs);
  if (!agentId || !conversationId || !model || latencyMs === undefined)
    return null;

  return {
    type: "anthropic_usage",
    timestamp: numberValue(value.timestamp) ?? Date.now(),
    instanceId: stringValue(value.instanceId) ?? "unknown",
    processId: numberValue(value.processId) ?? 0,
    hostname: stringValue(value.hostname) ?? "unknown",
    cwd: stringValue(value.cwd) ?? "",
    agentId,
    conversationId,
    model,
    provider: "anthropic",
    ...(stringValue(value.responseModel)
      ? { responseModel: stringValue(value.responseModel) }
      : {}),
    ...(stringValue(value.requestId)
      ? { requestId: stringValue(value.requestId) }
      : {}),
    latencyMs,
    ...(numberValue(value.ttftMs) !== undefined
      ? { ttftMs: numberValue(value.ttftMs) }
      : {}),
    streamed: value.streamed === true,
    usage: {
      ...(numberValue(usage.inputTokens) !== undefined
        ? { inputTokens: numberValue(usage.inputTokens) }
        : {}),
      ...(numberValue(usage.outputTokens) !== undefined
        ? { outputTokens: numberValue(usage.outputTokens) }
        : {}),
      ...(numberValue(usage.cacheCreationInputTokens) !== undefined
        ? {
            cacheCreationInputTokens: numberValue(
              usage.cacheCreationInputTokens,
            ),
          }
        : {}),
      ...(numberValue(usage.cacheReadInputTokens) !== undefined
        ? { cacheReadInputTokens: numberValue(usage.cacheReadInputTokens) }
        : {}),
      ...(numberValue(usage.totalTokens) !== undefined
        ? { totalTokens: numberValue(usage.totalTokens) }
        : {}),
    },
  };
}

function defaultPersistPath(): string {
  return join(homedir(), ".letta", "local-analytics", "events.jsonl");
}

async function persistEvent(
  event: LocalAnalyticsEvent,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

function html(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Letta Local Analytics</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0f14; color: #e7edf5; }
    body { margin: 0; padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 22px; }
    .muted { color: #8a98aa; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .card { background: #111821; border: 1px solid #263241; border-radius: 12px; padding: 14px; }
    .metric { font-size: 28px; font-weight: 700; margin-top: 6px; }
    .chart-wrap { height: 360px; }
    canvas { width: 100%; height: calc(100% - 34px); }
    .legend { display: flex; flex-wrap: wrap; gap: 10px 16px; min-height: 24px; margin-bottom: 10px; font-size: 13px; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #243040; white-space: nowrap; }
    th { color: #9fb0c3; font-weight: 600; }
    .ok { color: #79e2a0; }
    .warn { color: #f6c177; }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <header>
    <div><h1>Letta Local Analytics</h1><div class="muted">Anthropic cache utilization, live from local instances</div></div>
    <div id="status" class="muted">connecting…</div>
  </header>
  <section class="grid">
    <div class="card"><div class="muted">Events</div><div id="events" class="metric">0</div></div>
    <div class="card"><div class="muted">Active instances</div><div id="instances" class="metric">0</div></div>
    <div class="card"><div class="muted">Cache utilization</div><div id="util" class="metric">0%</div></div>
    <div class="card"><div class="muted">Cache hit/write</div><div id="hitwrite" class="metric">0%</div></div>
  </section>
  <section class="card chart-wrap"><div id="legend" class="legend"></div><canvas id="chart"></canvas></section>
  <section class="card" style="margin-top:18px; overflow:auto">
    <h2 style="font-size:16px; margin:0 0 10px">Recent requests</h2>
    <table><thead><tr><th>Time</th><th>Model</th><th>Instance</th><th>Latency</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th><th>Util</th></tr></thead><tbody id="rows"></tbody></table>
  </section>
  <script src="/app.js"></script>
</body>
</html>`;
}

function appJs(): string {
  return 'const events = [];\nconst maxEvents = 500;\nconst colors = ["#79e2a0", "#7dcfff", "#f6c177", "#c4a7e7", "#eb6f92", "#9ccfd8", "#f6a8b6", "#a6da95", "#f5bde6", "#8aadf4"];\nconst $ = (id) => document.getElementById(id);\nconst chart = $("chart");\nconst ctx = chart.getContext("2d");\nfunction n(v) { return typeof v === "number" ? v : 0; }\nfunction pct(v) { return Number.isFinite(v) ? Math.round(v * 100) + "%" : "0%"; }\nfunction util(e) {\n  const u = e.usage || {};\n  const denom = n(u.inputTokens) + n(u.cacheCreationInputTokens) + n(u.cacheReadInputTokens);\n  return denom > 0 ? n(u.cacheReadInputTokens) / denom : 0;\n}\nfunction totals() {\n  const t = { input: 0, output: 0, write: 0, read: 0 };\n  for (const e of events) {\n    const u = e.usage || {};\n    t.input += n(u.inputTokens);\n    t.output += n(u.outputTokens);\n    t.write += n(u.cacheCreationInputTokens);\n    t.read += n(u.cacheReadInputTokens);\n  }\n  return t;\n}\nfunction instanceKey(e) {\n  return e.instanceId || ((e.hostname || "unknown") + ":" + (e.processId || "0"));\n}\nfunction instanceLabel(key) {\n  const latest = [...events].reverse().find(e => instanceKey(e) === key);\n  if (!latest) return key;\n  const pid = latest.processId ? "pid " + latest.processId : key;\n  const host = latest.hostname || "local";\n  const name = host + " · " + pid;\n  return name.length > 34 ? name.slice(0, 31) + "…" : name;\n}\nfunction instancesWithColors() {\n  const keys = [...new Set(events.map(instanceKey))];\n  return keys.map((key, index) => ({ key, color: colors[index % colors.length], label: instanceLabel(key) }));\n}\nfunction resizeCanvas() {\n  const r = chart.getBoundingClientRect();\n  const dpr = window.devicePixelRatio || 1;\n  chart.width = Math.floor(r.width * dpr);\n  chart.height = Math.floor(r.height * dpr);\n  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);\n}\nfunction drawAxes(w, h) {\n  ctx.strokeStyle = "#263241";\n  ctx.lineWidth = 1;\n  for (let i = 0; i <= 4; i++) {\n    const y = 20 + i * (h - 44) / 4;\n    ctx.beginPath();\n    ctx.moveTo(40, y);\n    ctx.lineTo(w - 12, y);\n    ctx.stroke();\n  }\n  ctx.fillStyle = "#9fb0c3";\n  ctx.font = "12px system-ui";\n  ctx.fillText("100%", 4, 24);\n  ctx.fillText("0%", 16, h - 20);\n}\nfunction drawSeries(seriesEvents, color, minTime, maxTime, w, h) {\n  if (seriesEvents.length === 0) return;\n  const range = Math.max(1, maxTime - minTime);\n  const points = seriesEvents.map(e => ({\n    x: 40 + ((e.timestamp - minTime) / range) * (w - 60),\n    y: 20 + (1 - util(e)) * (h - 44),\n  }));\n  ctx.strokeStyle = color;\n  ctx.lineWidth = 2;\n  ctx.beginPath();\n  points.forEach((p, i) => {\n    if (i === 0) ctx.moveTo(p.x, p.y);\n    else ctx.lineTo(p.x, p.y);\n  });\n  ctx.stroke();\n  ctx.fillStyle = color;\n  for (const p of points) {\n    ctx.beginPath();\n    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);\n    ctx.fill();\n  }\n}\nfunction drawChart() {\n  resizeCanvas();\n  const w = chart.getBoundingClientRect().width;\n  const h = chart.getBoundingClientRect().height;\n  ctx.clearRect(0, 0, w, h);\n  drawAxes(w, h);\n  const recent = events.slice(-200);\n  if (recent.length === 0) return;\n  const minTime = Math.min(...recent.map(e => e.timestamp));\n  const maxTime = Math.max(...recent.map(e => e.timestamp));\n  for (const inst of instancesWithColors()) {\n    drawSeries(recent.filter(e => instanceKey(e) === inst.key), inst.color, minTime, maxTime, w, h);\n  }\n}\nfunction renderLegend() {\n  $("legend").innerHTML = instancesWithColors().map(inst => \'<span class="legend-item"><span class="swatch" style="background:\' + inst.color + \'"></span>\' + inst.label + \'</span>\').join("");\n}\nfunction render() {\n  const t = totals();\n  const instances = new Set(events.map(instanceKey));\n  $("events").textContent = String(events.length);\n  $("instances").textContent = String(instances.size);\n  $("util").textContent = pct(t.read / Math.max(1, t.input + t.write + t.read));\n  $("hitwrite").textContent = pct(t.read / Math.max(1, t.read + t.write));\n  $("rows").innerHTML = events.slice(-80).reverse().map(e => {\n    const u = e.usage || {};\n    const inst = instanceLabel(instanceKey(e));\n    return \'<tr><td>\' + new Date(e.timestamp).toLocaleTimeString() + \'</td><td>\' + e.model + \'</td><td>\' + inst + \'</td><td>\' + Math.round(e.latencyMs) + \'ms</td><td>\' + n(u.inputTokens) + \'</td><td>\' + n(u.cacheCreationInputTokens) + \'</td><td class="ok">\' + n(u.cacheReadInputTokens) + \'</td><td>\' + n(u.outputTokens) + \'</td><td>\' + pct(util(e)) + \'</td></tr>\';\n  }).join("");\n  renderLegend();\n  drawChart();\n}\nasync function init() {\n  const res = await fetch(\'/events/recent\');\n  const data = await res.json();\n  events.push(...(data.events || []));\n  render();\n  const es = new EventSource(\'/stream\');\n  es.onopen = () => { $(\'status\').textContent = \'live\'; $(\'status\').className = \'ok\'; };\n  es.onerror = () => { $(\'status\').textContent = \'reconnecting…\'; $(\'status\').className = \'warn\'; };\n  es.onmessage = (msg) => {\n    events.push(JSON.parse(msg.data));\n    while (events.length > maxEvents) events.shift();\n    render();\n  };\n}\nwindow.addEventListener(\'resize\', drawChart);\ninit().catch(err => { $(\'status\').textContent = String(err); });';
}

export async function startLocalAnalyticsServer(
  options: LocalAnalyticsServerOptions = {},
): Promise<LocalAnalyticsServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_LOCAL_ANALYTICS_PORT;
  const maxEvents = options.maxEvents ?? 10_000;
  const events: LocalAnalyticsEvent[] = [];
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const persistPath = options.persistPath ?? defaultPersistPath();

  function publish(event: LocalAnalyticsEvent): void {
    events.push(event);
    while (events.length > maxEvents) events.shift();
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const client of clients) client.enqueue(payload);
  }

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(html(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        return new Response(appJs(), {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, events: events.length });
      }
      if (request.method === "GET" && url.pathname === "/events/recent") {
        return json({ events });
      }
      if (request.method === "GET" && url.pathname === "/stream") {
        let streamController:
          | ReadableStreamDefaultController<Uint8Array>
          | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            clients.add(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            if (streamController) clients.delete(streamController);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/events") {
        const event = normalizeEvent(await request.json().catch(() => null));
        if (!event) return json({ error: "invalid event" }, { status: 400 });
        publish(event);
        if (options.persist) void persistEvent(event, persistPath);
        return json({ ok: true });
      }
      return json({ error: "not found" }, { status: 404 });
    },
  });

  return {
    url: `http://${host}:${server.port}`,
    stop: async () => {
      server.stop(true);
    },
  };
}
