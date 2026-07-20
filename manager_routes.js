const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");

const db = getConnection();

function buildManagerStats(teamCount, todayBookings, pendingApprovals, projectCount) {
    return {
        teamCount,
        todayBookings,
        pendingApprovals,
        projectCount
    };
}

router.get("/dashboard", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const teamCountResult = await db.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'staff'");
        const todayBookingsResult = await db.query("SELECT COUNT(*)::int AS count FROM bookings WHERE date = CURRENT_DATE");
        const pendingApprovalsResult = await db.query("SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'pending'");
        const projectCountResult = await db.query("SELECT COUNT(*)::int AS count FROM projects");

        const viewModel = {
            stats: buildManagerStats(
                teamCountResult.rows[0].count,
                todayBookingsResult.rows[0].count,
                pendingApprovalsResult.rows[0].count,
                projectCountResult.rows[0].count
            ),
            active_page: "manager_dashboard",
            message: req.query.message || null,
            error: req.query.error || null
        };

        const isAdmin = (req.session?.user?.role || "").toLowerCase() === "admin";
        if (isAdmin) {
            return res.render("manager-dashboard-admin", viewModel);
        }

        res.render("manager-dashboard", viewModel);
    } catch (err) {
        console.error("Manager dashboard error:", err);
        res.status(500).send("Failed to load manager dashboard");
    }
});

router.get("/team", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const team = (await db.query(
            "SELECT id, name, email, role FROM users WHERE role IN ('staff','manager','admin') ORDER BY name ASC"
        )).rows;

        res.render("manager-team", { team });
    } catch (err) {
        console.error("Manager team error:", err);
        res.status(500).send("Failed to load team page");
    }
});

router.get("/team/:id", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const memberResult = await db.query(
            "SELECT id, name, email, role, locked_until FROM users WHERE id = $1",
            [req.params.id]
        );

        if (memberResult.rows.length === 0) {
            return res.status(404).send("Team member not found");
        }

        const member = memberResult.rows[0];

        const availability = (await db.query(
            `SELECT a.start_date AS date, p.project_code, p.project_name, a.hours_per_week
             FROM assignments a
             JOIN projects p ON p.id = a.project_id
             WHERE a.user_id = $1
             ORDER BY a.start_date DESC`,
            [member.id]
        )).rows.map(row => ({
            date: row.date,
            status: `${row.project_code} - ${row.project_name} (${row.hours_per_week}h/wk)`
        }));

        const bookings = (await db.query(
            `SELECT b.id, b.date, b.hours, b.status, p.project_name
             FROM bookings b
             JOIN projects p ON p.id = b.project_id
             WHERE b.user_id = $1
             ORDER BY b.date DESC
             LIMIT 25`,
            [member.id]
        )).rows;

        res.render("manager-team-detail", {
            member,
            availability,
            bookings,
            error: null,
            message: null
        });
    } catch (err) {
        console.error("Manager team detail error:", err);
        res.status(500).send("Failed to load team member page");
    }
});

router.get("/projects", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const projects = (await db.query(
            `SELECT p.id, p.project_code, p.project_name,
                    COALESCE(SUM(a.hours_per_week), 0)::int AS total_hours,
                    COUNT(DISTINCT a.user_id)::int AS members
             FROM projects p
             LEFT JOIN assignments a ON a.project_id = p.id
             GROUP BY p.id, p.project_code, p.project_name
             ORDER BY p.project_code`
        )).rows;

        res.render("manager-projects", {
            projects,
            error: req.query.error || null,
            message: req.query.message || null
        });
    } catch (err) {
        console.error("Manager projects error:", err);
        res.status(500).send("Failed to load project list");
    }
});

router.get("/projects/add", requireLogin, requireRole("admin", "manager"), (req, res) => {
    res.render("manager-project-add", {
        form: {
            project_code: "",
            project_name: "",
            client: "",
            color: "#0b8a4a"
        },
        error: null
    });
});

