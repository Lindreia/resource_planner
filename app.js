const express = require("express");
const session = require("express-session");
const path = require("path");
const { createTables } = require("./create_tables");
const { getConnection } = require("./database");

// ─── Process-level error handlers ────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException] Unhandled exception — process will exit:", err);
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[unhandledRejection] Unhandled promise rejection:", reason);
    console.error("Promise:", promise);
    process.exit(1);
});

async function startServer() {
    try {
        console.log("Initialising database tables...");
        await createTables();
        console.log("Database initialisation complete.");
    } catch (err) {
        console.error("[startServer] Failed during database initialisation:", err);
        process.exit(1);
    }

    const app = express();
