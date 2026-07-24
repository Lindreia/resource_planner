const express = require("express");
const router = express.Router();
const { getConnection } = require("./database");
const bcrypt = require("bcryptjs");
const PDFDocument = require("pdfkit");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");

const db = getConnection();

async function resolveVisibleUserIds(user) {
    const role = String(user?.role || "").toLowerCase();
    const userId = Number(user?.id);

    if (!Number.isInteger(userId)) return [];

    if (role === "admin" || role === "viewer") {
        return null;
    }

    if (role === "staff" || role === "client") {
        return [userId];
    }

    if (role === "manager") {
        const teamMembers = await db.query(
            `SELECT DISTINCT tm_member.user_id
             FROM team_members tm_manager
             JOIN team_members tm_member ON tm_member.team_name = tm_manager.team_name
             WHERE tm_manager.user_id = $1`,
            [userId]
        );

        const ids = teamMembers.rows
            .map(row => Number(row.user_id))
            .filter(Number.isInteger);

        if (!ids.includes(userId)) ids.push(userId);
        return ids.length > 0 ? ids : [userId];
    }

    return [userId];
}

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
    if (!value) return [1, 2, 3, 4, 5];

    return String(value)
        .split(",")
        .map((v) => v.trim())
        .map((name) => WEEKDAY_TO_INDEX[name])
        .filter((day, idx, arr) => Number.isInteger(day) && arr.indexOf(day) === idx)
        .sort((a, b) => a - b);
}

function toDayStart(dateLike) {
    const d = new Date(dateLike);
    d.setHours(0, 0, 0, 0);
    return d;
}

function toIsoDate(dateLike) {
    return toDayStart(dateLike).toISOString().slice(0, 10);
}

function clampRange(startDate, endDate, periodStart, periodEnd) {
    const actualStart = toDayStart(startDate);
    const assignmentEnd = endDate ? toDayStart(endDate) : toDayStart(periodEnd);
    const actualEnd = assignmentEnd > toDayStart(periodEnd) ? toDayStart(periodEnd) : assignmentEnd;
    const clampedStart = actualStart < toDayStart(periodStart) ? toDayStart(periodStart) : actualStart;

    if (clampedEndBeforeStart(clampedStart, actualEnd)) {
        return null;
    }

    return { start: clampedStart, end: actualEnd };
}

function clampedEndBeforeStart(start, end) {
    return end < start;
}

function countWorkingDaysBetween(startDate, endDate, workingDays) {
    if (!startDate || !endDate) return 0;

    const daySet = new Set(workingDays);
    let count = 0;
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const jsDay = d.getDay();
        const isoDay = jsDay === 0 ? 7 : jsDay;
        if (daySet.has(isoDay)) {
            count += 1;
        }
    }

    return count;
}

function assignmentDailyHours(row) {
    const explicitDaily = Number(row.hours_per_day);
    if (Number.isFinite(explicitDaily) && explicitDaily > 0) {
        return explicitDaily;
    }

    const weekly = Number(row.hours_per_week) || 0;
    const workDays = Math.max(Number(row.work_days) || 0, 1);
    return weekly > 0 ? weekly / workDays : 0;
}

function assignmentHoursForPeriod(row, periodStart, periodEnd, workingDays) {
    const overlap = clampRange(row.start_date, row.end_date, periodStart, periodEnd);
    if (!overlap) return 0;

    const dailyHours = assignmentDailyHours(row);
    const dayCount = countWorkingDaysBetween(overlap.start, overlap.end, workingDays);
    return dailyHours * dayCount;
}

function assignmentAppliesOnDate(row, date, workingDays) {
    const day = toDayStart(date);
    const start = toDayStart(row.start_date);
    const end = row.end_date ? toDayStart(row.end_date) : day;

    if (day < start || day > end) return false;

    const isoDay = day.getDay() === 0 ? 7 : day.getDay();
    return new Set(workingDays).has(isoDay);
}

