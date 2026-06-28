const { getConnection } = require("../database");
const db = getConnection();
const { DateTime } = require("luxon");

async function getDailyDashboard(dateStr) {
    // ----------------------------------------------------
    // 1. Parse target date
    // ----------------------------------------------------
    const targetDate = DateTime.fromISO(dateStr).toJSDate();

    const jsDate = new Date(targetDate);

    // Compute week start (Monday)
    const weekStart = new Date(jsDate);
    weekStart.setDate(jsDate.getDate() - jsDate.getDay() + 1);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const weekLabel = `${weekStart.toISOString().slice(0, 10)} → ${weekEnd
        .toISOString()
        .slice(0, 10)}`;

    // Build list of days for UI
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + i);
        days.push(d.toISOString().slice(0, 10));
    }

    // ----------------------------------------------------
    // 2. Get team members (users)
    // ----------------------------------------------------
    const membersQuery = `
        SELECT id, name, weekly_capacity
        FROM users
        ORDER BY name;
    `;

    const membersResult = await db.query(membersQuery);
    const members = membersResult.rows;

    // ----------------------------------------------------
    // 3. Compute daily allocation for each member
    // ----------------------------------------------------
    const daily = [];

    for (const member of members) {
        const allocQuery = `
            SELECT SUM(hours_per_week) AS total
            FROM assignments
            WHERE user_id = $1
              AND start_date <= $2
              AND (end_date IS NULL OR end_date >= $3)
        `;

        const allocResult = await db.query(allocQuery, [
            member.id,
            dateStr,
            dateStr
        ]);

        const total = allocResult.rows[0].total || 0;

        const util =
            member.weekly_capacity > 0
                ? Math.round((total / member.weekly_capacity) * 100) / 100
                : 0;

        daily.push({
            name: member.name,
            total,
            capacity: member.weekly_capacity,
            util
        });
    }

    return {
        week_start: weekStart.toISOString().slice(0, 10),
        week_label: weekLabel,
        days,
        daily
    };
}

module.exports = { getDailyDashboard };
