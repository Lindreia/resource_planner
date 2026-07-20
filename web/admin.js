const express = require("express");
const router = express.Router();
const { requireLogin } = require("./authMiddleware");
const { requireRole } = require("./authRole");
const { getConnection } = require("../database");

const db = getConnection();

// -----------------------------------------
// ADMIN DASHBOARD
// -----------------------------------------
router.get("/dashboard", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        const userStats = await db.query(`
            SELECT
                COUNT(*) AS total_users,
                COUNT(*) FILTER (WHERE locked_until IS NOT NULL AND locked_until > NOW()) AS locked_users,
                COUNT(*) FILTER (WHERE role = 'admin') AS admin_count,
                COUNT(*) FILTER (WHERE role = 'manager') AS manager_count
            FROM users;
        `);

        const projectStats = await db.query(`
            SELECT
                COUNT(*) AS total_projects,
                COUNT(*) FILTER (
                    WHERE id IN (SELECT DISTINCT project_id FROM assignments)
                ) AS active_projects
            FROM projects;
        `);

        const assignmentStats = await db.query(`
            SELECT
                COUNT(*) AS total_assignments,
                COUNT(*) FILTER (
                    WHERE start_date <= CURRENT_DATE
                    AND end_date >= CURRENT_DATE
                ) AS active_assignments
            FROM assignments;
        `);

        const recentUsers = await db.query(`
            SELECT id, name, email, role
            FROM users
            ORDER BY id DESC
            LIMIT 5;
        `);

        const lockedList = await db.query(`
            SELECT id, name, email, locked_until
            FROM users
            WHERE locked_until IS NOT NULL
              AND locked_until > NOW()
            ORDER BY locked_until DESC;
        `);

        res.render("admin-dashboard", {
            user: req.session.user,
            noSidebar: true,
            stats: {
                totalUsers: userStats.rows[0].total_users,
                lockedUsers: userStats.rows[0].locked_users,
                adminCount: userStats.rows[0].admin_count,
                managerCount: userStats.rows[0].manager_count,
                totalProjects: projectStats.rows[0].total_projects,
                activeProjects: projectStats.rows[0].active_projects,
                totalAssignments: assignmentStats.rows[0].total_assignments,
                activeAssignments: assignmentStats.rows[0].active_assignments
            },
            recentUsers: recentUsers.rows,
            lockedList: lockedList.rows,
            message: null,
            error: null
        });

    } catch (err) {
        console.error("Admin dashboard error:", err);
        res.status(500).send("Server error loading admin dashboard");
    }
});


