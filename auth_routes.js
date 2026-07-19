const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { getConnection } = require("./database");
const { requireLogin } = require("./web/authMiddleware");

function logAuditEvent(userId, eventType, details, ip) {
    const db = getConnection();
    return db.query(
        "INSERT INTO audit_logs (user_id, event_type, details, ip) VALUES ($1, $2, $3, $4)",
        [userId, eventType, JSON.stringify(details || {}), ip]
    );
}

const router = express.Router();
const db = getConnection();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;
const MFA_EXPIRY_MINUTES = 10;
const MFA_MAX_ATTEMPTS = 5;

function debugAuthLog(message, payload) {
    if (process.env.DEBUG_AUTH === "true") {
        console.log(`[AUTH DEBUG] ${message}`, payload || {});
    }
}

function regenerateSession(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save((err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

function hasStrongPassword(password) {
    if (!password || password.length < 12) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    if (!/[^A-Za-z0-9]/.test(password)) return false;
    return true;
}

function getPasswordPolicyMessage() {
    return "Password must be at least 12 characters and include uppercase, lowercase, number, and special character.";
}

function getPostLoginRedirect(role) {
    const normalizedRole = String(role || "").trim().toLowerCase();

    if (normalizedRole === "admin") return "/admin/dashboard";
    if (normalizedRole === "manager") return "/manager/dashboard";

    // Default user landing page for non-admin roles.
    return "/weekly";
}

function requirePendingMfa(req, res, next) {
    if (!req.session || !req.session.pendingMfa) {
        debugAuthLog("verify-mfa redirect due to missing pendingMfa", {
            path: req.originalUrl,
            sessionID: req.sessionID,
            hasSession: Boolean(req.session),
            hasCookieHeader: Boolean(req.headers.cookie)
        });
        return res.redirect("/login");
    }

    next();
}

async function sendMfaCodeEmail(email, code) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log(`[MFA DEV] OTP for ${email}: ${code}`);
        return;
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    await transporter.sendMail({
        from: process.env.MFA_FROM_EMAIL || process.env.SMTP_USER,
        to: email,
        subject: "Your Resource Planner verification code",
        text: `Your verification code is ${code}. It expires in ${MFA_EXPIRY_MINUTES} minutes.`
    });
}

async function createMfaChallenge(userId, email) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + MFA_EXPIRY_MINUTES * 60 * 1000);

    await db.query(
        "UPDATE mfa_challenges SET used = TRUE WHERE user_id = $1 AND used = FALSE",
        [userId]
    );

    await db.query(
        "INSERT INTO mfa_challenges (user_id, code_hash, expires_at, attempts, used) VALUES ($1, $2, $3, 0, FALSE)",
        [userId, codeHash, expiresAt]
    );

    await sendMfaCodeEmail(email, code);
}

async function tryBootstrapLogin(email, password) {
    const bootstrapEmail = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
    const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD || "";
    const bootstrapName = String(process.env.ADMIN_BOOTSTRAP_NAME || "Administrator").trim() || "Administrator";

    if (!bootstrapEmail || !bootstrapPassword) return null;
    if (email !== bootstrapEmail || password !== bootstrapPassword) return null;

    const hash = await bcrypt.hash(bootstrapPassword, 10);

    await db.query(
        `INSERT INTO users (email, password_hash, role, name, failed_attempts, locked_until)
         VALUES ($1, $2, 'admin', $3, 0, NULL)
         ON CONFLICT (email)
         DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            role = 'admin',
            name = EXCLUDED.name,
            failed_attempts = 0,
            locked_until = NULL`,
        [bootstrapEmail, hash, bootstrapName]
    );

    const result = await db.query("SELECT * FROM users WHERE LOWER(email) = $1", [bootstrapEmail]);
    return result.rows[0] || null;
}

// ---------------------------------------------------------
// LOGIN PAGE
// ---------------------------------------------------------
router.get("/login", (req, res) => {
    res.render("login", {
        error: null,
        layout: false
    });
});

router.get("/verify-mfa", requirePendingMfa, (req, res) => {
    res.render("verify-mfa", { error: null, layout: false });
});