async function loadScopedUsers(scopedUserIds) {
    const userParams = [];
    let userWhere = "";
    if (scopedUserIds) {
        userParams.push(scopedUserIds);
        userWhere = "WHERE id = ANY($1::int[])";
    }

    return (await db.query(
        `SELECT id, name, weekly_capacity, working_days
         FROM users
         ${userWhere}
         ORDER BY name`,
        userParams
    )).rows;
}

async function loadScopedAssignments(scopedUserIds, periodStartIso, periodEndIso) {
    const assignmentParams = [periodEndIso, periodStartIso];
    let assignmentFilter = "";
    if (scopedUserIds) {
        assignmentParams.push(scopedUserIds);
        assignmentFilter = "AND a.user_id = ANY($3::int[])";
    }

    return (await db.query(
        `SELECT a.user_id, a.project_id, a.start_date, a.end_date, a.work_days, a.hours_per_week, a.hours_per_day,
                a.start_time, a.end_time, p.project_code, p.project_name, p.color
         FROM assignments a
         JOIN projects p ON p.id = a.project_id
         WHERE a.start_date <= $1
           AND (a.end_date IS NULL OR a.end_date >= $2)
           ${assignmentFilter}`,
        assignmentParams
    )).rows;
}

async function buildWeeklyTeamSnapshot(scopedUserIds, weekStart, weekEnd) {
    const users = await loadScopedUsers(scopedUserIds);
    const assignments = await loadScopedAssignments(scopedUserIds, toIsoDate(weekStart), toIsoDate(weekEnd));

    const userConfigs = new Map();
    users.forEach((u) => {
        userConfigs.set(Number(u.id), {
            name: u.name,
            weekly_capacity: Number(u.weekly_capacity) || 0,
            workingDays: parseWorkingDays(u.working_days)
        });
    });

    const allocatedByUser = new Map();
    assignments.forEach((a) => {
        const config = userConfigs.get(Number(a.user_id));
        if (!config) return;

        const hours = assignmentHoursForPeriod(a, weekStart, weekEnd, config.workingDays);
        if (hours <= 0) return;

        allocatedByUser.set(Number(a.user_id), (allocatedByUser.get(Number(a.user_id)) || 0) + hours);
    });

    return users.map((u) => {
        const capacity = Number(u.weekly_capacity) || 0;
        const allocated = Number((allocatedByUser.get(Number(u.id)) || 0).toFixed(2));
        const available = Number((capacity - allocated).toFixed(2));
        return {
            name: u.name,
            capacity,
            allocated,
            available
        };
    });
}

async function buildDailyAssignmentRows(scopedUserIds, selectedDate) {
    const dayIso = toIsoDate(selectedDate);
    const users = await loadScopedUsers(scopedUserIds);
    const assignments = await loadScopedAssignments(scopedUserIds, dayIso, dayIso);

    const rows = [];
    const usersById = new Map();
    users.forEach((u) => {
        usersById.set(Number(u.id), {
            name: u.name,
            workingDays: parseWorkingDays(u.working_days)
        });
    });

    assignments.forEach((a) => {
        const user = usersById.get(Number(a.user_id));
        if (!user) return;
        if (!assignmentAppliesOnDate(a, selectedDate, user.workingDays)) return;

        const hours = Number(assignmentDailyHours(a).toFixed(2));
        if (hours <= 0) return;

        rows.push({
            user_name: user.name,
            project_code: a.project_code,
            project_name: a.project_name,
            hours
        });
    });

    rows.sort((a, b) => {
        if (a.user_name !== b.user_name) return a.user_name.localeCompare(b.user_name);
        return a.project_code.localeCompare(b.project_code);
    });

    return rows;
}

async function buildMonthlySummary(scopedUserIds, monthStart, monthEnd) {
    const users = await loadScopedUsers(scopedUserIds);
    const assignments = await loadScopedAssignments(scopedUserIds, toIsoDate(monthStart), toIsoDate(monthEnd));

    const userWorkingDays = new Map();
    users.forEach((u) => {
        userWorkingDays.set(Number(u.id), parseWorkingDays(u.working_days));
    });

    const summaryMap = new Map();
    assignments.forEach((a) => {
        const workingDays = userWorkingDays.get(Number(a.user_id));
        if (!workingDays || workingDays.length === 0) return;

        const hours = assignmentHoursForPeriod(a, monthStart, monthEnd, workingDays);
        if (hours <= 0) return;

        if (!summaryMap.has(a.project_code)) {
            summaryMap.set(a.project_code, {
                code: a.project_code,
                name: a.project_name,
                color: a.color,
                hours: 0
            });
        }

        summaryMap.get(a.project_code).hours += hours;
    });

    return Array.from(summaryMap.values())
        .map((p) => ({ ...p, hours: Number(p.hours.toFixed(2)) }))
        .sort((a, b) => a.code.localeCompare(b.code));
}

