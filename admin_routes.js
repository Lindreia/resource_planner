const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getConnection } = require("./database");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");

const db = getConnection();
const ALLOWED_ROLES = new Set(["admin", "manager", "staff"]);

function hasStrongPassword(password) {
    if (!password || password.length < 12) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    if (!/[^A-Za-z0-9]/.test(password)) return false;
    return true;
}

function passwordPolicyMessage() {
    return "Password must be at least 12 characters and include uppercase, lowercase, number, and special character.";
}

function redirectUsers(res, message, error) {
    const params = new URLSearchParams();
    if (message) params.set("message", message);
    if (error) params.set("error", error);
    const query = params.toString();
    return res.redirect(`/admin/users${query ? `?${query}` : ""}`);
}

function logAuditEvent(userId, eventType, details, ip) {
    return db.query(
        "INSERT INTO audit_logs (user_id, event_type, details, ip) VALUES ($1, $2, $3, $4)",
        [userId, eventType, JSON.stringify(details || {}), ip]
    );
}

// ---------------------------------------------------------
// ADMIN DASHBOARD
// ---------------------------------------------------------
router.get("/dashboard", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        // ============================
        // TOP-LEVEL STATS
        // ============================
        const statsResult = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM users) AS totalUsers,
                (SELECT COUNT(*) FROM users WHERE locked_until IS NOT NULL) AS lockedUsers,
                (SELECT COUNT(*) FROM users WHERE role = 'admin') AS adminCount,
                (SELECT COUNT(*) FROM users WHERE role = 'manager') AS managerCount,
                (SELECT COUNT(*) FROM projects) AS totalProjects,
                (SELECT COUNT(*) FROM projects) AS activeProjects,
                (SELECT COUNT(*) FROM assignments) AS totalAssignments,
                (SELECT COUNT(*) FROM assignments) AS activeAssignments
        `);

        const stats = statsResult.rows[0];

        // ============================
        // SYSTEM ALERTS
        // ============================
        const overdueAssignments = await db.query(
            "SELECT * FROM assignments WHERE end_date IS NOT NULL AND end_date < CURRENT_DATE"
        );

        const overCapacity = await db.query(`
            SELECT u.id, u.name, u.email, u.weekly_capacity,
                   (SELECT COALESCE(SUM(hours_per_week), 0) FROM assignments WHERE user_id = u.id) AS allocated
            FROM users u
            WHERE (SELECT COALESCE(SUM(hours_per_week), 0) FROM assignments WHERE user_id = u.id) > u.weekly_capacity
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

        // ============================
        // RECENT USERS
        // ============================
        const recentUsers = await db.query(
            "SELECT name, email, role FROM users ORDER BY id DESC LIMIT 5"
        );

        // ============================
        // LOCKED ACCOUNTS
        // ============================
        const lockedList = await db.query(
            "SELECT * FROM users WHERE locked_until IS NOT NULL ORDER BY locked_until DESC"
        );

        // ============================
        // ADMIN NOTIFICATIONS
        // ============================
        const notifications = await db.query(`
            SELECT n.*, u.name AS user_name
            FROM notifications n
            LEFT JOIN users u ON u.id = n.user_id
            WHERE n.read_at IS NULL
            ORDER BY n.created_at DESC
            LIMIT 10
        `);

        // ============================
        // ASSIGNMENT TREND (MONTHLY)
        // ============================
        const assignmentTrend = await db.query(`
            SELECT TO_CHAR(created_at, 'YYYY-MM') AS month,
                   COUNT(*) AS count
            FROM assignments
            GROUP BY month
            ORDER BY month
        `);

        // ============================
        // USER ACTIVITY TIMELINE
        // ============================
        const userActivity = await db.query(`
            SELECT TO_CHAR(updated_at, 'YYYY-MM-DD') AS date,
                   COUNT(*) AS count
            FROM users
            WHERE updated_at IS NOT NULL
            GROUP BY date
            ORDER BY date
        `);

        // ============================
        // RENDER ADMIN DASHBOARD
        // ============================
        res.render("admin-dashboard", {
            stats,
            alerts,
            recentUsers: recentUsers.rows,
            lockedList: lockedList.rows,
            notifications: notifications.rows,
            assignmentTrend: assignmentTrend.rows,
            userActivity: userActivity.rows,
            active_page: "admin_dashboard",
            message: null,
            error: null
        });

    } catch (err) {
        console.error("Admin dashboard error:", err);
        res.status(500).send("Failed to load admin dashboard");
    }
});

router.post("/notifications/:id/read", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        await db.query(
            "UPDATE notifications SET read_at = NOW() WHERE id = $1 AND read_at IS NULL",
            [req.params.id]
        );
        res.redirect("/admin/dashboard");
    } catch (err) {
        console.error("Mark notification read error:", err);
        res.redirect("/admin/dashboard?error=Failed to update notification");
    }
});