// ---------------------------------------------------------
// LOGIN SUBMIT (WITH ROLE REDIRECT)
// ---------------------------------------------------------
router.post("/login", async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    debugAuthLog("login attempt", { email: normalizedEmail, sessionID: req.sessionID });

    try {
        const result = await db.query(
            "SELECT * FROM users WHERE LOWER(email) = $1",
            [normalizedEmail]
        );

        let user = result.rows[0];

        if (!user) {
            user = await tryBootstrapLogin(normalizedEmail, String(password || ""));
        }

        if (!user) {
            await logAuditEvent(null, "login_failed", { email: normalizedEmail }, req.ip);
            debugAuthLog("login failed - no user", { email: normalizedEmail, sessionID: req.sessionID });
            return res.render("login", { error: "Invalid email or password", layout: false });
        }

        if (user.is_active === false) {
            await logAuditEvent(user.id, "login_inactive_account", { email: normalizedEmail }, req.ip);
            debugAuthLog("login blocked - inactive account", { userId: user.id, email: normalizedEmail, sessionID: req.sessionID });
            return res.render("login", { error: "Account is deactivated. Contact admin.", layout: false });
        }

        // Account lock check
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            await logAuditEvent(user.id, "login_locked", { email: normalizedEmail }, req.ip);
            debugAuthLog("login blocked - account locked", { userId: user.id, email: normalizedEmail, sessionID: req.sessionID });
            return res.render("login", { error: "Account locked. Contact admin.", layout: false });
        }

        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            const failed = user.failed_attempts + 1;
            let lockedUntil = null;

            if (failed >= MAX_FAILED_ATTEMPTS) {
                lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
            }

            await db.query(
                "UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3",
                [failed, lockedUntil, user.id]
            );

            await logAuditEvent(user.id, "login_failed", { email: normalizedEmail, failed_attempts: failed }, req.ip);
            debugAuthLog("login failed - bad password", { userId: user.id, email: normalizedEmail, failedAttempts: failed, sessionID: req.sessionID });
            return res.render("login", { error: "Invalid email or password", layout: false });
        }

        // Reset failed attempts on success
        await db.query(
            "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1",
            [user.id]
        );

        if (user.mfa_enabled) {
            await regenerateSession(req);
            req.session.pendingMfa = {
                id: user.id,
                name: user.name,
                role: user.role,
                email: user.email
            };

            await createMfaChallenge(user.id, user.email);
            await logAuditEvent(user.id, "mfa_required", { email: normalizedEmail }, req.ip);
            await saveSession(req);
            debugAuthLog("mfa challenge created", { userId: user.id, email: normalizedEmail, sessionID: req.sessionID });
            return res.redirect("/verify-mfa");
        }

        await regenerateSession(req);

        // Save session with role and explicitly persist before redirect.
        req.session.user = {
            id: user.id,
            name: user.name,
            role: user.role,
            email: user.email,
            lastActivity: Date.now()
        };
        await saveSession(req);

        await logAuditEvent(user.id, "login_success", { email: normalizedEmail }, req.ip);
        debugAuthLog("login success", { userId: user.id, role: user.role, email: normalizedEmail, sessionID: req.sessionID });

        return res.redirect(getPostLoginRedirect(user.role));

    } catch (err) {
        console.error("Login error:", err);
        debugAuthLog("login exception", { email: normalizedEmail, sessionID: req.sessionID, error: err.message });
        return res.render("login", { error: "Server error", layout: false });
    }
});

// ---------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------
router.get("/logout", requireLogin, async (req, res) => {
    try {
        if (req.session?.user?.id) {
            await logAuditEvent(req.session.user.id, "logout", { email: req.session.user.email }, req.ip);
        }
    } catch (err) {
        console.error("Logout audit error:", err);
    }

    req.session.destroy(() => {
        res.redirect("/login");
    });
});

router.post("/verify-mfa", requirePendingMfa, async (req, res) => {
    const { code } = req.body;
    const pending = req.session.pendingMfa;

    const challengeResult = await db.query(
        `SELECT * FROM mfa_challenges
         WHERE user_id = $1 AND used = FALSE
         ORDER BY created_at DESC
         LIMIT 1`,
        [pending.id]
    );

    const challenge = challengeResult.rows[0];

    if (!challenge || new Date(challenge.expires_at) < new Date()) {
        await logAuditEvent(pending.id, "mfa_expired", { email: pending.email }, req.ip);
        delete req.session.pendingMfa;
        return res.render("verify-mfa", { error: "Verification expired. Please login again.", layout: false });
    }

    if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
        await db.query("UPDATE mfa_challenges SET used = TRUE WHERE id = $1", [challenge.id]);
        await logAuditEvent(pending.id, "mfa_locked", { email: pending.email }, req.ip);
        delete req.session.pendingMfa;
        return res.render("verify-mfa", { error: "Too many failed attempts. Please login again.", layout: false });
    }

    const validCode = await bcrypt.compare(String(code || "").trim(), challenge.code_hash);
    if (!validCode) {
        await db.query("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1", [challenge.id]);
        await logAuditEvent(pending.id, "mfa_failed", { code_provided: Boolean(code) }, req.ip);
        return res.render("verify-mfa", { error: "Invalid verification code", layout: false });
    }

    await db.query("UPDATE mfa_challenges SET used = TRUE WHERE id = $1", [challenge.id]);

    await regenerateSession(req);

    req.session.user = {
        id: pending.id,
        name: pending.name,
        role: pending.role,
        email: pending.email,
        lastActivity: Date.now()
    };
    delete req.session.pendingMfa;
    await saveSession(req);

    await logAuditEvent(req.session.user.id, "login_success", { email: req.session.user.email, mfa: true }, req.ip);

    return res.redirect(getPostLoginRedirect(req.session.user.role));
});

