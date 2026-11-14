import { Replay, wrapTool, type ReplayStore } from "@agent-replay-lab/core";

/**
 * Minimal tool-using agent (no live LLM).
 * Demonstrates orchestration that Agent Replay Lab can cassette-test.
 */
export async function runBasicAgent(
  store: ReplayStore,
  projectId: string,
  opts?: {
    label?: string;
    /** Intentional regression: wrong city for getWeather */
    regressCity?: string;
    apiKey?: string;
  },
): Promise<{ runId: string }> {
  const replay = new Replay({
    store,
    projectId,
    label: opts?.label ?? "basic-agent",
    source: { framework: "basic-agent", adapter: "wrapTool" },
  });

  const getWeather = wrapTool(replay, "getWeather", async (args: { city: string }) => ({
    city: args.city,
    tempC: args.city === "Berlin" ? 21 : 18,
    unit: "C",
  }));

  const searchDocs = wrapTool(
    replay,
    "searchDocs",
    async (args: { query: string; apiKey: string }) => ({
      query: args.query,
      hits: [`result-for:${args.query}`],
    }),
  );

  const sendSummary = wrapTool(replay, "sendSummary", async (args: { text: string }) => ({
    delivered: true,
    chars: args.text.length,
  }));

  const city = opts?.regressCity ?? "Berlin";
  const weather = await getWeather.execute({ city });
  const docs = await searchDocs.execute({
    query: "agent replay lab",
    apiKey: opts?.apiKey ?? "sk-demo-abcdefghijklmnopqrstuvwxyz",
  });
  const text = `${weather.city} is ${weather.tempC}${weather.unit}. Docs: ${docs.hits[0]}`;
  await sendSummary.execute({ text });

  replay.complete({ toolCount: 3 });
  return { runId: replay.runId };
}
