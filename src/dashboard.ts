// A single-user, read-only status page: "where do I stand today" at a glance,
// bookmarkable on a phone home screen. Deliberately NOT part of the MCP tool
// surface — this is plain HTML over a plain GET, gated by a long random token
// in the query string (DASHBOARD_TOKEN) rather than OAuth, so opening it is
// "open the bookmark", not "sign in again". Self-hosted, single-tenant use
// only: the token identifies "the owner", not a specific account, so this
// route intentionally does not support more than one user.
import type { Hono } from "hono";
import { getSupabase, getMealsByDate, getNutritionGoals, getProfile } from "./supabase.js";
import { todayInTz } from "./tz.js";
import { fromGrams, type WeightUnit } from "./units.js";

// Cached after the first successful lookup — the owner's user id never
// changes for the life of a deploy, and re-resolving it by email on every
// page load would be one extra Supabase round trip for no benefit.
let cachedUserId: string | null = null;

async function resolveOwnerUserId(email: string): Promise<string | null> {
    if (cachedUserId) return cachedUserId;
    // Single-user deploy: one page of results is always enough. listUsers has
    // no server-side email filter in supabase-js v2, so this scans client-side.
    const { data, error } = await getSupabase().auth.admin.listUsers({
        page: 1,
        perPage: 200,
    });
    if (error) throw new Error(`Failed to resolve dashboard user: ${error.message}`);
    const match = data.users.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (!match) return null;
    cachedUserId = match.id;
    return match.id;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** A goal bar: consumed vs. target, or a bare total when no goal is set. */
function bar(
    label: string,
    consumed: number,
    goal: number | null,
    unit: string,
    isCeiling: boolean,
): string {
    const consumedStr = Math.round(consumed * 10) / 10;
    if (goal == null || goal === 0) {
        return `<div class="row"><div class="row-label">${label}</div><div class="row-value">${consumedStr}${unit}</div></div>`;
    }
    const pct = Math.min(100, Math.round((consumed / goal) * 100));
    // Ceilings (sugar, alcohol, caffeine) turn red past 100%; floors (protein,
    // fiber, water) turn green once met and never alarm past 100%.
    const over = pct >= 100;
    const barClass = isCeiling ? (over ? "bar-fill over" : "bar-fill") : over ? "bar-fill met" : "bar-fill";
    const remaining = Math.round((goal - consumed) * 10) / 10;
    const remainLabel = isCeiling
        ? remaining >= 0
            ? `${remaining}${unit} left`
            : `${Math.abs(remaining)}${unit} over`
        : remaining > 0
          ? `${remaining}${unit} to go`
          : "goal met";
    return `
    <div class="row">
      <div class="row-label">${label}</div>
      <div class="row-value">${consumedStr} / ${goal}${unit}</div>
    </div>
    <div class="bar-track"><div class="${barClass}" style="width:${pct}%"></div></div>
    <div class="row-sub">${remainLabel}</div>`;
}

export function registerDashboardRoute(app: Hono): void {
    app.get("/dashboard", async (c) => {
        const token = c.req.query("token");
        const expected = process.env.DASHBOARD_TOKEN;
        const email = process.env.DASHBOARD_USER_EMAIL;
        // 404, not 401/403: a guessed-but-wrong token should look identical to
        // this route not existing at all, not confirm it exists.
        if (!expected || !email || !token || token !== expected) {
            return c.notFound();
        }

        let userId: string | null;
        try {
            userId = await resolveOwnerUserId(email);
        } catch (err) {
            console.error("Dashboard: failed to resolve user:", err);
            return c.text("Temporarily unavailable", 503);
        }
        if (!userId) return c.text("Dashboard user not found", 404);

        try {
            const profile = await getProfile(userId);
            const tz = profile?.timezone ?? "UTC";
            const weightUnit: WeightUnit = profile?.preferred_weight_unit ?? "lb";
            const today = todayInTz(tz);

            const [meals, goals, latestWeight] = await Promise.all([
                getMealsByDate(userId, today, tz),
                getNutritionGoals(userId),
                getSupabase()
                    .from("weight_log")
                    .select("weight_g, logged_at")
                    .eq("user_id", userId)
                    .order("logged_at", { ascending: false })
                    .limit(1)
                    .maybeSingle(),
            ]);

            const totals = meals.reduce(
                (acc, m) => ({
                    calories: acc.calories + (m.calories ?? 0),
                    protein_g: acc.protein_g + (m.protein_g ?? 0),
                    carbs_g: acc.carbs_g + (m.carbs_g ?? 0),
                    fat_g: acc.fat_g + (m.fat_g ?? 0),
                    fiber_g: acc.fiber_g + (m.fiber_g ?? 0),
                    sugar_g: acc.sugar_g + (m.sugar_g ?? 0),
                    alcohol_g: acc.alcohol_g + (m.alcohol_g ?? 0),
                    caffeine_mg: acc.caffeine_mg + (m.caffeine_mg ?? 0),
                }),
                {
                    calories: 0,
                    protein_g: 0,
                    carbs_g: 0,
                    fat_g: 0,
                    fiber_g: 0,
                    sugar_g: 0,
                    alcohol_g: 0,
                    caffeine_mg: 0,
                },
            );

            const calGoal = goals?.daily_calories ?? null;
            const calRemaining = calGoal != null ? calGoal - totals.calories : null;

            const mealRows = meals
                .map((m) => {
                    const time = new Intl.DateTimeFormat("en-US", {
                        timeZone: tz,
                        hour: "numeric",
                        minute: "2-digit",
                    }).format(new Date(m.logged_at));
                    const kcal = m.calories != null ? `${Math.round(m.calories)} kcal` : "—";
                    return `<div class="meal"><div class="meal-time">${time}</div><div class="meal-desc">${escapeHtml(m.description)}</div><div class="meal-kcal">${kcal}</div></div>`;
                })
                .join("");

            const weightRow = latestWeight.data
                ? `<div class="row"><div class="row-label">Latest weight</div><div class="row-value">${formatWeightLine(latestWeight.data.weight_g, weightUnit, latestWeight.data.logged_at, tz)}</div></div>`
                : "";

            const html = renderPage({
                today,
                calGoal,
                calConsumed: totals.calories,
                calRemaining,
                totals,
                goals,
                mealRows: mealRows || `<div class="empty">Nothing logged yet today.</div>`,
                weightRow,
                token,
                awakeFrac: awakeFraction(tz),
            });

            return c.html(html);
        } catch (err) {
            console.error("Dashboard render failed:", err);
            return c.text("Temporarily unavailable", 503);
        }
    });
}

function formatWeightLine(
    weightG: number,
    unit: WeightUnit,
    loggedAt: string,
    tz: string,
): string {
    const date = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        month: "short",
        day: "numeric",
    }).format(new Date(loggedAt));
    return `${fromGrams(weightG, unit)} ${unit} <span class="row-sub-inline">(${date})</span>`;
}

