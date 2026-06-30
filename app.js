const express = require("express");
const session = require("express-session");
const PgSessionFactory = require("connect-pg-simple");
const path = require("path");
const expressLayouts = require("express-ejs-layouts");
const bcrypt = require("bcryptjs");
const { createTables } = require("./create_tables");
const { getConnection } = require("./database");

// ───────────────────────────────────────────────────────────
// Process‑level error handlers
// ───────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException] Unhandled exception — process will exit:", err);
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[unhandledRejection] Unhandled promise rejection:", reason);
    console.error("Promise:", promise);
    process.exit(1);
});

function hasStrongPassword(password) {
    if (!password || password.length < 12) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    if (!/[^A-Za-z0-9]/.test(password)) return false;
    return true;
}

async function ensureBootstrapAdmin() {
    const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;

    if (!bootstrapPassword) {
        console.warn("Bootstrap admin skipped: ADMIN_BOOTSTRAP_PASSWORD is not set.");
        return;
    }

    if (!hasStrongPassword(bootstrapPassword)) {
        throw new Error("ADMIN_BOOTSTRAP_PASSWORD does not meet password policy requirements.");
    }

    const db = getConnection();
    const adminCheck = await db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");

    if (adminCheck.rows.length > 0) {
        console.log("Bootstrap admin already exists.");
        return;
    }

    const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "admin@planner.com").trim().toLowerCase();
    const name = String(process.env.ADMIN_BOOTSTRAP_NAME || "Administrator").trim() || "Administrator";
    const hash = await bcrypt.hash(bootstrapPassword, 10);

    await db.query(
        "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, $3, $4)",
        [email, hash, "admin", name]
    );

    console.log(`Bootstrap admin created for ${email}.`);
}

// ───────────────────────────────────────────────────────────
// Server bootstrap
// ───────────────────────────────────────────────────────────
async function startServer() {
    try {
        console.log("Initialising database tables...");
        await createTables();
        await ensureBootstrapAdmin();
        console.log("Database initialisation complete.");
    } catch (err) {
        console.error("[startServer] Failed during database initialisation:", err);
        process.exit(1);
    }

    const app = express();
    const PgSession = PgSessionFactory(session);

    if (process.env.TRUST_PROXY === "true" || process.env.NODE_ENV === "production") {
        app.set("trust proxy", 1);
    }

    // ───────────────────────────────────────────────────────────
    // Layout Engine
    // ───────────────────────────────────────────────────────────
    app.use(expressLayouts);
    app.set("layout", "components/layout");

    // ───────────────────────────────────────────────────────────
    // Templates + Static
    // ───────────────────────────────────────────────────────────
    app.set("views", path.join(__dirname, "web/templates"));
    app.set("view engine", "ejs");

    app.use("/static", express.static(path.join(__dirname, "web/projects/public/static")));
    app.use("/docs", express.static(path.join(__dirname, "web/public/docs")));

    // ───────────────────────────────────────────────────────────
    // Body parsers
    // ───────────────────────────────────────────────────────────
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // ───────────────────────────────────────────────────────────
    // Session
    // ───────────────────────────────────────────────────────────
    app.use(
        session({
            secret: process.env.SESSION_SECRET || "supersecretkey",
            resave: false,
            saveUninitialized: false,
            proxy: true,
            store: new PgSession({
                pool: getConnection(),
                tableName: "user_sessions",
                createTableIfMissing: true
            }),
            cookie: {
                maxAge: 30 * 60 * 1000,
                httpOnly: true,
                sameSite: "lax",
                secure: process.env.NODE_ENV === "production" ? "auto" : false
            }
        })
    );
// Make `user` available to all EJS templates
app.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    next();
});
// Default active_page for all EJS templates
app.use((req, res, next) => {
    res.locals.active_page = null;
    next();
});

    // Optional IP allowlist for production hardening (comma-separated, exact match).
    app.use((req, res, next) => {
        const rawAllowed = process.env.ALLOWED_IPS;
        if (!rawAllowed) return next();

        const allowed = rawAllowed.split(",").map(s => s.trim()).filter(Boolean);
        if (allowed.length === 0) return next();

        const reqIp = req.ip || req.connection?.remoteAddress || "";
        if (allowed.includes(reqIp)) return next();

        return res.status(403).send("Access denied from this IP address.");
    });

    // ───────────────────────────────────────────────────────────
    // Inactivity timeout
    // ───────────────────────────────────────────────────────────
    app.use((req, res, next) => {
        if (!req.session.user) return next();

        const now = Date.now();
        const maxInactivity = 30 * 60 * 1000;

        if (req.session.user.lastActivity &&
            now - req.session.user.lastActivity > maxInactivity) {
            req.session.destroy(() => res.redirect("/login"));
            return;
        }

        req.session.user.lastActivity = now;
        next();
    });

    // ───────────────────────────────────────────────────────────
    // Routes
    // ───────────────────────────────────────────────────────────
    try {
        const authRoutes = require("./auth_routes");
        const mainRoutes = require("./routes");
        const assignmentRoutes = require("./assignments");
        const adminRoutes = require("./admin_routes");

        app.use("/", authRoutes);
        app.use("/", mainRoutes);
        app.use("/assignments", assignmentRoutes);
        app.use("/admin", adminRoutes);

        console.log("Routes registered.");
    } catch (err) {
        console.error("[startServer] Failed during route registration:", err);
        process.exit(1);
    }

    // ───────────────────────────────────────────────────────────
    // Global error handler
    // ───────────────────────────────────────────────────────────
    app.use((err, req, res, next) => {
        console.error("[expressErrorHandler] Unhandled Express error:", err);
        res.status(500).send("Internal Server Error");
    });

    // ───────────────────────────────────────────────────────────
    // Start server
    // ───────────────────────────────────────────────────────────
    const PORT = process.env.PORT || 5000;

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
