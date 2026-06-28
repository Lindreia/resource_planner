const express = require("express");
const session = require("express-session");
const path = require("path");
const { createTables } = require("./database/create_tables");
const { getConnection } = require("./database");

// Routers
const authRoutes = require("../auth_routes");
const mainRoutes = require("../routes");
const assignmentRoutes = require("../assignments");
const adminRoutes = require("./admin_routes");

const app = express();

// -----------------------------------------
// DATABASE INIT
// -----------------------------------------
createTables(); // Ensures all tables exist

// -----------------------------------------
// TEMPLATE + STATIC FOLDERS
// -----------------------------------------
app.set("views", path.join(__dirname, "templates"));
app.set("view engine", "ejs");

// Global static assets
app.use("/static", express.static(path.join(__dirname, "projects/public/static")));

// -----------------------------------------
// MIDDLEWARE
// -----------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -----------------------------------------
// SESSION SETUP
// -----------------------------------------
app.use(
    session({
        secret: "supersecretkey",
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 60 * 1000, // 30 minutes
            httpOnly: true,
            sameSite: "lax"
        }
    })
);

// -----------------------------------------
// INACTIVITY TIMEOUT
// -----------------------------------------
app.use((req, res, next) => {
    if (!req.session.user) return next();

    const now = Date.now();
    const maxInactivity = 30 * 60 * 1000; // 30 minutes

    if (req.session.user.lastActivity && now - req.session.user.lastActivity > maxInactivity) {
        req.session.destroy(() => res.redirect("/login"));
        return;
    }

    req.session.user.lastActivity = now;
    next();
});

// -----------------------------------------
// ROUTES
// -----------------------------------------
app.use("/", authRoutes);
app.use("/", mainRoutes);
app.use("/assignments", assignmentRoutes);

// NEW: Admin routes
app.use("/admin", adminRoutes);

// -----------------------------------------
// START SERVER
// -----------------------------------------
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
