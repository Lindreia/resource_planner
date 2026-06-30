const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");
const bcrypt = require("bcryptjs");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");

const db = getConnection();

// -----------------------------------------
// PAGE ROUTES (EJS templates)
// -----------------------------------------
router.get("/", requireLogin, (req, res) => {
    // Reuse the full weekly data route so template vars are always populated.
    res.redirect("/weekly");
});

router.get("/weekly", requireLogin, async (req, res) => {
    try {
        const offset = Number(req.query.week_offset || 0);
        const today = new Date();
        const monday = new Date(today);
        monday.setDate(today.getDate() - today.getDay() + 1 + offset * 7);

        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const startISO = monday.toISOString().slice(0, 10);
        const endISO = sunday.toISOString().slice(0, 10);

        const teamQuery = `
            SELECT
                u.name,
                u.weekly_capacity,
                COALESCE(SUM(a.hours_per_week), 0) AS allocated
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

        const projectQuery = `
            SELECT
                p.project_code,
                p.project_name,
                COALESCE(SUM(a.hours_per_week), 0) AS total_hours,
                COUNT(DISTINCT a.user_id) AS members,
                p.color
            FROM projects p
            LEFT JOIN assignments a
                ON a.project_id = p.id
               AND a.start_date <= $1
               AND (a.end_date IS NULL OR a.end_date >= $2)
            GROUP BY p.project_code, p.project_name, p.color
            ORDER BY p.project_code;
        `;
        const projectResult = await db.query(projectQuery, [endISO, startISO]);

        const projects = projectResult.rows.map(row => ({
            code: row.project_code,
            name: row.project_name,
            hours: row.total_hours,
            members: row.members,
            color: row.color
        }));

        const totalCapacity = team.reduce((s, r) => s + Number(r.capacity), 0);
        const totalAllocated = team.reduce((s, r) => s + Number(r.allocated), 0);
        const totalAvailable = team.reduce((s, r) => s + Number(r.available), 0);
        const overbookedCount = team.filter(r => Number(r.allocated) > Number(r.capacity)).length;

        const stats_cards = [
            { label: "Team Members", value: team.length },
            { label: "Total Capacity", value: totalCapacity },
            { label: "Total Allocated", value: totalAllocated },
            { label: "Total Available", value: totalAvailable },
            { label: "Overbooked", value: overbookedCount }
        ];

        res.render("weekly", {
            user: req.session.user,
            week_label: `${startISO} -> ${endISO}`,
            prev_week: offset - 1,
            next_week: offset + 1,
            stats_cards,
            team,
            projects
        });
    } catch (err) {
        console.error("Weekly dashboard error:", err);
        res.status(500).send("Server error");
    }
});

router.get("/daily", requireLogin, async (req, res) => {
    try {
        const selected = req.query.date ? new Date(req.query.date) : new Date();
        const dayISO = selected.toISOString().slice(0, 10);

        const bookingsQuery = `
            SELECT u.name AS user_name, p.project_code, p.project_name, p.color, b.hours
            FROM bookings b
            JOIN users u ON u.id = b.user_id
            JOIN projects p ON p.id = b.project_id
            WHERE b.date = $1
            ORDER BY u.name, p.project_code;
        `;
        const bookingsResult = await db.query(bookingsQuery, [dayISO]);
        const bookings = bookingsResult.rows;

        const byUserMap = new Map();
        for (const b of bookings) {
            if (!byUserMap.has(b.user_name)) {
                byUserMap.set(b.user_name, { name: b.user_name, total: 0, items: [] });
            }
            const row = byUserMap.get(b.user_name);
            const hrs = Number(b.hours) || 0;
            row.total += hrs;
            row.items.push({
                project_code: b.project_code,
                project_name: b.project_name,
                color: b.color,
                hours: hrs
            });
        }

        res.render("daily", {
            user: req.session.user,
            selected_date: dayISO,
            previous_date: new Date(selected.getTime() - 86400000).toISOString().slice(0, 10),
            next_date: new Date(selected.getTime() + 86400000).toISOString().slice(0, 10),
            by_user: Array.from(byUserMap.values())
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

        const startISO = monthStart.toISOString().slice(0, 10);
        const endISO = monthEnd.toISOString().slice(0, 10);

        const monthQuery = `
            SELECT p.project_code, p.project_name, p.color, COALESCE(SUM(b.hours), 0) AS total_hours
            FROM projects p
            LEFT JOIN bookings b ON b.project_id = p.id AND b.date BETWEEN $1 AND $2
            GROUP BY p.project_code, p.project_name, p.color
            ORDER BY p.project_code;
        `;
        const monthResult = await db.query(monthQuery, [startISO, endISO]);

        const summary = monthResult.rows.map(r => ({
            code: r.project_code,
            name: r.project_name,
            color: r.color,
            hours: Number(r.total_hours) || 0
        }));

        const totalHours = summary.reduce((s, p) => s + p.hours, 0);

        const prev = new Date(selected.getFullYear(), selected.getMonth() - 1, 1).toISOString().slice(0, 10);
        const next = new Date(selected.getFullYear(), selected.getMonth() + 1, 1).toISOString().slice(0, 10);

        res.render("monthly", {
            user: req.session.user,
            month_label: monthStart.toLocaleDateString("en-NZ", { month: "long", year: "numeric" }),
            month_start: startISO,
            month_end: endISO,
            prev_start: prev,
            next_start: next,
            total_hours: totalHours,
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
                    COALESCE(SUM(a.hours_per_week), 0) AS allocated
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
