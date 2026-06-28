const { getConnection } = require("../database");
const db = getConnection();

const {
    hasTimeConflict,
    exceedsWeeklyCapacity,
    parseTime
} = require("./booking_rules");

// Convert "HH:MM" → {h, m, s}
function parseTimeString(str) {
    const [h, m] = str.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    return { h, m, s: 0 };
}

async function makeBooking(
    userId,
    projectId,
    startDate,
    endDate,
    hoursPerWeek,
    workDays,
    startTime,
    endTime,
    requestedBy
) {
    // ----------------------------------------------------
    // 1. Parse dates and times
    // ----------------------------------------------------
    const startDateObj = new Date(startDate);
    const endDateObj = new Date(endDate);

    if (isNaN(startDateObj) || isNaN(endDateObj)) {
        return { success: false, message: "Invalid date format." };
    }

    const startTimeObj = parseTimeString(startTime);
    const endTimeObj = parseTimeString(endTime);

    if (!startTimeObj || !endTimeObj) {
        return { success: false, message: "Invalid time format." };
    }

    if (endDateObj < startDateObj) {
        return { success: false, message: "End date cannot be before start date." };
    }

    const startMinutes = startTimeObj.h * 60 + startTimeObj.m;
    const endMinutes = endTimeObj.h * 60 + endTimeObj.m;

    if (endMinutes <= startMinutes) {
        return { success: false, message: "End time must be after start time." };
    }

    // ----------------------------------------------------
    // 2. Time conflict check (async)
    // ----------------------------------------------------
    const conflictCheck = await hasTimeConflict(
        userId,
        startDate,
        endDate,
        startTimeObj,
        endTimeObj
    );

    if (conflictCheck.conflict) {
        return {
            success: false,
            message: `Time conflict with existing booking(s): ${conflictCheck.details}`
        };
    }

    // ----------------------------------------------------
    // 3. Weekly capacity check (async)
    // ----------------------------------------------------
    const capacityCheck = await exceedsWeeklyCapacity(
        userId,
        startDate,
        endDate,
        hoursPerWeek
    );

    if (capacityCheck.exceeds) {
        return {
            success: false,
            message: `Weekly capacity exceeded. Total would be ${capacityCheck.total} hours.`
        };
    }

    // ----------------------------------------------------
    // 4. Insert booking (POSTGRES)
    // ----------------------------------------------------
    const insertQuery = `
        INSERT INTO assignments (
            user_id,
            project_id,
            start_date,
            end_date,
            hours_per_week,
            work_days,
            start_time,
            end_time,
            requested_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;

    try {
        await db.query(insertQuery, [
            userId,
            projectId,
            startDate,
            endDate,
            hoursPerWeek,
            workDays,
            startTime,
            endTime,
            requestedBy
        ]);

        return { success: true, message: "OK" };

    } catch (err) {
        console.error("Booking insert error:", err);
        return { success: false, message: "Database error while inserting booking." };
    }
}

module.exports = { makeBooking };
