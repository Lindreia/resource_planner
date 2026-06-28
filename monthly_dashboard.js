const { getConnection } = require("../database");
const db = getConnection();

// Helper: get Monday of a given date
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sunday
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
}

// Helper: generate all weeks between two dates
function generateWeeks(startDate, endDate) {
    const weeks = [];
    let current = getWeekStart(startDate);

    while (current <= endDate) {
        weeks.push(current.toISOString().slice(0, 10));
        current = new Date(current);
        current.setDate(current.getDate() + 7);
    }

    return weeks;
}

async function getMonthlyDashboard(monthStart, monthEnd) {
    const start = new Date(monthStart);
    const end = new Date(monthEnd);

    // ----------------------------------------------------
    // 1. GET ALL WEEKS IN THE MONTH
    // ----------------------------------------------------
    const weeks = generateWeeks(start, end);

    // ----------------------------------------------------
    // 2. MONTHLY UTILIZATION PER TEAM MEMBER
    // ----------------------------------------------------
    const membersQuery = `
        SELECT id, name, weekly_capacity
        FROM users
        ORDER BY name;
    `;

    const membersResult = await db.query(membersQuery);
    const members = membersResult.rows;

    const monthly = [];

    for (const member of members) {
        const allocQuery = `
            SELECT SUM(hours_per_week) AS allocated
            FROM assignments
            WHERE user_id = $1
              AND start_date <= $2
              AND (end_date IS NULL OR end_date >= $3)
        `;

        const allocResult = await db.query(allocQuery, [
            member.id,
            monthEnd,
            monthStart
        ]);

        const allocated = allocResult.rows[0].allocated || 0;

        const util =
            member.weekly_capacity > 0
                ? Math.round((allocated / member.weekly_capacity) * 1000) / 10
                : 0;

        monthly.push({
            name: member.name,
            capacity: member.weekly_capacity,
            allocated,
            util
        });
    }

    // ----------------------------------------------------
    // 3. LEGEND (PROJECT LIST)
    // ----------------------------------------------------
    const legendQuery = `
        SELECT DISTINCT p.id, p.project_name
        FROM projects p
        JOIN assignments a ON a.project_id = p.id
        WHERE a.start_date <= $1
          AND (a.end_date IS NULL OR a.end_date >= $2)
        ORDER BY p.project_name;
    `;

    const legendResult = await db.query(legendQuery, [monthEnd, monthStart]);

    const legend = legendResult.rows.map(row => ({
        id: row.id,
        name: row.project_name
    }));

    return { weeks, monthly, legend };
}

module.exports = { getMonthlyDashboard };
