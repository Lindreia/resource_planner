const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./middleware/requireRole");

const db = getConnection();

// ---------------------------------------------------------
// ADMIN DASHBOARD
// ---------------------------------------------------------
router.get("/dashboard", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        const statsResult = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM users) AS totalUsers,
                (SELECT COUNT(*) FROM users WHERE locked_until IS NOT NULL) AS lockedUsers,
                (SELECT COUNT(*) FROM users WHERE role = 'admin') AS adminCount,
                (SELECT COUNT(*) FROM users WHERE role = 'manager') AS managerCount,
                (SELECT COUNT(*) FROM projects) AS totalProjects,
                (SELECT COUNT(*) FROM projects WHERE active = TRUE) AS activeProjects,
                (SELECT COUNT(*) FROM assignments) AS totalAssignments,
                (SELECT COUNT(*) FROM assignments WHERE status = 'active') AS activeAssignments
        `);

        const stats = statsResult.rows[0];

        const overdueAssignments = await db.query(
            "SELECT * FROM assignments WHERE due_date < NOW() AND status != 'completed'"
        );

        const overCapacity = await db.query(`
            SELECT u.*, u.capacity,
                   (SELECT COALESCE(SUM(hours),0) FROM assignments WHERE user_id = u.id) AS allocated
            FROM users u
            HAVING allocated > capacity
        `);

        const emptyProjects = await db.query(`
            SELECT p.* FROM projects p
            LEFT JOIN assignments a ON a.project_id = p.id
            WHERE a.id IS NULL
        `);

        const alerts = {
            overdueAssignments: overdueAssignments.rows,
            overCapacity: overCapacity.rows,
            emptyProjects: emptyProjects.rows
        };

        const recentUsers = await db.query(
            "SELECT name, email, role FROM users ORDER BY id DESC LIMIT 5"
        );

        const lockedList = await db.query(
            "SELECT * FROM users WHERE locked_until IS NOT NULL ORDER BY locked_until DESC"
        );

        const assignmentTrend = await db.query(`
            SELECT TO_CHAR(created_at, 'YYYY-MM') AS month,
                   COUNT(*) AS count
            FROM assignments
            GROUP BY month
            ORDER BY month
        `);

        res.render("admin_dashboard", {
            stats,
            alerts,
            recentUsers: recentUsers.rows,
            lockedList: lockedList.rows,
            assignmentTrend: assignmentTrend.rows,
            message: null,
            error: null
        });

    } catch (err) {
        console.error("Admin dashboard error:", err);
        res.status(500).send("Failed to load admin dashboard");
    }
});

// ---------------------------------------------------------
// UNLOCK USER ACCOUNT
// ---------------------------------------------------------
router.get("/unlock/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = req.params.id;

    try {
        await db.query(
            "UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE id = $1",
            [userId]
        );

        res.redirect("/admin/dashboard?message=Account unlocked");
    } catch (err) {
        console.error("Unlock error:", err);
        res.redirect("/admin/dashboard?error=Failed to unlock account");
    }
});

// ---------------------------------------------------------
// MANAGE USERS PAGE
// ---------------------------------------------------------
router.get("/users", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        const users = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", { users: users.rows });
    } catch (err) {
        console.error("User list error:", err);
        res.status(500).send("Failed to load users");
    }
});

// ---------------------------------------------------------
// ADD USER PAGE
// ---------------------------------------------------------
router.get("/users/add", requireLogin, requireRole("admin"), (req, res) => {
    res.render("admin_add_user", { error: null, message: null });
});

module.exports = router;
