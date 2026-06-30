function requireLogin(req, res, next) {
    const debugAuth = process.env.DEBUG_AUTH === "true";

    // No session or no user → redirect to login
    if (!req.session || !req.session.user) {
        if (debugAuth) {
            console.log("[AUTH DEBUG] requireLogin redirect", {
                path: req.originalUrl,
                sessionID: req.sessionID,
                hasSession: Boolean(req.session),
                hasUser: Boolean(req.session && req.session.user),
                hasCookieHeader: Boolean(req.headers.cookie)
            });
        }
        return res.redirect("/login");
    }

    const now = Date.now();
    const maxInactivity = 30 * 60 * 1000; // 30 minutes

    // Check inactivity timeout
    if (req.session.user.lastActivity && now - req.session.user.lastActivity > maxInactivity) {
        if (debugAuth) {
            console.log("[AUTH DEBUG] session expired by inactivity", {
                path: req.originalUrl,
                sessionID: req.sessionID,
                lastActivity: req.session.user.lastActivity,
                now
            });
        }
        req.session.destroy(() => {
            return res.redirect("/login");
        });
        return;
    }

    // Update last activity timestamp
    req.session.user.lastActivity = now;

    next();
}

module.exports = { requireLogin };
