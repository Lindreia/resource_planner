const express = require("express");
const session = require("express-session");
const path = require("path");
const { createTables } = require("./create_tables");
const { getConnection } = require("./database");

// Routers
const authRoutes = require("./auth_routes");
const mainRoutes = require("./routes");
const assignmentRoutes = require("./assignments");
const adminRoutes = require("./admin_routes");

const app = express();

// DATABASE INIT
createTables();

// TEMPLATE + STATIC FOLDERS
app.set("views", path.join(__dirname, "web/templates"));
app.set("view engine", "ejs");

app.use("/static", express.static(path.join(__dirname, "projects/public/static")));

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
    }

    req.session.user.lastActivity = now;
    next();
});

// ROUTES
app.use("/", authRoutes);
app.use("/", mainRoutes);
app.use("/assignments", assignmentRoutes);
app.use("/admin", adminRoutes);

// START SERVER
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
