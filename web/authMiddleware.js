function requireLogin(req, res, next) {
    // No session or no user → redirect to login
    if (!req.session || !req.session.user) {
        return res.redirect("/login");
    }

    const now = Date.now();
    const maxInactivity = 30 * 60 * 1000; // 30 minutes

    // Check inactivity timeout
    if (req.session.user.lastActivity && now - req.session.user.lastActivity > maxInactivity) {
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