function csvEscape(value) {
    const str = value === null || value === undefined ? "" : String(value);
    if (str.includes(",") || str.includes("\n") || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function buildCsv(headers, rows) {
    const headerLine = headers.map(csvEscape).join(",");
    const lines = rows.map(row => row.map(csvEscape).join(","));
    return [headerLine, ...lines].join("\n");
}

function startPdf(res, filename, title) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);
    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown(0.7);
    return doc;
}

// -----------------------------------------
// PAGE ROUTES (EJS templates)
// -----------------------------------------
router.get("/", requireLogin, (req, res) => {
    // Reuse the full weekly data route so template vars are always populated.
    res.redirect("/weekly");
});

router.get("/weekly", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const offset = Number(req.query.week_offset || 0);
        const today = new Date();
        const monday = new Date(today);
        monday.setDate(today.getDate() - today.getDay() + 1 + offset * 7);

        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const startISO = toIsoDate(monday);
        const endISO = toIsoDate(sunday);

        const userParams = [];
        let userWhere = "";
        if (scopedUserIds) {
            userParams.push(scopedUserIds);
            userWhere = "WHERE u.id = ANY($1::int[])";
        }

        const users = (await db.query(
            `SELECT u.id, u.name, u.weekly_capacity, u.working_days
             FROM users u
             ${userWhere}
             ORDER BY u.name`,
            userParams
        )).rows;

        const assignmentParams = [endISO, startISO];
        let assignmentUserFilter = "";
        if (scopedUserIds) {
            assignmentParams.push(scopedUserIds);
            assignmentUserFilter = "AND a.user_id = ANY($3::int[])";
        }

        const assignments = (await db.query(
            `SELECT a.user_id, a.project_id, a.start_date, a.end_date, a.work_days, a.hours_per_week, a.hours_per_day,
                    p.project_code, p.project_name, p.color
             FROM assignments a
             JOIN projects p ON p.id = a.project_id
             WHERE a.start_date <= $1
               AND (a.end_date IS NULL OR a.end_date >= $2)
               ${assignmentUserFilter}`,
            assignmentParams
        )).rows;

        const userConfigs = new Map();
        users.forEach((u) => {
            userConfigs.set(Number(u.id), {
                name: u.name,
                weekly_capacity: Number(u.weekly_capacity) || 0,
                workingDays: parseWorkingDays(u.working_days)
            });
        });

        const allocatedByUser = new Map();
        const projectStats = new Map();

        assignments.forEach((a) => {
            const config = userConfigs.get(Number(a.user_id));
            if (!config) return;

            const hours = assignmentHoursForPeriod(a, monday, sunday, config.workingDays);
            if (hours <= 0) return;

            allocatedByUser.set(Number(a.user_id), (allocatedByUser.get(Number(a.user_id)) || 0) + hours);

            if (!projectStats.has(Number(a.project_id))) {
                projectStats.set(Number(a.project_id), {
                    code: a.project_code,
                    name: a.project_name,
                    color: a.color,
                    hours: 0,
                    members: new Set()
                });
            }

            const project = projectStats.get(Number(a.project_id));
            project.hours += hours;
            project.members.add(Number(a.user_id));
        });

        const team = users.map((u) => {
            const allocated = Number((allocatedByUser.get(Number(u.id)) || 0).toFixed(2));
            const capacity = Number(u.weekly_capacity) || 0;
            const available = Number((capacity - allocated).toFixed(2));
            const util = capacity === 0 ? 0 : Math.round((allocated / capacity) * 100);

            return {
                name: u.name,
                capacity,
                allocated,
                available,
                util
            };
        });

        const projects = Array.from(projectStats.values())
            .map((p) => ({
                code: p.code,
                name: p.name,
                hours: Number(p.hours.toFixed(2)),
                members: p.members.size,
                color: p.color
            }))
            .sort((a, b) => a.code.localeCompare(b.code));

        const totalCapacity = team.reduce((s, r) => s + Number(r.capacity), 0);
        const totalAllocated = team.reduce((s, r) => s + Number(r.allocated), 0);
        const totalAvailable = team.reduce((s, r) => s + Number(r.available), 0);
        const overbookedCount = team.filter(r => Number(r.allocated) > Number(r.capacity)).length;

        const stats_cards = [
            { label: "Team Members", value: team.length },
            { label: "Total Capacity", value: totalCapacity },
            { label: "Total Allocated", value: totalAllocated },
            { label: "Total Available", value: totalAvailable },
            { label: "Overbooked", value: overbookedCount }
        ];

        res.render("weekly", {
            user: req.session.user,
            week_label: `${startISO} -> ${endISO}`,
            prev_week: offset - 1,
            next_week: offset + 1,
            stats_cards,
            team,
            projects
        });
    } catch (err) {
        console.error("Weekly dashboard error:", err);
        res.status(500).send("Server error");
    }
});