router.post("/notifications/read-all", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        await db.query(
            "UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL",
            [req.session.user.id]
        );
        res.redirect("/admin/dashboard");
    } catch (err) {
        console.error("Mark all notifications read error:", err);
        res.redirect("/admin/dashboard?error=Failed to update notifications");
    }
});

// ---------------------------------------------------------
// OVERRIDE WORKFLOW
// ---------------------------------------------------------
router.get("/overrides", requireLogin, requireRole("admin", "manager", "staff"), async (req, res) => {
    try {
        const result = await db.query(`
            SELECT orq.*, b.date, b.hours, b.status AS booking_status,
                   u.name AS requested_by_name,
                   p.project_name,
                   a.name AS approved_by_name
            FROM override_requests orq
            LEFT JOIN bookings b ON b.id = orq.booking_id
            LEFT JOIN users u ON u.id = orq.requested_by
            LEFT JOIN projects p ON p.id = b.project_id
            LEFT JOIN users a ON a.id = orq.approved_by
            ORDER BY orq.created_at DESC
        `);

        res.render("admin-overrides", {
            requests: result.rows,
            message: req.query.message || null,
            error: req.query.error || null,
            isAdmin: req.session.user.role === "admin"
        });
    } catch (err) {
        console.error("Override list error:", err);
        res.status(500).send("Failed to load override requests");
    }
});

router.post("/overrides/request", requireLogin, requireRole("admin", "manager", "staff"), async (req, res) => {
    const bookingId = req.body.booking_id;
    const reason = req.body.reason || "Override requested";

    if (!bookingId) {
        return res.redirect("/admin/overrides?error=Booking ID is required");
    }

    try {
        const bookingResult = await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId]);
        if (bookingResult.rows.length === 0) {
            return res.redirect("/admin/overrides?error=Booking not found");
        }

        await db.query(`
            INSERT INTO override_requests (booking_id, requested_by, status, reason, conflicts_json)
            VALUES ($1, $2, 'pending', $3, $4)
        `, [bookingId, req.session.user.id, reason, JSON.stringify({ source: "manual-request" })]);

        await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["override-pending", bookingId]);
        await logAuditEvent(req.session.user.id, "override_requested", { booking_id: bookingId, reason }, req.ip);

        res.redirect("/admin/overrides?message=Override request submitted");
    } catch (err) {
        console.error("Override request error:", err);
        res.redirect("/admin/overrides?error=Failed to submit override request");
    }
});

async function createAdminNotification(userId, type, payload) {
    return db.query(
        "INSERT INTO notifications (user_id, type, payload, created_at) VALUES ($1, $2, $3, NOW())",
        [userId, type, JSON.stringify(payload)]
    );
}

router.post("/overrides/:id/approve", requireLogin, requireRole("admin"), async (req, res) => {
    const requestId = req.params.id;

    try {
        await db.query(`
            UPDATE override_requests
            SET status = 'approved', approved_by = $1, resolved_at = NOW()
            WHERE id = $2
        `, [req.session.user.id, requestId]);

        const requestResult = await db.query("SELECT booking_id FROM override_requests WHERE id = $1", [requestId]);
        if (requestResult.rows[0]?.booking_id) {
            await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["override-approved", requestResult.rows[0].booking_id]);
        }

        await logAuditEvent(req.session.user.id, "override_approved", { request_id: requestId }, req.ip);
        res.redirect("/admin/overrides?message=Override approved");
    } catch (err) {
        console.error("Override approval error:", err);
        res.redirect("/admin/overrides?error=Failed to approve override");
    }
});

router.post("/overrides/:id/reject", requireLogin, requireRole("admin"), async (req, res) => {
    const requestId = req.params.id;

    try {
        await db.query(`
            UPDATE override_requests
            SET status = 'rejected', approved_by = $1, resolved_at = NOW()
            WHERE id = $2
        `, [req.session.user.id, requestId]);

        const requestResult = await db.query("SELECT booking_id FROM override_requests WHERE id = $1", [requestId]);
        if (requestResult.rows[0]?.booking_id) {
            await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["override-rejected", requestResult.rows[0].booking_id]);
        }

        await logAuditEvent(req.session.user.id, "override_rejected", { request_id: requestId }, req.ip);
        res.redirect("/admin/overrides?message=Override rejected");
    } catch (err) {
        console.error("Override rejection error:", err);
        res.redirect("/admin/overrides?error=Failed to reject override");
    }
});