router.post("/projects/add", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    const project_code = String(req.body.project_code || "").trim().toUpperCase();
    const project_name = String(req.body.project_name || "").trim();
    const client = String(req.body.client || "").trim();
    const color = String(req.body.color || "").trim() || "#0b8a4a";

    const form = {
        project_code,
        project_name,
        client,
        color
    };

    if (!project_code || !project_name) {
        return res.render("manager-project-add", {
            form,
            error: "Project code and project name are required."
        });
    }

    try {
        await db.query(
            `INSERT INTO projects (project_code, project_name, client, color)
             VALUES ($1, $2, $3, $4)`,
            [project_code, project_name, client || null, color]
        );

        const params = new URLSearchParams({ message: "Project created successfully." });
        return res.redirect(`/manager/projects?${params.toString()}`);
    } catch (err) {
        if (err && err.code === "23505") {
            return res.render("manager-project-add", {
                form,
                error: "Project code already exists. Use a unique code."
            });
        }

        console.error("Manager add project error:", err);
        return res.render("manager-project-add", {
            form,
            error: "Failed to create project. Please try again."
        });
    }
});

router.get("/projects/:id", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const projectResult = await db.query(
            "SELECT id, project_code, project_name, color FROM projects WHERE id = $1",
            [req.params.id]
        );

        if (projectResult.rows.length === 0) {
            return res.status(404).send("Project not found");
        }

        const projectRow = projectResult.rows[0];
        const totalHoursResult = await db.query(
            "SELECT COALESCE(SUM(hours_per_week), 0)::int AS total_hours FROM assignments WHERE project_id = $1",
            [projectRow.id]
        );

        const team = (await db.query(
            `SELECT u.name, u.email, u.role
             FROM assignments a
             JOIN users u ON u.id = a.user_id
             WHERE a.project_id = $1
             GROUP BY u.name, u.email, u.role
             ORDER BY u.name`,
            [projectRow.id]
        )).rows;

        const bookings = (await db.query(
            `SELECT b.id, b.date, b.hours, b.status, u.name AS user_name
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             WHERE b.project_id = $1
             ORDER BY b.date DESC
             LIMIT 25`,
            [projectRow.id]
        )).rows;

        res.render("manager-project-detail", {
            project: {
                name: projectRow.project_name,
                status: team.length > 0 ? "Active" : "No assignments",
                start_date: "N/A",
                end_date: "N/A",
                total_hours: totalHoursResult.rows[0].total_hours
            },
            team,
            tasks: [],
            bookings,
            timeline: [],
            error: null,
            message: null
        });
    } catch (err) {
        console.error("Manager project detail error:", err);
        res.status(500).send("Failed to load project detail page");
    }
});

router.get("/bookings", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const filters = {
            date: req.query.date || "",
            user_id: req.query.user_id || ""
        };

        let query = `
            SELECT b.id, b.date, b.hours, b.status,
                   u.id AS user_id, u.name AS user_name,
                   p.project_name
            FROM bookings b
            JOIN users u ON u.id = b.user_id
            JOIN projects p ON p.id = b.project_id
            WHERE 1 = 1
        `;
        const params = [];

        if (filters.date) {
            params.push(filters.date);
            query += ` AND b.date = $${params.length}`;
        }

        if (filters.user_id) {
            params.push(filters.user_id);
            query += ` AND b.user_id = $${params.length}`;
        }

        query += " ORDER BY b.date DESC, u.name ASC";

        const bookings = (await db.query(query, params)).rows;
        const team = (await db.query("SELECT id, name FROM users WHERE role = 'staff' ORDER BY name ASC")).rows;

        res.render("manager-bookings", {
            bookings,
            team,
            filters,
            message: req.query.message || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error("Manager bookings error:", err);
        res.status(500).send("Failed to load bookings page");
    }
});

router.get("/bookings/:id", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const bookingResult = await db.query(
            `SELECT b.id, b.date, b.hours, b.status, b.notes,
                    u.name AS user_name, p.project_name
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN projects p ON p.id = b.project_id
             WHERE b.id = $1`,
            [req.params.id]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).send("Booking not found");
        }

        res.render("manager-booking-detail", {
            booking: bookingResult.rows[0],
            message: req.query.message || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error("Manager booking detail error:", err);
        res.status(500).send("Failed to load booking detail page");
    }
});