router.get("/daily", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const selected = req.query.date ? new Date(req.query.date) : new Date();
        const dayISO = toIsoDate(selected);

        const usersParams = [];
        let usersWhere = "";
        if (scopedUserIds) {
            usersParams.push(scopedUserIds);
            usersWhere = "WHERE id = ANY($1::int[])";
        }

        const users = (await db.query(
            `SELECT id, name, working_days
             FROM users
             ${usersWhere}
             ORDER BY name`,
            usersParams
        )).rows;

        const assignmentParams = [dayISO, dayISO];
        let assignmentFilter = "";
        if (scopedUserIds) {
            assignmentParams.push(scopedUserIds);
            assignmentFilter = "AND a.user_id = ANY($3::int[])";
        }

        const assignments = (await db.query(
            `SELECT a.user_id, a.start_date, a.end_date, a.work_days, a.hours_per_week, a.hours_per_day, a.start_time, a.end_time,
                    p.project_code, p.project_name, p.color
             FROM assignments a
             JOIN projects p ON p.id = a.project_id
             WHERE a.start_date <= $1
               AND (a.end_date IS NULL OR a.end_date >= $2)
               ${assignmentFilter}
             ORDER BY p.project_code`,
            assignmentParams
        )).rows;

        const byUserId = new Map();
        users.forEach((u) => {
            byUserId.set(Number(u.id), {
                name: u.name,
                workingDays: parseWorkingDays(u.working_days),
                total: 0,
                items: []
            });
        });

        assignments.forEach((a) => {
            const user = byUserId.get(Number(a.user_id));
            if (!user) return;
            if (!assignmentAppliesOnDate(a, selected, user.workingDays)) return;

            const hours = Number(assignmentDailyHours(a).toFixed(2));
            if (hours <= 0) return;

            user.total += hours;
            user.items.push({
                project_code: a.project_code,
                project_name: a.project_name,
                color: a.color,
                hours,
                time: a.start_time && a.end_time ? `${a.start_time}-${a.end_time}` : null
            });
        });

        const byUserMap = new Map();
        byUserId.forEach((value) => {
            if (value.items.length === 0) return;
            byUserMap.set(value.name, {
                name: value.name,
                total: Number(value.total.toFixed(2)),
                items: value.items
            });
        });

        res.render("daily", {
            user: req.session.user,
            selected_date: dayISO,
            previous_date: new Date(selected.getTime() - 86400000).toISOString().slice(0, 10),
            next_date: new Date(selected.getTime() + 86400000).toISOString().slice(0, 10),
            by_user: Array.from(byUserMap.values())
        });
    } catch (err) {
        console.error("Daily planner error:", err);
        res.status(500).send("Server error");
    }
});

