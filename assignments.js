const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");

const db = getConnection();
const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function parseWorkingDays(value) {
    if (!value) return [];

    return String(value)
        .split(",")
        .map((v) => v.trim())
        .filter((d) => WEEKDAY_ORDER.includes(d));
}

// ---------------------------------------------------------
// TIME CONFLICT CHECKER (POSTGRES)
// ---------------------------------------------------------
async function hasTimeConflict(teamMemberId, startDate, endDate, startTime, endTime) {
    const query = `
        SELECT start_date, end_date, start_time, end_time
        FROM assignments
        WHERE user_id = $1
          AND NOT ($2 > end_date OR $3 < start_date)
    `;

    const result = await db.query(query, [teamMemberId, endDate, startDate]);
    const rows = result.rows;

    const conflicts = [];

    for (const row of rows) {
        if (!row.start_time || !row.end_time) continue;

        // TIME OVERLAP
        if (startTime < row.end_time && endTime > row.start_time) {
            conflicts.push(`${row.start_date} ${row.start_time}-${row.end_time}`);
        }
    }

    return conflicts;
}

// ---------------------------------------------------------
// WEEKLY CAPACITY CHECK (POSTGRES)
// ---------------------------------------------------------
async function exceedsWeeklyCapacity(teamMemberId, startDate, endDate, hoursPerWeek) {
    const query = `
        SELECT COALESCE(SUM(a.hours_per_week), 0) AS total,
               u.weekly_capacity AS weekly_capacity
        FROM users u
        LEFT JOIN assignments a
          ON a.user_id = u.id
         AND NOT ($2 > a.end_date OR $3 < a.start_date)
        WHERE u.id = $1
        GROUP BY u.weekly_capacity
    `;

    const result = await db.query(query, [teamMemberId, endDate, startDate]);
    const row = result.rows[0] || { total: 0, weekly_capacity: 40 };
    const current = Number(row.total) || 0;
    const weeklyCapacity = Number(row.weekly_capacity) || 40;

    const total = current + hoursPerWeek;

    return { exceeded: total > weeklyCapacity, total, weeklyCapacity };
}

// ---------------------------------------------------------
// POST: ADD ASSIGNMENT (POSTGRES)
// ---------------------------------------------------------
router.post("/add", async (req, res) => {
    try {
        const teamMemberId = parseInt(req.body.team_member);
        const projectId = parseInt(req.body.project);

        const startDate = req.body.start_date;
        const endDate = req.body.end_date;

        const startTime = req.body.start_time;
        const endTime = req.body.end_time;

        const hoursPerWeek = parseInt(req.body.hours_per_week);

        if (!teamMemberId || !projectId) {
            return res.status(400).json({ error: "Invalid team member or project" });
        }

        if (endDate < startDate) {
            return res.status(400).json({ error: "End date cannot be before start date" });
        }

        if (endTime <= startTime) {
            return res.status(400).json({ error: "End time must be after start time" });
        }

        // TIME CONFLICTS
        const conflicts = await hasTimeConflict(
            teamMemberId,
            startDate,
            endDate,
            startTime,
            endTime
        );

        if (conflicts.length > 0) {
            return res.status(400).json({ conflicts });
        }

        const userResult = await db.query(
            "SELECT name, working_days FROM users WHERE id = $1",
            [teamMemberId]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Team member not found" });
        }

        const user = userResult.rows[0];
        const allowedDays = parseWorkingDays(user.working_days);

        if (allowedDays.length === 0) {
            return res.status(400).json({
                error: `${user.name} has no working days configured. Ask an admin to update profile settings.`
            });
        }

        // WEEKLY CAPACITY
        const { exceeded, weeklyCapacity } = await exceedsWeeklyCapacity(
            teamMemberId,
            startDate,
            endDate,
            hoursPerWeek
        );

        if (exceeded) {
            return res.status(400).json({
                error: `Weekly capacity exceeded (${weeklyCapacity} hrs)`
            });
        }

        // INSERT ASSIGNMENT
        const insertQuery = `
            INSERT INTO assignments (
                user_id,
                project_id,
                start_date,
                end_date,
                work_days,
                start_time,
                end_time,
                hours_per_week
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;

        await db.query(insertQuery, [
            teamMemberId,
            projectId,
            startDate,
            endDate,
            allowedDays.length,
            startTime,
            endTime,
            hoursPerWeek
        ]);

        return res.json({ success: true });

    } catch (err) {
        console.error("Assignment creation error:", err);
        return res.status(400).json({ error: "Invalid form data" });
    }
});

// ---------------------------------------------------------
// GET: FORM PAGE (POSTGRES)
// ---------------------------------------------------------
router.get("/add", async (req, res) => {
    try {
        const teamMembersQuery = `
            SELECT id, name, weekly_capacity, working_days
            FROM users
            WHERE role = 'staff'
            ORDER BY name
        `;

        const projectsQuery = `
            SELECT id, project_code, project_name
            FROM projects
            ORDER BY project_code
        `;

        const teamMembers = (await db.query(teamMembersQuery)).rows;
        const projects = (await db.query(projectsQuery)).rows;

        res.render("assignments/add_assignment", {
            team_members: teamMembers,
            projects: projects
        });

    } catch (err) {
        console.error("Form load error:", err);
        res.status(500).send("Error loading form");
    }
});

module.exports = router;
