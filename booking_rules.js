const { getConnection } = require("../database");
const db = getConnection();

// ----------------------------------------------------
// 1. parse_time — identical behavior to Python version
// ----------------------------------------------------
function parseTime(value) {
    if (!value || String(value).trim() === "") return null;

    value = String(value).trim();
    let parts = value.split(":");

    // HH:MM:SS
    if (parts.length === 3) {
        const [h, m, s] = parts.map(Number);
        if (!isNaN(h) && !isNaN(m) && !isNaN(s)) return { h, m, s };
    }

    // HH:MM
    if (parts.length === 2) {
        const [h, m] = parts.map(Number);
        if (!isNaN(h) && !isNaN(m)) return { h, m, s: 0 };
    }

    // Zero‑padding (e.g. "9:00")
    if (value.length === 4) {
        const padded = "0" + value;
        const [h, m] = padded.split(":").map(Number);
        if (!isNaN(h) && !isNaN(m)) return { h, m, s: 0 };
    }

    return null;
}

// Convert parsed time to minutes for easy comparison
function toMinutes(t) {
    return t.h * 60 + t.m;
}

// ----------------------------------------------------
// 2. has_time_conflict (POSTGRES VERSION)
// ----------------------------------------------------
async function hasTimeConflict(teamMemberId, startDate, endDate, startTime, endTime) {
    const query = `
        SELECT start_date, end_date, start_time, end_time
        FROM assignments
        WHERE user_id = $1
          AND start_date <= $2
          AND (end_date IS NULL OR end_date >= $3)
    `;

    const result = await db.query(query, [teamMemberId, endDate, startDate]);
    const rows = result.rows;

    const conflicts = [];

    for (const row of rows) {
        const sTimeObj = parseTime(row.start_time);
        const eTimeObj = parseTime(row.end_time);

        if (!sTimeObj || !eTimeObj) continue;

        const existingStart = toMinutes(sTimeObj);
        const existingEnd = toMinutes(eTimeObj);

        const newStart = toMinutes(startTime);
        const newEnd = toMinutes(endTime);

        if (newStart < existingEnd && newEnd > existingStart) {
            conflicts.push(`${row.start_date} ${row.start_time}–${row.end_time}`);
        }
    }

    if (conflicts.length > 0) {
        return { conflict: true, details: conflicts.join("; ") };
    }

    return { conflict: false, details: "" };
}

// ----------------------------------------------------
// 3. exceeds_weekly_capacity (POSTGRES VERSION)
// ----------------------------------------------------
async function exceedsWeeklyCapacity(
    teamMemberId,
    startDate,
    endDate,
    newHoursPerWeek,
    weeklyCapacity = 40
) {
    const query = `
        SELECT hours_per_week
        FROM assignments
        WHERE user_id = $1
          AND start_date <= $2
          AND (end_date IS NULL OR end_date >= $3)
    `;

    const result = await db.query(query, [teamMemberId, endDate, startDate]);
    const rows = result.rows;

    const existingTotal = rows.reduce((sum, row) => sum + row.hours_per_week, 0);
    const total = existingTotal + newHoursPerWeek;

    if (total > weeklyCapacity) {
        return { exceeds: true, total };
    }

    return { exceeds: false, total };
}

module.exports = {
    parseTime,
    hasTimeConflict,
    exceedsWeeklyCapacity
};