router.get("/monthly", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const now = new Date();
        const selected = req.query.start
            ? new Date(req.query.start)
            : new Date(now.getFullYear(), now.getMonth(), 1);

        const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
        const monthEnd = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);

        const startISO = toIsoDate(monthStart);
        const endISO = toIsoDate(monthEnd);

        const userParams = [];
        let userWhere = "";
        if (scopedUserIds) {
            userParams.push(scopedUserIds);
            userWhere = "WHERE id = ANY($1::int[])";
        }

        const users = (await db.query(
            `SELECT id, working_days
             FROM users
             ${userWhere}`,
            userParams
        )).rows;

        const userWorkingDays = new Map();
        users.forEach((u) => {
            userWorkingDays.set(Number(u.id), parseWorkingDays(u.working_days));
        });

        const monthlyParams = [endISO, startISO];
        let assignmentFilter = "";
        if (scopedUserIds) {
            monthlyParams.push(scopedUserIds);
            assignmentFilter = "AND a.user_id = ANY($3::int[])";
        }

        const assignments = (await db.query(
            `SELECT a.user_id, a.start_date, a.end_date, a.work_days, a.hours_per_week, a.hours_per_day,
                    p.project_code, p.project_name, p.color
             FROM assignments a
             JOIN projects p ON p.id = a.project_id
             WHERE a.start_date <= $1
               AND (a.end_date IS NULL OR a.end_date >= $2)
               ${assignmentFilter}`,
            monthlyParams
        )).rows;

        const summaryMap = new Map();
        assignments.forEach((a) => {
            const workingDays = userWorkingDays.get(Number(a.user_id));
            if (!workingDays || workingDays.length === 0) return;

            const hours = assignmentHoursForPeriod(a, monthStart, monthEnd, workingDays);
            if (hours <= 0) return;

            if (!summaryMap.has(a.project_code)) {
                summaryMap.set(a.project_code, {
                    code: a.project_code,
                    name: a.project_name,
                    color: a.color,
                    hours: 0
                });
            }

            summaryMap.get(a.project_code).hours += hours;
        });

        const summary = Array.from(summaryMap.values())
            .map((p) => ({
                ...p,
                hours: Number(p.hours.toFixed(2))
            }))
            .sort((a, b) => a.code.localeCompare(b.code));

        const totalHours = summary.reduce((s, p) => s + p.hours, 0);

        const prev = new Date(selected.getFullYear(), selected.getMonth() - 1, 1).toISOString().slice(0, 10);
        const next = new Date(selected.getFullYear(), selected.getMonth() + 1, 1).toISOString().slice(0, 10);

        res.render("monthly", {
            user: req.session.user,
            month_label: monthStart.toLocaleDateString("en-NZ", { month: "long", year: "numeric" }),
            month_start: startISO,
            month_end: endISO,
            prev_start: prev,
            next_start: next,
            total_hours: totalHours,
            summary
        });
    } catch (err) {
        console.error("Monthly planner error:", err);
        res.status(500).send("Server error");
    }
});

