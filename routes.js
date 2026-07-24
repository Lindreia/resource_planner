const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");
const bcrypt = require("bcryptjs");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");

const db = getConnection();

const WEEKDAY_TO_INDEX = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
};

function parseWorkingDays(value) {
    if (!value) return [1, 2, 3, 4, 5];

    return String(value)
        .split(",")
        .map((v) => v.trim())
        .map((name) => WEEKDAY_TO_INDEX[name])
        .filter((day, idx, arr) => Number.isInteger(day) && arr.indexOf(day) === idx)
        .sort((a, b) => a - b);
}

function toDayStart(dateLike) {
    const d = new Date(dateLike);
    d.setHours(0, 0, 0, 0);
    return d;
}

function toIsoDate(dateLike) {
    return toDayStart(dateLike).toISOString().slice(0, 10);
}

function assignmentDailyHours(row) {
    const explicitDaily = Number(row.hours_per_day);
    if (Number.isFinite(explicitDaily) && explicitDaily > 0) {
        return explicitDaily;
    }

    const weekly = Number(row.hours_per_week) || 0;
    const workDays = Math.max(Number(row.work_days) || 0, 1);
    return weekly > 0 ? weekly / workDays : 0;
}

function assignmentHoursForPeriod(row, periodStart, periodEnd, workingDays) {
    const start = toDayStart(row.start_date);
    const assignmentEnd = row.end_date ? toDayStart(row.end_date) : toDayStart(periodEnd);
    const overlapStart = start > toDayStart(periodStart) ? start : toDayStart(periodStart);
    const overlapEnd = assignmentEnd < toDayStart(periodEnd) ? assignmentEnd : toDayStart(periodEnd);

    if (overlapEnd < overlapStart) return 0;

    const daySet = new Set(workingDays);
    let dayCount = 0;
    for (let d = new Date(overlapStart); d <= overlapEnd; d.setDate(d.getDate() + 1)) {
        const jsDay = d.getDay();
        const isoDay = jsDay === 0 ? 7 : jsDay;
        if (daySet.has(isoDay)) {
            dayCount += 1;
        }
    }

    return assignmentDailyHours(row) * dayCount;
}

// -----------------------------------------
// PAGE ROUTES (EJS templates)
// -----------------------------------------
router.get("/", requireLogin, (req, res) => {
    res.render("weekly", { user: req.session.user });
});

router.get("/weekly", requireLogin, (req, res) => {
    return res.redirect("/dashboard");
});

router.get("/daily", requireLogin, async (req, res) => {
    try {
        const selected = req.query.date ? new Date(req.query.date) : new Date();
        const dayISO = toIsoDate(selected);

        const users = (await db.query(
            "SELECT id, name, working_days FROM users ORDER BY name"
        )).rows;

        const assignments = (await db.query(
            `SELECT a.user_id, a.start_date, a.end_date, a.work_days, a.hours_per_week, a.hours_per_day, a.start_time, a.end_time,
                    p.project_code, p.project_name, p.color
             FROM assignments a
             JOIN projects p ON p.id = a.project_id
             WHERE a.start_date <= $1
               AND (a.end_date IS NULL OR a.end_date >= $1)
             ORDER BY p.project_code`,
            [dayISO]
        )).rows;

        const byUser = users.map((u) => {
            const workingDays = parseWorkingDays(u.working_days);
            const rowItems = assignments
                .filter((a) => Number(a.user_id) === Number(u.id))
                .filter((a) => assignmentHoursForPeriod(a, selected, selected, workingDays) > 0)
                .map((a) => ({
                    project_code: a.project_code,
                    project_name: a.project_name,
                    color: a.color,
                    hours: Number(assignmentDailyHours(a).toFixed(2)),
                    time: a.start_time && a.end_time ? `${a.start_time}-${a.end_time}` : null
                }));

            const total = rowItems.reduce((sum, item) => sum + Number(item.hours || 0), 0);
            return {
                name: u.name,
                total: Number(total.toFixed(2)),
                items: rowItems
            };
        }).filter((row) => row.items.length > 0);

        res.render("daily", {
            user: req.session.user,
            selected_date: dayISO,
            previous_date: toIsoDate(new Date(selected.getTime() - 86400000)),
            next_date: toIsoDate(new Date(selected.getTime() + 86400000)),
            by_user: byUser
        });
    } catch (err) {
        console.error("Daily planner error:", err);
        res.status(500).send("Server error");
    }
});

