const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const { getConnection } = require("./database");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");

const db = getConnection();
const ALLOWED_ROLES = new Set(["admin", "manager", "staff", "viewer", "client"]);
const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_SET = new Set(WEEKDAY_ORDER);

function normalizeWorkingDays(inputDays) {
    const days = Array.isArray(inputDays)
        ? inputDays
        : (inputDays ? [inputDays] : []);

    const uniqueDays = WEEKDAY_ORDER.filter((d) => days.includes(d));
    return uniqueDays;
}

function parseWorkingDaysCsv(value) {
    if (!value) return ["Mon", "Tue", "Wed", "Thu", "Fri"];

    return String(value)
        .split(",")
        .map((v) => v.trim())
        .filter((d) => WEEKDAY_SET.has(d));
}

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

function csvEscape(value) {
    const str = value === null || value === undefined ? "" : String(value);
    if (str.includes(",") || str.includes("\n") || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function buildCsv(headers, rows) {
    const headerLine = headers.map(csvEscape).join(",");
    const lines = rows.map(row => row.map(csvEscape).join(","));
    return [headerLine, ...lines].join("\n");
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
router.get("/overrides", requireLogin, requireRole("admin", "manager"), async (req, res) => {
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

router.post("/overrides/request", requireLogin, requireRole("admin", "manager"), async (req, res) => {
    const bookingId = req.body.booking_id;
    const reason = req.body.reason || "Override requested";
    const actorRole = String(req.session?.user?.role || "").toLowerCase();

    if (!bookingId) {
        return res.redirect("/admin/overrides?error=Booking ID is required");
    }

    try {
        const bookingResult = await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId]);
        if (bookingResult.rows.length === 0) {
            return res.redirect("/admin/overrides?error=Booking not found");
        }

        if (actorRole === "admin") {
            await db.query(`
                INSERT INTO override_requests (booking_id, requested_by, status, reason, conflicts_json, approved_by, resolved_at)
                VALUES ($1, $2, 'approved', $3, $4, $2, NOW())
            `, [bookingId, req.session.user.id, reason, JSON.stringify({ source: "admin-instant-override" })]);

            await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["override-approved", bookingId]);
            await logAuditEvent(req.session.user.id, "override_approved_instant", { booking_id: bookingId, reason }, req.ip);
            return res.redirect("/admin/overrides?message=Override applied instantly");
        }

        await db.query(`
            INSERT INTO override_requests (booking_id, requested_by, status, reason, conflicts_json)
            VALUES ($1, $2, 'pending', $3, $4)
        `, [bookingId, req.session.user.id, reason, JSON.stringify({ source: "manager-request" })]);

        await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["override-pending", bookingId]);
        await logAuditEvent(req.session.user.id, "override_requested", { booking_id: bookingId, reason }, req.ip);

        const admins = await db.query("SELECT id FROM users WHERE role = 'admin'");
        await Promise.all(admins.rows.map(admin => createAdminNotification(
            admin.id,
            "override_request_pending",
            {
                booking_id: bookingId,
                requested_by: req.session.user.name,
                requested_by_email: req.session.user.email,
                reason,
                requested_at: new Date().toISOString()
            }
        )));

        return res.redirect("/admin/overrides?message=Override request submitted for admin approval");
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

router.get("/users/export.csv", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        const users = (await db.query(
            `SELECT id, name, email, role, is_active, locked_until, created_at
             FROM users
             ORDER BY id ASC`
        )).rows;

        const rows = users.map((u) => [
            u.id,
            u.name,
            u.email,
            u.role,
            u.is_active === false ? "deactivated" : "active",
            u.locked_until || "",
            u.created_at
        ]);

        const csv = buildCsv(
            ["id", "name", "email", "role", "status", "locked_until", "created_at"],
            rows
        );

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=admin-users.csv");
        return res.send(csv);
    } catch (err) {
        console.error("Admin users CSV export error:", err);
        return res.status(500).send("Failed to export users CSV");
    }
});

router.get("/users/export.pdf", requireLogin, requireRole("admin"), async (req, res) => {
    try {
        const users = (await db.query(
            `SELECT id, name, email, role, is_active, locked_until
             FROM users
             ORDER BY id ASC`
        )).rows;

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "attachment; filename=admin-users.pdf");

        const doc = new PDFDocument({ margin: 40, size: "A4" });
        doc.pipe(res);
        doc.fontSize(18).text("Admin Users Export", { underline: true });
        doc.moveDown(0.8);
        doc.fontSize(10).text("ID | Name | Email | Role | Status | Locked");
        doc.moveDown(0.4);

        users.forEach((u) => {
            const status = u.is_active === false ? "deactivated" : "active";
            const locked = u.locked_until ? "yes" : "no";
            doc.text(`${u.id} | ${u.name} | ${u.email} | ${u.role} | ${status} | ${locked}`);
        });

        return doc.end();
    } catch (err) {
        console.error("Admin users PDF export error:", err);
        return res.status(500).send("Failed to export users PDF");
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
    const weeklyCapacity = Number(req.body.weekly_capacity);
    const workingDays = normalizeWorkingDays(req.body.working_days);

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

    if (!Number.isFinite(weeklyCapacity) || weeklyCapacity <= 0) {
        return res.render("admin-add-user", {
            error: "Weekly capacity must be a positive number.",
            message: null,
            active_page: "admin_add_user"
        });
    }

    if (workingDays.length === 0) {
        return res.render("admin-add-user", {
            error: "Select at least one working day.",
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
            `INSERT INTO users (
                email,
                password_hash,
                role,
                name,
                weekly_capacity,
                working_days,
                failed_attempts,
                locked_until,
                mfa_enabled
            )
             VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, FALSE)
             RETURNING id, email, role, name`,
            [email, hash, role, name, weeklyCapacity, workingDays.join(",")]
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

router.get("/edit-user/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = Number(req.params.id);

    try {
        const result = await db.query(
            "SELECT id, name, email, role, weekly_capacity, working_days FROM users WHERE id = $1",
            [userId]
        );

        if (result.rows.length === 0) {
            return redirectUsers(res, null, "User not found");
        }

        const user = result.rows[0];
        user.selected_working_days = parseWorkingDaysCsv(user.working_days);

        return res.render("admin-edit-user", {
            user,
            error: null,
            message: null,
            active_page: "admin_users"
        });
    } catch (err) {
        console.error("Edit user page error:", err);
        return redirectUsers(res, null, "Failed to load user edit page");
    }
});

router.post("/edit-user/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = Number(req.params.id);
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const weeklyCapacity = Number(req.body.weekly_capacity);
    const workingDays = normalizeWorkingDays(req.body.working_days);

    if (!name || !email || !role) {
        return res.render("admin-edit-user", {
            user: {
                id: userId,
                name,
                email,
                role,
                weekly_capacity: req.body.weekly_capacity,
                selected_working_days: workingDays
            },
            error: "Name, email, and role are required.",
            message: null,
            active_page: "admin_users"
        });
    }

    if (!ALLOWED_ROLES.has(role)) {
        return res.render("admin-edit-user", {
            user: {
                id: userId,
                name,
                email,
                role,
                weekly_capacity: req.body.weekly_capacity,
                selected_working_days: workingDays
            },
            error: "Invalid role selected.",
            message: null,
            active_page: "admin_users"
        });
    }

    if (!Number.isFinite(weeklyCapacity) || weeklyCapacity <= 0) {
        return res.render("admin-edit-user", {
            user: {
                id: userId,
                name,
                email,
                role,
                weekly_capacity: req.body.weekly_capacity,
                selected_working_days: workingDays
            },
            error: "Weekly capacity must be a positive number.",
            message: null,
            active_page: "admin_users"
        });
    }

    if (workingDays.length === 0) {
        return res.render("admin-edit-user", {
            user: {
                id: userId,
                name,
                email,
                role,
                weekly_capacity: req.body.weekly_capacity,
                selected_working_days: workingDays
            },
            error: "Select at least one working day.",
            message: null,
            active_page: "admin_users"
        });
    }

    try {
        const existing = await db.query(
            "SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2",
            [email, userId]
        );

        if (existing.rows.length > 0) {
            return res.render("admin-edit-user", {
                user: {
                    id: userId,
                    name,
                    email,
                    role,
                    weekly_capacity: req.body.weekly_capacity,
                    selected_working_days: workingDays
                },
                error: "A user with that email already exists.",
                message: null,
                active_page: "admin_users"
            });
        }

        if (password) {
            if (!hasStrongPassword(password)) {
                return res.render("admin-edit-user", {
                    user: {
                        id: userId,
                        name,
                        email,
                        role,
                        weekly_capacity: req.body.weekly_capacity,
                        selected_working_days: workingDays
                    },
                    error: passwordPolicyMessage(),
                    message: null,
                    active_page: "admin_users"
                });
            }

            const hash = await bcrypt.hash(password, 10);
            await db.query(
                `UPDATE users
                 SET name = $1,
                     email = $2,
                     role = $3,
                     weekly_capacity = $4,
                     working_days = $5,
                     password_hash = $6,
                     updated_at = NOW()
                 WHERE id = $7`,
                [name, email, role, weeklyCapacity, workingDays.join(","), hash, userId]
            );
        } else {
            await db.query(
                `UPDATE users
                 SET name = $1,
                     email = $2,
                     role = $3,
                     weekly_capacity = $4,
                     working_days = $5,
                     updated_at = NOW()
                 WHERE id = $6`,
                [name, email, role, weeklyCapacity, workingDays.join(","), userId]
            );
        }

        await logAuditEvent(req.session.user.id, "user_updated", {
            user_id: userId,
            role,
            weekly_capacity: weeklyCapacity,
            working_days: workingDays
        }, req.ip);

        return redirectUsers(res, "User details updated", null);
    } catch (err) {
        console.error("Edit user error:", err);
        return res.render("admin-edit-user", {
            user: {
                id: userId,
                name,
                email,
                role,
                weekly_capacity: req.body.weekly_capacity,
                selected_working_days: workingDays
            },
            error: "Failed to update user.",
            message: null,
            active_page: "admin_users"
        });
    }
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

router.post("/deactivate-user/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = Number(req.params.id);

    if (userId === Number(req.session.user.id)) {
        return redirectUsers(res, null, "You cannot deactivate your own account");
    }

    try {
        const userResult = await db.query("SELECT id, email, is_active FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0) {
            return redirectUsers(res, null, "User not found");
        }

        await db.query(
            "UPDATE users SET is_active = FALSE, deactivated_at = NOW(), locked_until = NOW(), failed_attempts = 0 WHERE id = $1",
            [userId]
        );

        await logAuditEvent(req.session.user.id, "user_deactivated", { user_id: userId }, req.ip);
        return redirectUsers(res, "User deactivated", null);
    } catch (err) {
        console.error("Deactivate user error:", err);
        return redirectUsers(res, null, "Failed to deactivate user");
    }
});

router.post("/reactivate-user/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const userId = Number(req.params.id);

    try {
        const userResult = await db.query("SELECT id FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0) {
            return redirectUsers(res, null, "User not found");
        }

        await db.query(
            "UPDATE users SET is_active = TRUE, deactivated_at = NULL, locked_until = NULL, failed_attempts = 0 WHERE id = $1",
            [userId]
        );

        await logAuditEvent(req.session.user.id, "user_reactivated", { user_id: userId }, req.ip);
        return redirectUsers(res, "User reactivated", null);
    } catch (err) {
        console.error("Reactivate user error:", err);
        return redirectUsers(res, null, "Failed to reactivate user");
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