router.get("/exports/weekly.csv", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const offset = Number(req.query.week_offset || 0);

        const today = new Date();
        const monday = new Date(today);
        monday.setDate(today.getDate() - today.getDay() + 1 + offset * 7);

        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const startISO = toIsoDate(monday);
        const endISO = toIsoDate(sunday);
        const team = await buildWeeklyTeamSnapshot(scopedUserIds, monday, sunday);
        const rows = team.map(t => [
            startISO,
            endISO,
            t.name,
            Number(t.capacity) || 0,
            Number(t.allocated) || 0,
            Number(t.available) || 0
        ]);

        const csv = buildCsv(
            ["week_start", "week_end", "team_member", "capacity", "allocated", "available"],
            rows
        );

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=weekly-${startISO}.csv`);
        return res.send(csv);
    } catch (err) {
        console.error("Weekly CSV export error:", err);
        return res.status(500).send("Failed to export weekly CSV");
    }
});

router.get("/exports/weekly.pdf", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const offset = Number(req.query.week_offset || 0);

        const today = new Date();
        const monday = new Date(today);
        monday.setDate(today.getDate() - today.getDay() + 1 + offset * 7);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const startISO = toIsoDate(monday);
        const endISO = toIsoDate(sunday);
        const team = await buildWeeklyTeamSnapshot(scopedUserIds, monday, sunday);

        const doc = startPdf(res, `weekly-${startISO}.pdf`, `Weekly Dashboard Export (${startISO} to ${endISO})`);
        doc.fontSize(11).text("Team Member | Capacity | Allocated | Available");
        doc.moveDown(0.4);

        team.forEach((t) => {
            const capacity = Number(t.capacity) || 0;
            const allocated = Number(t.allocated) || 0;
            const available = Number(t.available) || 0;
            doc.text(`${t.name} | ${capacity} | ${allocated} | ${available}`);
        });

        doc.end();
    } catch (err) {
        console.error("Weekly PDF export error:", err);
        res.status(500).send("Failed to export weekly PDF");
    }
});

router.get("/exports/daily.csv", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const selected = req.query.date ? new Date(req.query.date) : new Date();
        const dayISO = toIsoDate(selected);
        const rowsResult = await buildDailyAssignmentRows(scopedUserIds, selected);

        const rows = rowsResult.map(r => [dayISO, r.user_name, r.project_code, r.project_name, Number(r.hours) || 0]);
        const csv = buildCsv(["date", "team_member", "project_code", "project_name", "hours"], rows);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=daily-${dayISO}.csv`);
        return res.send(csv);
    } catch (err) {
        console.error("Daily CSV export error:", err);
        return res.status(500).send("Failed to export daily CSV");
    }
});

router.get("/exports/daily.pdf", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const selected = req.query.date ? new Date(req.query.date) : new Date();
        const dayISO = toIsoDate(selected);
        const rows = await buildDailyAssignmentRows(scopedUserIds, selected);

        const doc = startPdf(res, `daily-${dayISO}.pdf`, `Daily Dashboard Export (${dayISO})`);
        doc.fontSize(11).text("Team Member | Project | Hours");
        doc.moveDown(0.4);
        rows.forEach((r) => doc.text(`${r.user_name} | ${r.project_code} - ${r.project_name} | ${Number(r.hours) || 0}`));
        doc.end();
    } catch (err) {
        console.error("Daily PDF export error:", err);
        res.status(500).send("Failed to export daily PDF");
    }
});