router.post("/bookings/:id/update-hours", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        await db.query("UPDATE bookings SET hours = $1 WHERE id = $2", [req.body.hours, req.params.id]);
        res.redirect(`/manager/bookings/${req.params.id}?message=Hours updated`);
    } catch (err) {
        console.error("Update booking hours error:", err);
        res.redirect(`/manager/bookings/${req.params.id}?error=Failed to update hours`);
    }
});

router.post("/bookings/:id/notes", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        await db.query("UPDATE bookings SET notes = $1 WHERE id = $2", [req.body.notes || "", req.params.id]);
        res.redirect(`/manager/bookings/${req.params.id}?message=Notes saved`);
    } catch (err) {
        console.error("Update booking notes error:", err);
        res.redirect(`/manager/bookings/${req.params.id}?error=Failed to save notes`);
    }
});

router.post("/bookings/:id/approve", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        await db.query("UPDATE bookings SET status = 'approved' WHERE id = $1", [req.params.id]);
        res.redirect(`/manager/bookings/${req.params.id}?message=Booking approved`);
    } catch (err) {
        console.error("Approve booking error:", err);
        res.redirect(`/manager/bookings/${req.params.id}?error=Failed to approve booking`);
    }
});

router.post("/bookings/:id/reject", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        await db.query("UPDATE bookings SET status = 'rejected' WHERE id = $1", [req.params.id]);
        res.redirect(`/manager/bookings/${req.params.id}?message=Booking rejected`);
    } catch (err) {
        console.error("Reject booking error:", err);
        res.redirect(`/manager/bookings/${req.params.id}?error=Failed to reject booking`);
    }
});

router.get("/availability", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const availability = (await db.query(
            `SELECT u.name AS user_name, a.start_date AS date, p.project_code || ' - ' || p.project_name AS status
             FROM assignments a
             JOIN users u ON u.id = a.user_id
             JOIN projects p ON p.id = a.project_id
             ORDER BY u.name ASC, a.start_date DESC`
        )).rows;

        res.render("manager-availability", { availability });
    } catch (err) {
        console.error("Manager availability error:", err);
        res.status(500).send("Failed to load availability page");
    }
});

router.get("/approvals", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const requests = (await db.query(
            `SELECT b.id, b.date, b.hours,
                    u.name AS user_name,
                    p.project_name
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN projects p ON p.id = b.project_id
             WHERE b.status = 'pending'
             ORDER BY b.date DESC, u.name ASC`
        )).rows;

        res.render("manager-approvals", {
            requests,
            error: null,
            message: null
        });
    } catch (err) {
        console.error("Manager approvals error:", err);
        res.status(500).send("Failed to load approvals page");
    }
});

router.get("/allocation", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    try {
        const allocationsResult = await db.query(
            `SELECT u.id, u.name AS user_name, u.weekly_capacity AS capacity,
                    COALESCE(SUM(a.hours_per_week), 0)::int AS total_hours
             FROM users u
             LEFT JOIN assignments a ON a.user_id = u.id
             WHERE u.role = 'staff'
             GROUP BY u.id, u.name, u.weekly_capacity
             ORDER BY u.name ASC`
        );

        const projectsByUser = await db.query(
            `SELECT u.id AS user_id, p.project_name, a.hours_per_week AS hours
             FROM assignments a
             JOIN users u ON u.id = a.user_id
             JOIN projects p ON p.id = a.project_id
             WHERE u.role = 'staff'
             ORDER BY u.name ASC, p.project_name ASC`
        );

        const projectsMap = new Map();
        for (const row of projectsByUser.rows) {
            if (!projectsMap.has(row.user_id)) {
                projectsMap.set(row.user_id, []);
            }
            projectsMap.get(row.user_id).push({ project_name: row.project_name, hours: row.hours });
        }

        const allocations = allocationsResult.rows.map(row => ({
            user_name: row.user_name,
            total_hours: row.total_hours,
            capacity: row.capacity,
            projects: projectsMap.get(row.id) || []
        }));

        res.render("manager-allocation", {
            allocations,
            filters: { week: req.query.week || "" },
            error: null,
            message: null
        });
    } catch (err) {
        console.error("Manager allocation error:", err);
        res.status(500).send("Failed to load allocation page");
    }
});

module.exports = router;