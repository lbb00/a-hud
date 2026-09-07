/**
 * An extension for the pi coding agent.
 *
 * pi's own footer already shows tokens, cost, context percentage and the git
 * branch, so this adds one segment beside them instead of replacing the line,
 * and it carries only what pi cannot know by itself: whether the API behind
 * the selected model has an open promotional window, and whether that vendor's
 * status page is currently reporting an incident. Nothing else from the HUD
 * transfers — plan quota is meaningless under API billing, and the compaction
 * estimate is calibrated to Claude Code's thresholds.
 *
 * Both facts belong to the API rather than to pi, so both are shared with
 * every other host that reaches the same endpoint.
 */
import { fileURLToPath } from "node:url";
import {
  currentPromotion,
  healthSourceFor,
  healthState,
  spawnHealthRefresh,
  spawnPromotionsRefresh,
} from "@agent-hud/provider";
import { healthSeverity } from "./design.js";
import { incidentText, promotionText } from "./render.js";

const STATUS_KEY = "agent-hud";
/** The segment counts down, so it is repainted even while a session sits idle. */
const REFRESH_MS = 60_000;
/** The refresh child is this package's own CLI, built beside this file. */
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

/**
 * The slice of pi's extension API this file uses, declared here so the plugin
 * builds and ships without pi installed.
 */
interface PiContext {
  ui: {
    setStatus(key: string, text: string | undefined): void;
    theme: { fg(color: string, text: string): string };
  };
  /** pi's current model, whose `baseUrl` says which API the turn is billed on. */
  model?: { baseUrl?: string } | undefined;
}

interface PiExtensionApi {
  on(
    event: string,
    handler: (event: unknown, ctx: PiContext) => void | Promise<void>,
  ): void;
}

export default function (pi: PiExtensionApi): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let latest: PiContext | undefined;
  /** The last endpoint seen, so a timer repaint does not fall back to a
   * context captured before the model was switched. */
  let latestEndpoint: string | undefined;
  /** Cached vendor status, kept with the endpoint it was read for so a model
   * switch never shows the previous API's incident. */
  let indicator = "";
  let indicatorLabel = "";
  let indicatorEndpoint: string | undefined;

  const tint = (ctx: PiContext, color: string, text: string): string => {
    try {
      return ctx.ui.theme.fg(color, text);
    } catch {
      // pi declares every name used here in its ThemeColor union, but throws on
      // one it does not know. A version that renames a color loses the tint
      // rather than the segment.
      return text;
    }
  };

  const render = (ctx: PiContext, endpoint: string | undefined): void => {
    let promotion = null;
    try {
      // Off-peak pricing belongs to the API, not to pi: the endpoint decides
      // whether the discount applies, and a proxy in front of the same models
      // does not qualify.
      promotion = currentPromotion({ platform: "pi", endpoint });
    } catch {
      // A footer segment is never worth failing a turn over.
    }
    const health = indicatorEndpoint === endpoint ? indicator : "";
    const incident = incidentText(health, indicatorLabel);
    const promotionLabel = promotionText(promotion, Date.now() / 1_000);
    const parts = [
      incident
        ? tint(ctx, healthSeverity(health) === "red" ? "error" : "warning", incident)
        : "",
      promotionLabel
        ? tint(ctx, promotion?.active ? "success" : "dim", promotionLabel)
        : "",
    ].filter(Boolean);
    ctx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" ") : undefined);
  };

  const readHealth = async (endpoint: string | undefined): Promise<void> => {
    const source = healthSourceFor(endpoint);
    if (!source) {
      // An API with no registered status page gets no signal rather than the
      // last one that happened to be cached.
      indicator = "";
      indicatorLabel = "";
      indicatorEndpoint = endpoint;
      return;
    }
    const state = await healthState(source, Math.floor(Date.now() / 1_000));
    indicator = state.indicator;
    indicatorLabel = source.label;
    indicatorEndpoint = endpoint;
    // Nobody else may be running: a pi-only user has to be able to fill this
    // cache, and the lease keeps concurrent hosts down to one request.
    if (state.stale) await spawnHealthRefresh(CLI_PATH, source);
  };

  const paint = (ctx: PiContext, endpoint: string | undefined): void => {
    latest = ctx;
    latestEndpoint = endpoint;
    render(ctx, endpoint);
    // The status file is read off the turn's critical path; the segment is
    // repainted only if the model has not changed underneath the read.
    void (async () => {
      try {
        // The shared schedule is fetched by a detached child, never in a
        // repaint, and pi may be the only host running: without this a pi-only
        // user would keep the copy bundled at publish time forever.
        await spawnPromotionsRefresh(CLI_PATH);
        await readHealth(endpoint);
      } catch {
        // A footer segment is never worth failing a turn over.
      }
      if (latest && latestEndpoint === endpoint) render(latest, endpoint);
    })();
  };

  const track = (event: string): void => {
    pi.on(event, (_event, ctx) => {
      paint(ctx, ctx.model?.baseUrl);
      if (timer) return;
      timer = setInterval(() => {
        if (latest) paint(latest, latestEndpoint);
      }, REFRESH_MS);
      timer.unref?.();
    });
  };

  track("session_start");
  track("turn_end");

  // Switching model can switch APIs, so the segment is answered again with the
  // model the event carries rather than whatever the context still holds.
  pi.on("model_select", (event, ctx) => {
    const selected = (event as { model?: { baseUrl?: string } } | undefined)?.model;
    paint(ctx, selected?.baseUrl);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    latest = undefined;
    latestEndpoint = undefined;
    indicator = "";
    indicatorLabel = "";
    indicatorEndpoint = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
