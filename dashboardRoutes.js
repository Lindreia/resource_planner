const express = require("express");
const router = express.Router();

const { getWeeklyDashboard } = require("./weeklyDashboard");
const { getDailyDashboard } = require("./dailyDashboard");
const { getMonthlyDashboard } = require("./monthlyDashboard");

// Helper: get Monday of current week
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sunday
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
}

// -----------------------------------------
// WEEKLY DASHBOARD
// -----------------------------------------
router.get("/weekly", async (req, res) => {
    try {
        const today = new Date();
        const weekStart = getWeekStart(today);

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        const result = await getWeeklyDashboard(
            weekStart.toISOString().slice(0, 10),
            weekEnd.toISOString().slice(0, 10)
        );

        res.json({
            week_labels: result.team.map(m => m.name),
            utilization: result.team.map(m => m.util),
            stats_cards: result.statsCards,
            team: result.team,
            projects: result.projects
        });

    } catch (err) {
        console.error("Weekly dashboard error:", err);
        res.status(500).json({ error: "Failed to load weekly dashboard" });
    }
});

// -----------------------------------------
// MONTHLY DASHBOARD
// -----------------------------------------
router.get("/monthly", async (req, res) => {
    try {
        const today = new Date();
        const weekStart = getWeekStart(today);

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        const result = await getMonthlyDashboard(
            weekStart.toISOString().slice(0, 10),
            weekEnd.toISOString().slice(0, 10)
        );

        res.json({
            weeks: result.weeks,
            monthly: result.monthly,
            legend: result.legend
        });

    } catch (err) {
        console.error("Monthly dashboard error:", err);
        res.status(500).json({ error: "Failed to load monthly dashboard" });
    }
});

// -----------------------------------------
// DAILY DASHBOARD
// -----------------------------------------
router.get("/daily", async (req, res) => {
    try {
        const today = new Date();
        const weekStart = getWeekStart(today);

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        const result = await getDailyDashboard(today.toISOString().slice(0, 10));

        res.json({
            days: result.days,
            daily: result.daily,
            week_label: result.week_label,
            week_start: {
                prev: new Date(weekStart.getTime() - 7 * 86400000),
                next: new Date(weekStart.getTime() + 7 * 86400000)
            }
        });

    } catch (err) {
        console.error("Daily dashboard error:", err);
        res.status(500).json({ error: "Failed to load daily dashboard" });
    }
});

module.exports = router;
