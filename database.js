const { Pool } = require("pg");

// Create a connection pool
const pool = new Pool({
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "LiTyCaLi89!",
    database: "resource_planner"
});

// Optional: test connection on startup
pool.connect()
    .then(client => {
        console.log("Connected to PostgreSQL successfully.");
        client.release();
    })
    .catch(err => {
        console.error("Failed to connect to PostgreSQL:", err);
    });

// Return the pool so all modules share the same connection
function getConnection() {
    return pool;
}

module.exports = { getConnection };
