const bcrypt = require("bcryptjs");
const { getConnection } = require("../database");
const db = getConnection();

// ---------------------------------------------------------
// DROP + CREATE TABLES
// ---------------------------------------------------------
async function resetTables() {
    console.log("Dropping and recreating tables...");

    await db.query("DROP TABLE IF EXISTS assignments;");
    await db.query("DROP TABLE IF EXISTS projects;");
    await db.query("DROP TABLE IF EXISTS users;");

    await db.query(`
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'staff',
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TIMESTAMP NULL
        );
    `);

    await db.query(`
        CREATE TABLE projects (
            id SERIAL PRIMARY KEY,
            project_code TEXT UNIQUE NOT NULL,
            project_name TEXT NOT NULL,
            client TEXT,
            color TEXT
        );
    `);

    await db.query(`
        CREATE TABLE assignments (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            hours_per_week INTEGER NOT NULL,
            work_days TEXT,
            start_time TEXT,
            end_time TEXT,
            requested_by INTEGER REFERENCES users(id)
        );
    `);

    console.log("Tables recreated.");
}

// ---------------------------------------------------------
// SEED USERS
// ---------------------------------------------------------
async function seedUsers() {
    console.log("Seeding users...");

    const users = [
        { name: "Admin User", email: "admin@example.com", password: "admin123", role: "admin" },
        { name: "Manager User", email: "manager@example.com", password: "manager123", role: "manager" },
        { name: "Alice", email: "alice@example.com", password: "password", role: "staff" },
        { name: "Bob", email: "bob@example.com", password: "password", role: "staff" },
        { name: "Charlie", email: "charlie@example.com", password: "password", role: "staff" }
    ];

    for (const u of users) {
        const hash = await bcrypt.hash(u.password, 12);

        await db.query(
            `
            INSERT INTO users (name, email, password_hash, role)
            VALUES ($1, $2, $3, $4)
        `,
            [u.name, u.email, hash, u.role]
        );
    }

    console.log("Users seeded.");
}

// ---------------------------------------------------------
// SEED PROJECTS
// ---------------------------------------------------------
async function seedProjects() {
    console.log("Seeding projects...");

    const projects = [
        ["PRJ001", "Website Redesign", "Client A", "#FF5733"],
        ["PRJ002", "Mobile App", "Client B", "#33C1FF"],
        ["PRJ003", "Internal Tools", "Client C", "#75FF33"]
    ];

    for (const p of projects) {
        await db.query(
            `
            INSERT INTO projects (project_code, project_name, client, color)
            VALUES ($1, $2, $3, $4)
        `,
            p
        );
    }

    console.log("Projects seeded.");
}

// ---------------------------------------------------------
// SEED ASSIGNMENTS
// ---------------------------------------------------------
async function seedAssignments() {
    console.log("Seeding assignments...");

    const users = await db.query("SELECT id FROM users ORDER BY id;");
    const projects = await db.query("SELECT id FROM projects ORDER BY id;");

    const u = users.rows;
    const p = projects.rows;

    const assignments = [
        [u[2].id, p[0].id, "2024-01-01", "2024-02-01", 20, "Mon,Tue,Wed", "09:00", "12:00"],
        [u[3].id, p[1].id, "2024-01-10", "2024-03-01", 30, "Mon-Fri", "10:00", "15:00"],
        [u[4].id, p[2].id, "2024-02-01", "2024-04-01", 15, "Tue,Thu", "08:00", "11:00"]
    ];

    for (const a of assignments) {
        await db.query(
            `
            INSERT INTO assignments (
                user_id,
                project_id,
                start_date,
                end_date,
                hours_per_week,
                work_days,
                start_time,
                end_time
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
            a
        );
    }

    console.log("Assignments seeded.");
}

// ---------------------------------------------------------
// RUN SEED
// ---------------------------------------------------------
async function runSeed() {
    await resetTables();
    await seedUsers();
    await seedProjects();
    await seedAssignments();
    console.log("Database seeding complete.");
}

runSeed();
