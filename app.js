const express = require("express");
const session = require("express-session");
const path = require("path");
const { createTables } = require("./create_tables");
const { getConnection } = require("./database");

// ─── Process-level error handlers ────────────────────────────────────────────
// These catch anything that escapes a try/catch and would otherwise silently
// kill the process with no log output.
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException] Unhandled exception — process will exit:", err);
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[unhandledRejection] Unhandled promise rejection:", reason);
    console.error("Promise:", promise);
    process.exit(1);
});

<<<<<<< HEAD
// DATABASE INIT
createTables();

// TEMPLATE + STATIC FOLDERS
app.set("views", path.join(__dirname, "web/templates"));
app.set("view engine", "ejs");

app.use("/static", express.static(path.join(__dirname, "web/projects/public/static")));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// SESSION
app.use(
    session({
        secret: "supersecretkey",
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 60 * 1000,
            httpOnly: true,
            sameSite: "lax"
        }
    })
);

// INACTIVITY TIMEOUT
app.use((req, res, next) => {
    if (!req.session.user) return next();

    const now = Date.now();
    const maxInactivity = 30 * 60 * 1000;

    if (req.session.user.lastActivity && now - req.session.user.lastActivity > maxInactivity) {
        req.session.destroy(() => res.redirect("/login"));
        return;
=======
async function startServer() {
    try {
        // DATABASE INIT
        console.log("Initialising database tables...");
        await createTables();
        console.log("Database initialisation complete.");
    } catch (err) {
        console.error("[startServer] Failed during database initialisation:", err);
        process.exit(1);
>>>>>>> 8a3316ea800310a6be94b70c3bf98893bffd3a46
    }

    const app = express();

    // TEMPLATE + STATIC FOLDERS
    try {
        app.set("views", path.join(__dirname, "web/templates"));
        app.set("view engine", "ejs");
        console.log("View engine configured.");
    } catch (err) {
        console.error("[startServer] Failed to configure view engine:", err);
        process.exit(1);
    }

    // STATIC FILES + BODY PARSERS
    try {
        app.use("/static", express.static(path.join(__dirname, "projects/public/static")));
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());
        console.log("Static files and body parsers configured.");
    } catch (err) {
        console.error("[startServer] Failed to configure middleware:", err);
        process.exit(1);
    }

    // SESSION
    try {
        app.use(
            session({
                secret: process.env.SESSION_SECRET || "supersecretkey",
                resave: false,
                saveUninitialized: false,
                cookie: {
                    maxAge: 30 * 60 * 1000,
                    httpOnly: true,
                    sameSite: "lax"
                }
            })
        );
        console.log("Session middleware configured.");
    } catch (err) {
        console.error("[startServer] Failed to configure session middleware:", err);
        process.exit(1);
    }

    // INACTIVITY TIMEOUT
    app.use((req, res, next) => {
        if (!req.session.user) return next();

        const now = Date.now();
        const maxInactivity = 30 * 60 * 1000;

        if (req.session.user.lastActivity && now - req.session.user.lastActivity > maxInactivity) {
            req.session.destroy(() => res.redirect("/login"));
            return;
        }

        req.session.user.lastActivity = now;
        next();
    });

    // ROUTES
    try {
        console.log("Registering routes...");

        const authRoutes = require("./auth_routes");
        app.use("/", authRoutes);
        console.log("  ✓ auth_routes registered");

        const mainRoutes = require("./routes");
        app.use("/", mainRoutes);
        console.log("  ✓ main routes registered");

        const assignmentRoutes = require("./assignments");
        app.use("/assignments", assignmentRoutes);
        console.log("  ✓ assignment routes registered");

        const adminRoutes = require("./admin_routes");
        app.use("/admin", adminRoutes);
        console.log("  ✓ admin routes registered");

        console.log("All routes registered successfully.");
    } catch (err) {
        console.error("[startServer] Failed during route registration:", err);
        process.exit(1);
    }

    // GLOBAL ERROR HANDLER
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        console.error("[expressErrorHandler] Unhandled Express error:", err);
        res.status(500).send("Internal Server Error");
    });

    // START SERVER
    const PORT = process.env.PORT || 5000;
    try {
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error("[startServer] Failed to start HTTP server:", err);
        process.exit(1);
    }
}

startServer();