/**
 * Fraction (0–1) of the way through the "awake window" (6:00am–9:00pm, 15h)
 * the given moment is, in the given timezone. 0 before 6am, 1 at/after 9pm —
 * so the ring is empty overnight and full once the day's awake hours are spent,
 * same shape as the calorie ring rather than wrapping past a full circle.
 */
function awakeFraction(tz: string, now: Date = new Date()): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hourCycle: "h23",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const hourDecimal = get("hour") + get("minute") / 60 + get("second") / 3600;
    const WINDOW_START = 6; // 6:00am
    const WINDOW_HOURS = 15; // through 9:00pm
    return Math.min(1, Math.max(0, (hourDecimal - WINDOW_START) / WINDOW_HOURS));
}

/** A compact stat block (fiber/sugar/alcohol/caffeine): value + thin bar or "no goal set". */
function stat(
    label: string,
    consumed: number,
    goal: number | null,
    unit: string,
    isCeiling: boolean,
    subLabel?: string,
): string {
    const consumedStr = Math.round(consumed * 10) / 10;
    if (goal == null || goal === 0) {
        return `
    <div class="stat">
      <div class="stat-top"><span class="stat-label">${label}</span><span class="stat-value">${consumedStr}<span class="stat-unit">${unit}</span></span></div>
      <div class="bar-track thin"><div class="bar-fill" style="width:0%"></div></div>
      <div class="row-sub">${subLabel ? subLabel + " · " : ""}no goal set</div>
    </div>`;
    }
    const pct = Math.min(100, Math.round((consumed / goal) * 100));
    const over = pct >= 100;
    const barClass = isCeiling ? (over ? "bar-fill over" : "bar-fill") : over ? "bar-fill met" : "bar-fill";
    return `
    <div class="stat">
      <div class="stat-top"><span class="stat-label">${label}</span><span class="stat-value">${consumedStr}<span class="stat-unit">${unit}</span></span></div>
      <div class="bar-track thin"><div class="${barClass}" style="width:${pct}%"></div></div>
      <div class="row-sub">${subLabel ? subLabel + " · " : ""}goal ${goal}${unit}</div>
    </div>`;
}

