const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");

const db = getConnection();
const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_TO_INDEX = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
};

function parseWorkingDays(value) {
    if (!value) return [];

    return String(value)
        .split(",")
        .map((v) => v.trim())
        .filter((d) => WEEKDAY_ORDER.includes(d));
}

function normalizeSubmittedDays(value) {
    if (!value) return [];

    const source = Array.isArray(value)
        ? value
        : String(value)
            .split(",")
            .map((v) => v.trim());

    return WEEKDAY_ORDER.filter((day) => source.includes(day));
}

function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getEffectiveDailyHours(row) {
    const explicitDaily = toNumber(row.hours_per_day);
    if (explicitDaily > 0) return explicitDaily;

    const weekly = toNumber(row.hours_per_week);
    const dayCount = Math.max(toNumber(row.work_days), 1);
    return weekly > 0 ? weekly / dayCount : 0;
}

function countAssignmentDaysBetween(startDate, endDate, assignmentDays) {
    const allowedSet = new Set(assignmentDays.map((d) => WEEKDAY_TO_INDEX[d]).filter(Boolean));
    if (allowedSet.size === 0) return 0;

    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    let count = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const jsDay = d.getDay();
        const isoDay = jsDay === 0 ? 7 : jsDay;
        if (allowedSet.has(isoDay)) {
            count += 1;
        }
    }

    return count;
}

function round2(value) {
    return Number((Number(value) || 0).toFixed(2));
}