router.post("/overrides/unauthorized", requireLogin, async (req, res) => {
    const { booking_id, reason } = req.body;
    const actor = req.session?.user;

    try {
        const admins = await db.query("SELECT id FROM users WHERE role = 'admin'");

        await logAuditEvent(actor?.id || null, "override_unauthorized_attempt", {
            booking_id: booking_id || null,
            reason: reason || "No reason provided",
            actor_name: actor?.name || "Unknown"
        }, req.ip);

        await Promise.all(admins.rows.map(admin => createAdminNotification(
            admin.id,
            "unauthorized_override_attempt",
            {
                actor_name: actor?.name || "Unknown",
                actor_email: actor?.email || null,
                booking_id: booking_id || null,
                reason: reason || "No reason provided",
                attempted_at: new Date().toISOString()
            }
        )));

        res.status(403).json({ message: "Override denied. Admin alert created." });
    } catch (err) {
        console.error("Unauthorized override alert error:", err);
        res.status(500).json({ message: "Failed to create alert" });
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

router.post("/unlock/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = req.params.id;

    try {
        await db.query(
            "UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE id = $1",
            [userId]
        );

        await logAuditEvent(req.session.user.id, "user_unlocked", { user_id: userId }, req.ip);
        return redirectUsers(res, "Account unlocked", null);
    } catch (err) {
        console.error("Unlock error:", err);
        return redirectUsers(res, null, "Failed to unlock account");
    }
});

// ---------------------------------------------------------
// MANAGE USERS PAGE
// ---------------------------------------------------------
router.get("/users", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        const users = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin-users", {
            users: users.rows,
            active_page: "admin_users",
            message: req.query.message || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error("User list error:", err);
        res.status(500).send("Failed to load users");
    }
});

// ---------------------------------------------------------
// ADD USER PAGE
// ---------------------------------------------------------
router.get("/users/add", requireLogin, requireRole("admin"), (req, res) => {
    res.render("admin-add-user", { error: null, message: null, active_page: "admin_add_user" });
});

router.post("/add-user", requireLogin, requireRole("admin"), async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const role = String(req.body.role || "").trim().toLowerCase();

    if (!name || !email || !password || !role) {
        return res.render("admin-add-user", {
            error: "All fields are required.",
            message: null,
            active_page: "admin_add_user"
        });
    }

    if (!ALLOWED_ROLES.has(role)) {
        return res.render("admin-add-user", {
            error: "Invalid role selected.",
            message: null,
            active_page: "admin_add_user"
        });
    }

    if (!hasStrongPassword(password)) {
        return res.render("admin-add-user", {
            error: passwordPolicyMessage(),
            message: null,
            active_page: "admin_add_user"
        });
    }

    try {
        const existing = await db.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
        if (existing.rows.length > 0) {
            return res.render("admin-add-user", {
                error: "A user with that email already exists.",
                message: null,
                active_page: "admin_add_user"
            });
        }

        const hash = await bcrypt.hash(password, 10);
        const inserted = await db.query(
            `INSERT INTO users (email, password_hash, role, name, failed_attempts, locked_until, mfa_enabled)
             VALUES ($1, $2, $3, $4, 0, NULL, FALSE)
             RETURNING id, email, role, name`,
            [email, hash, role, name]
        );

        await logAuditEvent(req.session.user.id, "user_created", {
            user_id: inserted.rows[0].id,
            email: inserted.rows[0].email,
            role: inserted.rows[0].role
        }, req.ip);

        return redirectUsers(res, `User ${inserted.rows[0].name} created successfully`, null);
    } catch (err) {
        console.error("Add user error:", err);
        return res.render("admin-add-user", {
            error: "Failed to create user.",
            message: null,
            active_page: "admin_add_user"
        });
    }
});

router.post("/users/add", requireLogin, requireRole("admin"), async (req, res) => {
    req.url = "/add-user";
    return router.handle(req, res);
});

router.post("/change-role/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = req.params.id;
    const role = String(req.body.role || "").trim().toLowerCase();

    if (!ALLOWED_ROLES.has(role)) {
        return redirectUsers(res, null, "Invalid role selected");
    }

    try {
        await db.query("UPDATE users SET role = $1 WHERE id = $2", [role, userId]);
        await logAuditEvent(req.session.user.id, "user_role_changed", { user_id: userId, role }, req.ip);
        return redirectUsers(res, "User role updated", null);
    } catch (err) {
        console.error("Change role error:", err);
        return redirectUsers(res, null, "Failed to update role");
    }
});

router.post("/reset-password/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = req.params.id;
    const temporaryPassword = `Tmp${crypto.randomBytes(6).toString("base64").replace(/[^A-Za-z0-9]/g, "A")}!9`;

    try {
        const userResult = await db.query("SELECT email FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0) {
            return redirectUsers(res, null, "User not found");
        }

        const hash = await bcrypt.hash(temporaryPassword, 10);
        await db.query(
            "UPDATE users SET password_hash = $1, failed_attempts = 0, locked_until = NULL WHERE id = $2",
            [hash, userId]
        );

        await logAuditEvent(req.session.user.id, "password_reset_admin", { user_id: userId }, req.ip);
        return redirectUsers(res, `Temporary password for ${userResult.rows[0].email}: ${temporaryPassword}`, null);
    } catch (err) {
        console.error("Reset password error:", err);
        return redirectUsers(res, null, "Failed to reset password");
    }
});

module.exports = router;