router.get("/exports/monthly.csv", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const now = new Date();
        const selected = req.query.start
            ? new Date(req.query.start)
            : new Date(now.getFullYear(), now.getMonth(), 1);

        const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
        const monthEnd = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
        const startISO = toIsoDate(monthStart);
        const endISO = toIsoDate(monthEnd);

        const summary = await buildMonthlySummary(scopedUserIds, monthStart, monthEnd);
        const rows = summary.map(s => [startISO, endISO, s.code, s.name, Number(s.hours) || 0]);
        const csv = buildCsv(["month_start", "month_end", "project_code", "project_name", "total_hours"], rows);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=monthly-${startISO}.csv`);
        return res.send(csv);
    } catch (err) {
        console.error("Monthly CSV export error:", err);
        return res.status(500).send("Failed to export monthly CSV");
    }
});

router.get("/exports/monthly.pdf", requireLogin, async (req, res) => {
    try {
        const scopedUserIds = await resolveVisibleUserIds(req.session.user);
        const now = new Date();
        const selected = req.query.start
            ? new Date(req.query.start)
            : new Date(now.getFullYear(), now.getMonth(), 1);

        const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
        const monthEnd = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
        const startISO = toIsoDate(monthStart);
        const endISO = toIsoDate(monthEnd);
        const summary = await buildMonthlySummary(scopedUserIds, monthStart, monthEnd);

        const doc = startPdf(res, `monthly-${startISO}.pdf`, `Monthly Dashboard Export (${startISO} to ${endISO})`);
        doc.fontSize(11).text("Project | Total Hours");
        doc.moveDown(0.4);
        summary.forEach((s) => doc.text(`${s.code} - ${s.name} | ${Number(s.hours) || 0}`));
        doc.end();
    } catch (err) {
        console.error("Monthly PDF export error:", err);
        res.status(500).send("Failed to export monthly PDF");
    }
});

router.get("/resources", requireLogin, requireRole("admin", "manager"), (req, res) => {
    res.redirect("/assignments/add");
});

// -----------------------------------------
// LOGIN PAGE
// -----------------------------------------
router.get("/login", (req, res) => {
    res.render("login", { error: null });
});

// -----------------------------------------
// LOGIN SUBMIT (POSTGRES VERSION)
// -----------------------------------------
router.post("/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await db.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            return res.render("login", { error: "Invalid email or password" });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.render("login", { error: "Invalid email or password" });
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            role: user.role,
            email: user.email
        };

        res.redirect("/weekly");

    } catch (err) {
        console.error("Login error:", err);
        res.render("login", { error: "Server error" });
    }
});

// -----------------------------------------
// LOGOUT
// -----------------------------------------
router.get("/logout", requireLogin, (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

// -----------------------------------------
// DASHBOARD API (Admin + Manager + Staff)
// -----------------------------------------
router.get(
    "/dashboard",
    requireLogin,
    requireRole("admin", "manager", "staff", "viewer", "client"),
    async (req, res) => {
        try {
            const weekStartStr = req.query.start || "2026-05-19";
            const weekStart = new Date(weekStartStr);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6);

            const startISO = weekStart.toISOString().slice(0, 10);
            const endISO = weekEnd.toISOString().slice(0, 10);

            // -----------------------------------------
            // TEAM UTILISATION
            // -----------------------------------------
            const teamQuery = `
                SELECT 
                    u.name,
                    u.weekly_capacity,
                    COALESCE(SUM(a.hours_per_week), 0) AS allocated
                FROM users u
                LEFT JOIN assignments a
                    ON a.user_id = u.id
                   AND a.start_date <= $1
                   AND (a.end_date IS NULL OR a.end_date >= $2)
                GROUP BY u.name, u.weekly_capacity
                ORDER BY u.name;
            `;

            const teamResult = await db.query(teamQuery, [endISO, startISO]);

            const team = teamResult.rows.map(row => {
                const available = Math.max(row.weekly_capacity - row.allocated, 0);
                const util = row.weekly_capacity === 0
                    ? 0
                    : Math.round((row.allocated / row.weekly_capacity) * 100);

                return {
                    name: row.name,
                    capacity: row.weekly_capacity,
                    allocated: row.allocated,
                    available,
                    util
                };
            });

            // -----------------------------------------
            // PROJECT HOURS
            // -----------------------------------------
            const projectQuery = `
                SELECT 
                    p.project_code,
                    p.project_name,
                    COALESCE(SUM(a.hours_per_week), 0) AS total_hours
                FROM projects p
                LEFT JOIN assignments a
                    ON a.project_id = p.id
                   AND a.start_date <= $1
                   AND (a.end_date IS NULL OR a.end_date >= $2)
                GROUP BY p.project_code, p.project_name
                ORDER BY p.project_code;
            `;

            const projectResult = await db.query(projectQuery, [endISO, startISO]);

            const projects = projectResult.rows.map(row => ({
                code: row.project_code,
                name: row.project_name,
                hours: row.total_hours
            }));

            // -----------------------------------------
            // STATS
            // -----------------------------------------
            const totalCapacity = team.reduce((s, r) => s + r.capacity, 0);
            const totalAllocated = team.reduce((s, r) => s + r.allocated, 0);
            const totalAvailable = team.reduce((s, r) => s + r.available, 0);
            const overbookedCount = team.filter(r => r.allocated > r.capacity).length;

            const statsCards = [
                { label: "Team Members", value: team.length },
                { label: "Total Capacity", value: totalCapacity },
                { label: "Total Allocated", value: totalAllocated },
                { label: "Total Available", value: totalAvailable },
                { label: "Overbooked", value: overbookedCount, danger: overbookedCount > 0 }
            ];

            res.json({
                week_start: startISO,
                week_end: endISO,
                team,
                projects,
                stats_cards: statsCards
            });

        } catch (err) {
            console.error("Dashboard error:", err);
            res.status(500).json({ error: "Server error" });
        }
    }
);

module.exports = router;
