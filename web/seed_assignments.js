const { getConnection } = require("../database");
const db = getConnection();

// -----------------------------------------
// Helpers
// -----------------------------------------
async function getUserId(name) {
    const result = await db.query(
        `SELECT id FROM users WHERE name = $1`,
        [name]
    );
    return result.rows.length ? result.rows[0].id : null;
}

async function getProjectId(code) {
    const result = await db.query(
        `SELECT id FROM projects WHERE project_code = $1`,
        [code]
    );
    return result.rows.length ? result.rows[0].id : null;
}

// -----------------------------------------
// Seeder
// -----------------------------------------
async function seedAssignments() {
    console.log("Seeding assignments...");

    // Clear old data
    await db.query("DELETE FROM assignments;");

    const assignments = [
        ["Sasha", "PRJ001", "2026-05-19", "2026-06-30", 20, "Mon-Fri"],
        ["Sasha", "PRJ002", "2026-05-19", "2026-07-15", 15, "Mon-Fri"],
        ["Sasha", "PRJ003", "2026-05-23", "2026-06-05", 8, "Wed, Fri"],
        ["Sasha", "PRJ004", "2026-05-23", "2026-06-18", 20, "Mon, Tue, Thu"],
        ["Sasha", "PRJ005", "2026-05-23", "2026-06-01", 19, "Wed"],

        ["Peter", "PRJ001", "2026-05-19", "2026-08-01", 5, "Mon-Fri"],
        ["Peter", "PRJ002", "2026-05-19", "2026-07-15", 5, "Tue, Thu"],

        ["Lappies", "PRJ001", "2026-05-19", "2026-06-30", 2, "Mon-Fri"],
        ["Lappies", "PRJ002", "2026-05-19", "2026-06-01", 3, "Mon-Fri"],
        ["Lappies", "PRJ004", "2026-05-23", "2026-06-30", 10, "Mon, Wed, Fri"],

        ["Team Member 4", "PRJ001", "2026-05-19", "2026-08-01", 40, "Mon-Fri"],

        ["Team Member 5", "PRJ003", "2026-05-23", "2026-06-30", 25, "Mon-Fri"]
    ];

    for (const [name, code, start, end, hours, days] of assignments) {
        const userId = await getUserId(name);
        const projectId = await getProjectId(code);

        if (!userId) {
            console.error(`User not found: ${name}`);
            continue;
        }
        if (!projectId) {
            console.error(`Project not found: ${code}`);
            continue;
        }

        await db.query(
            `
            INSERT INTO assignments (
                user_id,
                project_id,
                start_date,
                end_date,
                hours_per_week,
                work_days
            )
            VALUES ($1, $2, $3, $4, $5, $6)
        `,
            [userId, projectId, start, end, hours, days]
        );
    }

    console.log("Assignments added successfully!");
}

module.exports = { seedAssignments };
