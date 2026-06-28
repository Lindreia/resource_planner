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
    res.render("weekly", { user: req.session.user });
});

router.get("/weekly", requireLogin, (req, res) => {
    res.render("weekly", { user: req.session.user });
});

router.get("/daily", requireLogin, (req, res) => {
    res.render("daily", { user: req.session.user });
});

router.get("/monthly", requireLogin, (req, res) => {
    res.render("monthly", { user: req.session.user });
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