// ---------------------------------------------------------
// FORGOT PASSWORD PAGE
// ---------------------------------------------------------
router.get("/forgot", (req, res) => {
    res.render("forgot", { message: null });
});

// ---------------------------------------------------------
// FORGOT PASSWORD SUBMIT
// ---------------------------------------------------------
router.post("/forgot", async (req, res) => {
    const { email } = req.body;

    try {
        const result = await db.query(
            "SELECT id FROM users WHERE email = $1",
            [email]
        );

        const user = result.rows[0];

        // Always respond the same to avoid email enumeration
        if (!user) {
            return res.render("forgot", {
                message: "If the email exists, a reset link was sent."
            });
        }

        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await db.query(
            "INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)",
            [user.id, token, expires]
        );

        // For demo: show token on screen
        return res.render("forgot", { message: `Reset token: ${token}` });

    } catch (err) {
        console.error("Forgot password error:", err);
        return res.render("forgot", { message: "Server error" });
    }
});

// ---------------------------------------------------------
// RESET PASSWORD PAGE
// ---------------------------------------------------------
router.get("/reset", (req, res) => {
    const { token } = req.query;
    res.render("reset", { token, error: null, message: null });
});

// ---------------------------------------------------------
// RESET PASSWORD SUBMIT
// ---------------------------------------------------------
router.post("/reset", async (req, res) => {
    const { token, password } = req.body;

    if (!hasStrongPassword(password)) {
        return res.render("reset", {
            token,
            error: getPasswordPolicyMessage(),
            message: null
        });
    }

    try {
        const result = await db.query(
            "SELECT * FROM password_resets WHERE token = $1",
            [token]
        );

        const reset = result.rows[0];

        if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
            return res.render("reset", {
                token,
                error: "Invalid or expired token",
                message: null
            });
        }

        const hash = await bcrypt.hash(password, 10);

        await db.query(
            "UPDATE users SET password_hash = $1 WHERE id = $2",
            [hash, reset.user_id]
        );

        await db.query(
            "UPDATE password_resets SET used = TRUE WHERE id = $1",
            [reset.id]
        );

        return res.render("reset", {
            token: null,
            error: null,
            message: "Password updated successfully"
        });

    } catch (err) {
        console.error("Reset password error:", err);
        return res.render("reset", {
            token,
            error: "Server error",
            message: null
        });
    }
});

// ---------------------------------------------------------
// ONE‑TIME ADMIN SETUP ROUTE
// ---------------------------------------------------------
router.get("/setup-admin", async (req, res) => {
    try {
        const check = await db.query(
            "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
        );

        if (check.rows.length > 0) {
            return res.send("Admin already exists. Setup skipped.");
        }

        const bootstrapEmail = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "admin@planner.com").trim().toLowerCase();
        const bootstrapName = String(process.env.ADMIN_BOOTSTRAP_NAME || "Administrator").trim() || "Administrator";
        const initialPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD || "AdminChangeMe123!";

        if (!hasStrongPassword(initialPassword)) {
            return res.status(400).send("ADMIN_BOOTSTRAP_PASSWORD does not meet password policy requirements.");
        }

        const hashed = await bcrypt.hash(initialPassword, 10);

        await db.query(
            "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, $3, $4)",
            [bootstrapEmail, hashed, "admin", bootstrapName]
        );

        res.send(`Admin user created successfully for ${bootstrapEmail}.`);
    } catch (err) {
        console.error("setup-admin error:", err);
        res.status(500).send("Failed to create admin user.");
    }
});

module.exports = router;