async function buildCapacityPreview(teamMemberId, startDate, endDate, requestedDaysRaw, totalHoursInput, hoursPerWeekInput, hoursPerDayInput) {
    const result = await db.query(
        `SELECT
            u.role,
            u.weekly_capacity,
            u.working_days,
            a.hours_per_day,
            a.hours_per_week,
            a.work_days
         FROM users u
         LEFT JOIN assignments a
           ON a.user_id = u.id
          AND NOT ($2 > a.end_date OR $3 < a.start_date)
         WHERE u.id = $1`,
        [teamMemberId, endDate, startDate]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const role = String(result.rows[0].role || "").toLowerCase();
    const allowedDays = result.rows[0].working_days
        ? parseWorkingDays(result.rows[0].working_days)
        : ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const requestedDays = requestedDaysRaw.filter((day) => allowedDays.includes(day));
    const effectiveDays = requestedDays.length > 0 ? requestedDays : allowedDays;

    const weeklyCapacity = toNumber(result.rows[0].weekly_capacity) || 40;
    const currentAllocated = result.rows.reduce((sum, row) => {
        const existingDays = parseWorkingDays(row.working_days).length || 5;
        return sum + (getEffectiveDailyHours(row) * existingDays);
    }, 0);

    let projectedWeeklyHours = 0;
    let projectedHoursPerDay = 0;

    if (Number.isFinite(totalHoursInput) && totalHoursInput > 0) {
        const assignmentDayCount = countAssignmentDaysBetween(startDate, endDate, effectiveDays);
        if (assignmentDayCount > 0) {
            projectedHoursPerDay = totalHoursInput / assignmentDayCount;
            projectedWeeklyHours = projectedHoursPerDay * effectiveDays.length;
        }
    } else if (Number.isFinite(hoursPerWeekInput) && hoursPerWeekInput > 0) {
        projectedWeeklyHours = hoursPerWeekInput;
        projectedHoursPerDay = projectedWeeklyHours / Math.max(effectiveDays.length, 1);
    } else if (Number.isFinite(hoursPerDayInput) && hoursPerDayInput > 0) {
        projectedHoursPerDay = hoursPerDayInput;
        projectedWeeklyHours = projectedHoursPerDay * effectiveDays.length;
    }

    if (role === "contractor") {
        return {
            isContractor: true,
            weeklyCapacity: null,
            currentAllocated: round2(currentAllocated),
            remainingBefore: null,
            projectedWeeklyHours: round2(projectedWeeklyHours),
            projectedHoursPerDay: round2(projectedHoursPerDay),
            remainingAfter: null,
            effectiveDays
        };
    }

    return {
        isContractor: false,
        weeklyCapacity: round2(weeklyCapacity),
        currentAllocated: round2(currentAllocated),
        remainingBefore: round2(weeklyCapacity - currentAllocated),
        projectedWeeklyHours: round2(projectedWeeklyHours),
        projectedHoursPerDay: round2(projectedHoursPerDay),
        remainingAfter: round2(weeklyCapacity - currentAllocated - projectedWeeklyHours),
        effectiveDays
    };
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
async function exceedsWeeklyCapacity(teamMemberId, startDate, endDate, hoursPerDay, workingDaysCount) {
    const query = `
        SELECT
            u.role,
            u.weekly_capacity,
            u.working_days,
            a.hours_per_day,
            a.hours_per_week,
            a.work_days
        FROM users u
        LEFT JOIN assignments a
          ON a.user_id = u.id
         AND NOT ($2 > a.end_date OR $3 < a.start_date)
        WHERE u.id = $1
    `;

    const result = await db.query(query, [teamMemberId, endDate, startDate]);
    if (result.rows.length === 0) {
        return { exceeded: false, total: 0, weeklyCapacity: 40 };
    }

    // Contractors are flexible capacity resources and are not capped to a fixed weekly limit.
    if (String(result.rows[0].role || "").toLowerCase() === "contractor") {
        return { exceeded: false, total: 0, weeklyCapacity: null };
    }

    const weeklyCapacity = toNumber(result.rows[0].weekly_capacity) || 40;
    const current = result.rows.reduce((sum, row) => {
        const existingDays = parseWorkingDays(row.working_days).length || 5;
        return sum + (getEffectiveDailyHours(row) * existingDays);
    }, 0);

    const total = current + (hoursPerDay * Math.max(workingDaysCount, 1));
    return { exceeded: total > weeklyCapacity, total, weeklyCapacity };
}

// ---------------------------------------------------------
// POST: ADD ASSIGNMENT (POSTGRES)
// ---------------------------------------------------------
router.post("/add", async (req, res) => {
    try {
        const currentRole = String(req.session?.user?.role || "").toLowerCase();
        const isAdmin = currentRole === "admin";

        const teamMemberId = parseInt(req.body.team_member);
        const projectId = parseInt(req.body.project);

        const startDate = req.body.start_date;
        const endDate = req.body.end_date;

        const startTime = req.body.start_time;
        const endTime = req.body.end_time;

        const hoursPerDayInput = Number(req.body.hours_per_day);
        const hoursPerWeekInput = Number(req.body.hours_per_week);
        const totalHoursInput = Number(req.body.total_hours);

        if (!teamMemberId || !projectId) {
            return res.status(400).json({ error: "Invalid team member or project" });
        }

        if (endDate < startDate) {
            return res.status(400).json({ error: "End date cannot be before start date" });
        }

        if (endTime <= startTime) {
            return res.status(400).json({ error: "End time must be after start time" });
        }

        let userResult;
        try {
            userResult = await db.query(
                "SELECT working_days FROM users WHERE id = $1",
                [teamMemberId]
            );
        } catch (err) {
            if (err && err.code === "42703") {
                userResult = await db.query(
                    "SELECT id FROM users WHERE id = $1",
                    [teamMemberId]
                );
            } else {
                throw err;
            }
        }

        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Team member not found" });
        }

        const allowedDays = userResult.rows[0].working_days
            ? parseWorkingDays(userResult.rows[0].working_days)
            : ["Mon", "Tue", "Wed", "Thu", "Fri"];
        const requestedDaysRaw = normalizeSubmittedDays(req.body.assignment_days);
        if (requestedDaysRaw.length === 0) {
            return res.status(400).json({ error: "Select at least one assignment day." });
        }
        const requestedDays = requestedDaysRaw.filter((day) => allowedDays.includes(day));
        const effectiveDays = requestedDays.length > 0 ? requestedDays : allowedDays;

        if (effectiveDays.length === 0) {
            return res.status(400).json({ error: "Selected team member has no working days configured." });
        }

        let effectiveWeeklyHours = 0;
        let effectiveHoursPerDay = 0;

        if (Number.isFinite(totalHoursInput) && totalHoursInput > 0) {
            const assignmentDayCount = countAssignmentDaysBetween(startDate, endDate, effectiveDays);
            if (assignmentDayCount <= 0) {
                return res.status(400).json({ error: "No assignment days fall inside the selected date range." });
            }

            effectiveHoursPerDay = totalHoursInput / assignmentDayCount;
            effectiveWeeklyHours = effectiveHoursPerDay * effectiveDays.length;
        } else if (Number.isFinite(hoursPerWeekInput) && hoursPerWeekInput > 0) {
            effectiveWeeklyHours = hoursPerWeekInput;
            effectiveHoursPerDay = effectiveWeeklyHours / effectiveDays.length;
        } else if (Number.isFinite(hoursPerDayInput) && hoursPerDayInput > 0) {
            effectiveHoursPerDay = hoursPerDayInput;
            effectiveWeeklyHours = effectiveHoursPerDay * effectiveDays.length;
        } else {
            return res.status(400).json({ error: "Enter total hours, hours per week, or hours per day." });
        }

        if (!Number.isFinite(effectiveWeeklyHours) || effectiveWeeklyHours <= 0 || !Number.isFinite(effectiveHoursPerDay) || effectiveHoursPerDay <= 0) {
            return res.status(400).json({ error: "Hours must be a positive number." });
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

        // WEEKLY CAPACITY
        if (!isAdmin) {
            const { exceeded, weeklyCapacity } = await exceedsWeeklyCapacity(
                teamMemberId,
                startDate,
                endDate,
                effectiveHoursPerDay,
                effectiveDays.length
            );

            if (exceeded) {
                return res.status(400).json({ error: `Weekly capacity exceeded (${weeklyCapacity} hrs)` });
            }
        }

        // INSERT ASSIGNMENT
        const insertQuery = `
            INSERT INTO assignments (
                user_id,
                project_id,
                start_date,
                end_date,
                work_days,
                assignment_days,
                hours_per_day,
                start_time,
                end_time,
                hours_per_week
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;

        await db.query(insertQuery, [
            teamMemberId,
            projectId,
            startDate,
            endDate,
            effectiveDays.length,
            effectiveDays.join(","),
            Number(effectiveHoursPerDay.toFixed(4)),
            startTime,
            endTime,
            Number(effectiveWeeklyHours.toFixed(4))
        ]);

        return res.json({ success: true });

    } catch (err) {
        console.error("Assignment creation error:", err);
        return res.status(400).json({ error: "Invalid form data" });
    }
});

router.get("/preview", async (req, res) => {
    try {
        const teamMemberId = Number(req.query.team_member);
        const startDate = String(req.query.start_date || "");
        const endDate = String(req.query.end_date || "");

        if (!Number.isInteger(teamMemberId) || teamMemberId <= 0) {
            return res.status(400).json({ error: "Invalid team member." });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ error: "Start and end date are required." });
        }

        const requestedDaysRaw = normalizeSubmittedDays(req.query.assignment_days);
        const totalHoursInput = Number(req.query.total_hours);
        const hoursPerWeekInput = Number(req.query.hours_per_week);
        const hoursPerDayInput = Number(req.query.hours_per_day);

        const preview = await buildCapacityPreview(
            teamMemberId,
            startDate,
            endDate,
            requestedDaysRaw,
            totalHoursInput,
            hoursPerWeekInput,
            hoursPerDayInput
        );

        if (!preview) {
            return res.status(404).json({ error: "Team member not found." });
        }

        return res.json(preview);
    } catch (err) {
        console.error("Assignment preview error:", err);
        return res.status(500).json({ error: "Failed to build assignment preview." });
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
            WHERE role IN ('staff', 'contractor', 'manager', 'admin')
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