function renderPage(opts: {
    today: string;
    calGoal: number | null;
    calConsumed: number;
    calRemaining: number | null;
    totals: {
        protein_g: number;
        carbs_g: number;
        fat_g: number;
        fiber_g: number;
        sugar_g: number;
        alcohol_g: number;
        caffeine_mg: number;
    };
    goals: {
        daily_protein_g: number | null;
        daily_carbs_g: number | null;
        daily_fat_g: number | null;
        daily_fiber_g: number | null;
        daily_sugar_g: number | null;
        daily_alcohol_g: number | null;
        daily_caffeine_mg: number | null;
    } | null;
    mealRows: string;
    weightRow: string;
    token: string;
    awakeFrac: number;
}): string {
    const {
        today,
        calGoal,
        calConsumed,
        calRemaining,
        totals,
        goals,
        mealRows,
        weightRow,
        token,
        awakeFrac,
    } = opts;

    const heroOver = calGoal != null && calRemaining! < 0;
    const pct = calGoal != null ? Math.min(100, Math.round((calConsumed / calGoal) * 100)) : 0;
    const heroValue = calGoal == null ? Math.round(calConsumed) : Math.abs(Math.round(calRemaining!));
    const heroLabel = calGoal == null ? "Consumed today" : heroOver ? "Over today's goal" : "Calories remaining";
    const heroSummary =
        calGoal != null ? `${Math.round(calConsumed).toLocaleString()} / ${calGoal.toLocaleString()} kcal` : "";

    // Ring: circumference for r=54 is 2*pi*54 ≈ 339.3
    const CIRC = 339.3;
    const ringOffset = CIRC - (CIRC * pct) / 100;
    const ringColor = heroOver ? "#e0785a" : "#e0a63a";

    // Awake-hours-elapsed: a solid disc inside the calorie ring, filled
    // clockwise from 12 o'clock via conic-gradient (its 0deg is "to top",
    // matching the ring's rotated coordinate space) — two close shades of
    // the same blue rather than a second competing ring.
    const awakeDeg = Math.round(awakeFrac * 360);
    const awakeFillCss = `background: conic-gradient(#5b9bd9 0deg ${awakeDeg}deg, #223447 ${awakeDeg}deg 360deg);`;

    const drinkUnitG = 14; // US standard drink; matches set_alcohol_tracking's "us" default
    const drinksNote =
        totals.alcohol_g > 0 ? `${Math.round((totals.alcohol_g / drinkUnitG) * 10) / 10} US drinks` : undefined;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="90" />
<title>Nutrition — ${today}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 60px;
    background: #0e1013; color: #e8e8e8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .date { text-align: center; color: #8a8f98; font-size: 14px; margin-bottom: 20px; }
  .card {
    background: #17191d; border: 1px solid #23262b; border-radius: 18px; padding: 20px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #8a8f98; margin: 0 0 14px; font-weight: 700; }

  /* Hero: ring + big number */
  .hero-card { display: flex; align-items: center; gap: 22px; }
  .ring-wrap { position: relative; width: 128px; height: 128px; flex-shrink: 0; }
  .ring-wrap svg { transform: rotate(-90deg); }
  .ring-pct { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; font-size: 20px; font-weight: 700; color: ${ringColor}; }
  .awake-fill { position: absolute; top: 50%; left: 50%; width: 76px; height: 76px;
    border-radius: 50%; transform: translate(-50%, -50%); }
  .hero-num { font-size: 40px; font-weight: 800; line-height: 1; color: #f3f3f3; }
  .hero-num.over { color: #ff8a6b; }
  .hero-label { color: #9aa0aa; font-size: 14px; margin-top: 6px; }
  .hero-summary { color: #6f7480; font-size: 13px; margin-top: 4px; }

  .row { display: flex; justify-content: space-between; align-items: baseline;
    font-size: 15px; margin-top: 12px; }
  .row:first-of-type { margin-top: 0; }
  .row-label { color: #c7cad1; font-weight: 600; }
  .row-value { font-weight: 700; }
  .row-sub { font-size: 12px; color: #6f7480; margin-top: 4px; }
  .row-sub-inline { color: #6f7480; font-weight: 400; font-size: 13px; }
  .bar-track { height: 8px; background: #23262b; border-radius: 4px; margin-top: 7px; overflow: hidden; }
  .bar-track.thin { height: 6px; }
  .bar-fill { height: 100%; background: #5b9bd9; border-radius: 4px; transition: width .3s; }
  .bar-fill.met { background: #4fc08a; }
  .bar-fill.over { background: #e0605a; }

  /* Stat grid: fiber/sugar/alcohol/caffeine, 2-up */
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px 20px; }
  .stat-top { display: flex; justify-content: space-between; align-items: baseline; }
  .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #9aa0aa; font-weight: 700; }
  .stat-value { font-size: 17px; font-weight: 700; color: #f0f0f0; }
  .stat-unit { font-size: 12px; color: #8a8f98; font-weight: 500; margin-left: 2px; }

  .meal { display: flex; align-items: baseline; gap: 10px; padding: 10px 0;
    border-top: 1px solid #23262b; font-size: 14px; }
  .meal:first-child { border-top: none; }
  .meal-time { color: #6f7480; width: 60px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .meal-desc { flex: 1; color: #d5d7dc; }
  .meal-kcal { color: #8a8f98; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .empty { color: #6f7480; font-size: 14px; }
  .refresh { display: block; text-align: center; margin-top: 20px; }
  .refresh a { color: #5b9bd9; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
  <div class="date">${today}</div>

  <div class="card hero-card">
    <div class="ring-wrap">
      <div class="awake-fill" style="${awakeFillCss}"></div>
      <svg width="128" height="128" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r="54" fill="none" stroke="#23262b" stroke-width="12" />
        <circle cx="64" cy="64" r="54" fill="none" stroke="${ringColor}" stroke-width="12"
          stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${ringOffset}" />
      </svg>
      <div class="ring-pct">${calGoal != null ? pct + "%" : ""}</div>
    </div>
    <div>
      <div class="hero-num${heroOver ? " over" : ""}">${heroValue.toLocaleString()}</div>
      <div class="hero-label">${heroLabel}</div>
      ${heroSummary ? `<div class="hero-summary">${heroSummary}</div>` : ""}
    </div>
  </div>

  <div class="card">
    <h2>Macros</h2>
    ${bar("Protein", totals.protein_g, goals?.daily_protein_g ?? null, "g", false)}
    ${bar("Carbs", totals.carbs_g, goals?.daily_carbs_g ?? null, "g", false)}
    ${bar("Fat", totals.fat_g, goals?.daily_fat_g ?? null, "g", false)}
  </div>

  <div class="card">
    <div class="stat-grid">
      ${stat("Sugar", totals.sugar_g, goals?.daily_sugar_g ?? null, "g", true)}
      ${stat("Alcohol", totals.alcohol_g, goals?.daily_alcohol_g ?? null, "g", true, drinksNote)}
      ${stat("Caffeine", totals.caffeine_mg, goals?.daily_caffeine_mg ?? null, "mg", true)}
      ${stat("Fiber", totals.fiber_g, goals?.daily_fiber_g ?? null, "g", false)}
    </div>
  </div>

  ${weightRow ? `<div class="card"><h2>Weight</h2>${weightRow}</div>` : ""}

  <div class="card">
    <h2>Today's meals</h2>
    ${mealRows}
  </div>

  <div class="refresh"><a href="/dashboard?token=${encodeURIComponent(token)}">Refresh</a> · auto-updates every 90s</div>
</body>
</html>`;
}
