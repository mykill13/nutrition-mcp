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
                }),
                { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0 },
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
    };
    goals: {
        daily_protein_g: number | null;
        daily_carbs_g: number | null;
        daily_fat_g: number | null;
        daily_fiber_g: number | null;
        daily_sugar_g: number | null;
    } | null;
    mealRows: string;
    weightRow: string;
    token: string;
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
    } = opts;

    const heroLabel = calGoal == null ? "Consumed today" : calRemaining! >= 0 ? "Calories remaining" : "Over today's goal";
    const heroValue = calGoal == null ? Math.round(calConsumed) : Math.abs(Math.round(calRemaining!));
    const heroOver = calGoal != null && calRemaining! < 0;

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
    background: #111417; color: #e8e8e8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .date { text-align: center; color: #8a8f98; font-size: 14px; margin-bottom: 18px; }
  .hero { text-align: center; margin-bottom: 28px; }
  .hero-value { font-size: 56px; font-weight: 700; line-height: 1; }
  .hero-value.over { color: #ff6b6b; }
  .hero-label { color: #8a8f98; font-size: 15px; margin-top: 6px; }
  .card {
    background: #1a1e23; border-radius: 14px; padding: 16px 18px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;
    color: #8a8f98; margin: 0 0 12px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; align-items: baseline;
    font-size: 15px; margin-top: 10px; }
  .row:first-of-type { margin-top: 0; }
  .row-label { color: #c7cad1; }
  .row-value { font-weight: 600; }
  .row-sub { font-size: 12px; color: #6f7480; margin-top: 2px; }
  .row-sub-inline { color: #6f7480; font-weight: 400; font-size: 13px; }
  .bar-track { height: 6px; background: #2a2f36; border-radius: 3px; margin-top: 6px; overflow: hidden; }
  .bar-fill { height: 100%; background: #4a90d9; border-radius: 3px; }
  .bar-fill.met { background: #4caf82; }
  .bar-fill.over { background: #e05a5a; }
  .meal { display: flex; align-items: baseline; gap: 10px; padding: 8px 0;
    border-top: 1px solid #262b32; font-size: 14px; }
  .meal:first-child { border-top: none; }
  .meal-time { color: #6f7480; width: 60px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .meal-desc { flex: 1; color: #d5d7dc; }
  .meal-kcal { color: #8a8f98; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .empty { color: #6f7480; font-size: 14px; }
  .refresh { display: block; text-align: center; margin-top: 20px; }
  .refresh a { color: #4a90d9; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
  <div class="date">${today}</div>
  <div class="hero">
    <div class="hero-value${heroOver ? " over" : ""}">${heroValue}</div>
    <div class="hero-label">${heroLabel}</div>
  </div>

  <div class="card">
    <h2>Macros</h2>
    ${bar("Protein", totals.protein_g, goals?.daily_protein_g ?? null, "g", false)}
    ${bar("Carbs", totals.carbs_g, goals?.daily_carbs_g ?? null, "g", false)}
    ${bar("Fat", totals.fat_g, goals?.daily_fat_g ?? null, "g", false)}
    ${bar("Fiber", totals.fiber_g, goals?.daily_fiber_g ?? null, "g", false)}
    ${bar("Sugar", totals.sugar_g, goals?.daily_sugar_g ?? null, "g", true)}
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
