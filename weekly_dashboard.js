const { getConnection } = require("../database");
const db = getConnection();

async function getWeeklyDashboard(weekStart, weekEnd) {
    // ----------------------------------------------------
    // 1. TEAM MEMBERS + UTILIZATION
    // ----------------------------------------------------
    const membersQuery = `
        SELECT id, name, weekly_capacity
        FROM users
        ORDER BY name;
    `;

    const membersResult = await db.query(membersQuery);
    const members = membersResult.rows;

    const team = [];

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
            weekEnd,
            weekStart
        ]);

        const allocated = allocResult.rows[0].allocated || 0;
        const available = member.weekly_capacity - allocated;

        const util =
            member.weekly_capacity > 0
                ? Math.round((allocated / member.weekly_capacity) * 1000) / 10
                : 0;

        team.push({
            name: member.name,
            capacity: member.weekly_capacity,
            allocated,
            available,
            util
        });
    }

    // ----------------------------------------------------
    // 2. PROJECT LIST
    // ----------------------------------------------------
    const projectQuery = `
        SELECT DISTINCT p.id, p.project_name
        FROM projects p
        JOIN assignments a ON a.project_id = p.id
        WHERE a.start_date <= $1
          AND (a.end_date IS NULL OR a.end_date >= $2)
        ORDER BY p.project_name;
    `;

    const projectResult = await db.query(projectQuery, [weekEnd, weekStart]);
    const projectRows = projectResult.rows;

    const projects = [];

    for (const project of projectRows) {
        const peopleQuery = `
            SELECT u.name
            FROM users u
            JOIN assignments a ON a.user_id = u.id
            WHERE a.project_id = $1
              AND a.start_date <= $2
              AND (a.end_date IS NULL OR a.end_date >= $3)
            ORDER BY u.name;
        `;

        const peopleResult = await db.query(peopleQuery, [
            project.id,
            weekEnd,
            weekStart
        ]);

        projects.push({
            name: project.project_name,
            people: peopleResult.rows.map(p => p.name)
        });
    }

    // ----------------------------------------------------
    // 3. STATS CARDS
    // ----------------------------------------------------
    const totalCapacity = team.reduce((sum, m) => sum + m.capacity, 0);
    const totalAllocated = team.reduce((sum, m) => sum + m.allocated, 0);

    const avgUtil =
        totalCapacity > 0
            ? Math.round((totalAllocated / totalCapacity) * 1000) / 10
            : 0;

    const statsCards = {
        total_capacity: totalCapacity,
        total_allocated: totalAllocated,
        avg_util: avgUtil,
        active_projects: projects.length
    };

    return { statsCards, team, projects };
}

module.exports = { getWeeklyDashboard };
