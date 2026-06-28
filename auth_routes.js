const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getConnection } = require("./database");
const { requireLogin } = require("./web/authMiddleware");

const router = express.Router();
const db = getConnection();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;

// ---------------------------------------------------------
// LOGIN PAGE
// ---------------------------------------------------------
router.get("/login", (req, res) => {
    res.render("login", { error: null });
});

// ---------------------------------------------------------
// LOGIN SUBMIT
// ---------------------------------------------------------
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

        // Account lock check
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.render("login", { error: "Account locked. Contact admin." });
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

            return res.render("login", { error: "Invalid email or password" });
        }

        // Reset failed attempts on success
        await db.query(
            "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1",
            [user.id]
        );

        // Save session
        req.session.user = {
            id: user.id,
            name: user.name,
            role: user.role,
            email: user.email,
            lastActivity: Date.now()
        };

        return res.redirect("/dashboard");

    } catch (err) {
        console.error("Login error:", err);
        return res.render("login", { error: "Server error" });
    }
});

// ---------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------
router.get("/logout", requireLogin, (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
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

    if (!password || password.length < 12) {
        return res.render("reset", {
            token,
            error: "Password must be at least 12 characters",
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

module.exports = router;