router.get("/monthly", requireLogin, async (req, res) => {
    try {
        const now = new Date();
        const selected = req.query.start
            ? new Date(req.query.start)
            : new Date(now.getFullYear(), now.getMonth(), 1);

        const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
        const monthEnd = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
        const startISO = toIsoDate(monthStart);
        const endISO = toIsoDate(monthEnd);

        const users = (await db.query(
            "SELECT id, working_days FROM users"
        )).rows;

        const userWorkingDays = new Map();
        users.forEach((u) => {
            userWorkingDays.set(Number(u.id), parseWorkingDays(u.working_days));
        });

        const assignments = (await db.query(
            `SELECT a.user_id, a.start_date, a.end_date, a.work_days, a.hours_per_week, a.hours_per_day,
                    p.project_code, p.project_name, p.color
             FROM assignments a
             JOIN projects p ON p.id = a.project_id
             WHERE a.start_date <= $1
               AND (a.end_date IS NULL OR a.end_date >= $2)`,
            [endISO, startISO]
        )).rows;

        const summaryMap = new Map();
        assignments.forEach((a) => {
            const workingDays = userWorkingDays.get(Number(a.user_id)) || [1, 2, 3, 4, 5];
            const hours = assignmentHoursForPeriod(a, monthStart, monthEnd, workingDays);
            if (hours <= 0) return;

            if (!summaryMap.has(a.project_code)) {
                summaryMap.set(a.project_code, {
                    code: a.project_code,
                    name: a.project_name,
                    color: a.color,
                    hours: 0
                });
            }

            summaryMap.get(a.project_code).hours += hours;
        });

        const summary = Array.from(summaryMap.values())
            .map((p) => ({ ...p, hours: Number(p.hours.toFixed(2)) }))
            .sort((a, b) => a.code.localeCompare(b.code));

        const totalHours = summary.reduce((sum, p) => sum + p.hours, 0);

        const prev = toIsoDate(new Date(selected.getFullYear(), selected.getMonth() - 1, 1));
        const next = toIsoDate(new Date(selected.getFullYear(), selected.getMonth() + 1, 1));

        res.render("monthly", {
            user: req.session.user,
            month_label: monthStart.toLocaleDateString("en-NZ", { month: "long", year: "numeric" }),
            month_start: startISO,
            month_end: endISO,
            prev_start: prev,
            next_start: next,
            total_hours: Number(totalHours.toFixed(2)),
            summary
        });
    } catch (err) {
        console.error("Monthly planner error:", err);
        res.status(500).send("Server error");
    }
});

router.get("/resources", requireLogin, requireRole("admin", "manager"), (req, res) => {
    res.redirect("/assignments/add");
});

// -----------------------------------------
// LOGIN PAGE
// -----------------------------------------
router.get("/login", (req, res) => {
    res.render("login", { error: null });
});

// -----------------------------------------
// LOGIN SUBMIT (POSTGRES VERSION)
// -----------------------------------------
router.post("/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await db.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            return res.render("login", { error: "Invalid email or password" });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.render("login", { error: "Invalid email or password" });
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            role: user.role,
            email: user.email
        };

        res.redirect("/weekly");

    } catch (err) {
        console.error("Login error:", err);
        res.render("login", { error: "Server error" });
    }
});

// -----------------------------------------
// LOGOUT
// -----------------------------------------
router.get("/logout", requireLogin, (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

// -----------------------------------------
// DASHBOARD API (Admin + Manager + Staff)
// -----------------------------------------
router.get(
    "/dashboard",
    requireLogin,
    requireRole("admin", "manager", "staff"),
    async (req, res) => {
        try {
            const weekStartStr = req.query.start || "2026-05-19";
            const weekStart = new Date(weekStartStr);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6);

            const startISO = weekStart.toISOString().slice(0, 10);
            const endISO = weekEnd.toISOString().slice(0, 10);

            // -----------------------------------------
            // TEAM UTILISATION
            // -----------------------------------------
            const teamQuery = `
                SELECT 
                    u.name,
                    u.weekly_capacity,
                    COALESCE(SUM(COALESCE(a.hours_per_day * a.work_days, a.hours_per_week)), 0) AS allocated
                FROM users u
                LEFT JOIN assignments a
                    ON a.user_id = u.id
                   AND a.start_date <= $1
                   AND (a.end_date IS NULL OR a.end_date >= $2)
                GROUP BY u.name, u.weekly_capacity
                ORDER BY u.name;
            `;

            const teamResult = await db.query(teamQuery, [endISO, startISO]);

            const team = teamResult.rows.map(row => {
                const available = Math.max(row.weekly_capacity - row.allocated, 0);
                const util = row.weekly_capacity === 0
                    ? 0
                    : Math.round((row.allocated / row.weekly_capacity) * 100);

                return {
                    name: row.name,
                    capacity: row.weekly_capacity,
                    allocated: row.allocated,
                    available,
                    util
                };
            });

            // -----------------------------------------
            // PROJECT HOURS
            // -----------------------------------------
            const projectQuery = `
                SELECT 
                    p.project_code,
                    p.project_name,
                    COALESCE(SUM(a.hours_per_week), 0) AS total_hours
                FROM projects p
                LEFT JOIN assignments a
                    ON a.project_id = p.id
                   AND a.start_date <= $1
                   AND (a.end_date IS NULL OR a.end_date >= $2)
                GROUP BY p.project_code, p.project_name
                ORDER BY p.project_code;
            `;

            const projectResult = await db.query(projectQuery, [endISO, startISO]);

            const projects = projectResult.rows.map(row => ({
                code: row.project_code,
                name: row.project_name,
                hours: row.total_hours
            }));

            // -----------------------------------------
            // STATS
            // -----------------------------------------
            const totalCapacity = team.reduce((s, r) => s + r.capacity, 0);
            const totalAllocated = team.reduce((s, r) => s + r.allocated, 0);
            const totalAvailable = team.reduce((s, r) => s + r.available, 0);
            const overbookedCount = team.filter(r => r.allocated > r.capacity).length;

            const statsCards = [
                { label: "Team Members", value: team.length },
                { label: "Total Capacity", value: totalCapacity },
                { label: "Total Allocated", value: totalAllocated },
                { label: "Total Available", value: totalAvailable },
                { label: "Overbooked", value: overbookedCount, danger: overbookedCount > 0 }
            ];

            res.json({
                week_start: startISO,
                week_end: endISO,
                team,
                projects,
                stats_cards: statsCards
            });

        } catch (err) {
            console.error("Dashboard error:", err);
            res.status(500).json({ error: "Server error" });
        }
    }
);

module.exports = router;
