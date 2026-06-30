const { getConnection } = require("./database");
const db = getConnection();

async function createTables() {
    try {
        // USERS
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL CHECK (role IN ('admin','manager','staff','viewer','client')),
                weekly_capacity INTEGER NOT NULL DEFAULT 40,
                password_hash TEXT NOT NULL,
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until TIMESTAMPTZ,
                mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                mfa_secret TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await db.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
        `);

        await db.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
        `);

        await db.query(`
            UPDATE users
            SET is_active = TRUE
            WHERE is_active IS NULL;
        `);
        console.log("Users table ensured.");

        // PROJECTS
        await db.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                project_code TEXT NOT NULL UNIQUE,
                project_name TEXT NOT NULL,
                client TEXT,
                color TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log("Projects table ensured.");

        // BOOKINGS
        await db.query(`
            CREATE TABLE IF NOT EXISTS bookings (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                project_id INTEGER NOT NULL REFERENCES projects(id),
                date DATE NOT NULL,
                hours NUMERIC(5,2) NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                notes TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_bookings_user_date
            ON bookings(user_id, date);
        `);

        console.log("Bookings table ensured.");

        // ASSIGNMENTS
        await db.query(`
            CREATE TABLE IF NOT EXISTS assignments (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                project_id INTEGER NOT NULL REFERENCES projects(id),
                start_date DATE NOT NULL,
                end_date DATE,
                hours_per_week INTEGER NOT NULL,
                work_days INTEGER NOT NULL DEFAULT 5,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log("Assignments table ensured.");

        // TEAM MEMBERS
        await db.query(`
            CREATE TABLE IF NOT EXISTS team_members (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                team_name TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log("Team members table ensured.");

        // OVERRIDE REQUESTS
        await db.query(`
            CREATE TABLE IF NOT EXISTS override_requests (
                id SERIAL PRIMARY KEY,
                booking_id INTEGER REFERENCES bookings(id),
                requested_by INTEGER NOT NULL REFERENCES users(id),
                approved_by INTEGER REFERENCES users(id),
                status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
                reason TEXT NOT NULL,
                conflicts_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                resolved_at TIMESTAMPTZ
            );
        `);
        console.log("Override requests table ensured.");

        // AUDIT LOGS
        await db.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                event_type TEXT NOT NULL,
                details JSONB,
                ip INET,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log("Audit logs table ensured.");

        // NOTIFICATIONS
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                type TEXT NOT NULL,
                payload JSONB NOT NULL,
                read_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log("Notifications table ensured.");

        // PASSWORD RESET TOKENS
        await db.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                token TEXT NOT NULL UNIQUE,
                expires_at TIMESTAMPTZ NOT NULL,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log("Password resets table ensured.");

        // MFA CHALLENGES
        await db.query(`
            CREATE TABLE IF NOT EXISTS mfa_challenges (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                code_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_expiry
            ON mfa_challenges(user_id, expires_at DESC);
        `);
        console.log("MFA challenges table ensured.");

        console.log("All tables created successfully.");

    } catch (err) {
        console.error("Error creating tables:", err);
    }
}

module.exports = { createTables };
